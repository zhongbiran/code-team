#!/usr/bin/env node
// Code Team 的 Codex 调用封装。
// 存在的理由：本机 WebSocket 到 ChatGPT 不通，裸跑 codex exec 会先空转 5 次重连
// （约 120 秒）才降级 HTTPS。这里用自定义 provider 直接走 HTTPS，并统一模型/档位/只读沙箱。
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { recordEvent, readEvents } from "./record-event.mjs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "team.json");
const EVENTS_FILE = join(ROOT, "config", "events.jsonl");
const EVENTS_LEDGER = process.env.CODE_TEAM_EVENTS_LEDGER
  ? resolve(process.env.CODE_TEAM_EVENTS_LEDGER)
  : EVENTS_FILE;
// 额度账本。测试与替身运行用环境变量改位置，否则替身响应会污染真实账本。
const LEDGER = process.env.CODE_TEAM_USAGE_LEDGER
  ? resolve(process.env.CODE_TEAM_USAGE_LEDGER)
  : join(ROOT, "config", "usage-ledger.json");
// 按角色分 schema：briefs[] 是 Overmind 的产物，Coder 不该被迫输出它。
const SCHEMA = join(ROOT, "config", "plan-schema.json");
const CODER_SCHEMA = join(ROOT, "config", "coder-schema.json");
// brief 产物根目录：默认落在宿主给的可写数据目录（发布端与宿主读取端共用同一个根）。
// 宿主把 hook 放进独立只读快照跑，快照路径 ≠ 插件真实路径 —— 插件内 artifacts/ 两端不是同一个目录，
// 引用必然读不出来。宿主只给 hook 进程注入 PLUGIN_DATA，CLI 进程没有，所以 CLI 端按同一布局推导。
const ARTIFACTS_DIR = join(ROOT, "artifacts");
const ARTIFACT_ROOT_ENV = "CODE_TEAM_ARTIFACT_ROOT";
const PLUGIN_DATA_ENV = "PLUGIN_DATA";

const ROLES = ["overmind", "coder"];

// 定位 codex 的 JS 入口（node_modules/@openai/codex/bin/codex.js）。
// 优先从 PATH 上的 codex.cmd 反推，找不到就退回默认的全局安装路径。
function resolveCodexEntry() {
  const candidates = [];
  const npmRoot = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
    : null;
  if (npmRoot) candidates.push(npmRoot);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  console.error("找不到 codex 可执行入口（预期 node_modules/@openai/codex/bin/codex.js）");
  process.exit(2);
}

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG, "utf8"));
}

// 用自定义 provider 覆盖内置 openai（内置 provider 不允许被覆盖，只能另起一个 id）。
// supports_websockets=false 是关键：它让 codex 跳过 WebSocket 直连，不再空转 120 秒。
function providerArgs(cfg) {
  const p = cfg.provider;
  return [
    "-c", `model_provider="${p.id}"`,
    "-c", `model_providers.${p.id}.name="${p.name}"`,
    "-c", `model_providers.${p.id}.base_url="${p.base_url}"`,
    "-c", `model_providers.${p.id}.wire_api="${p.wire_api}"`,
    "-c", `model_providers.${p.id}.requires_openai_auth=true`,
    "-c", `model_providers.${p.id}.supports_websockets=false`,
  ];
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readLedger() {
  if (!existsSync(LEDGER)) return { calls: [] };
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch {
    return { calls: [] };
  }
}

function appendUsage(entry) {
  const ledger = readLedger();
  ledger.calls.push(entry);
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

// 预算从事件流算——它是唯一真相源。
// 旧版另有一份 usage-ledger.json，两份账本迟早会打架。
function showBudget() {
  const now = Date.now();
  const windowMs = 5 * 60 * 60 * 1000;
  const all = readEvents().filter((e) => e.kind === "codex-call" || e.kind === "call");
  const recent = all.filter((e) => now - new Date(e.at).getTime() < windowMs);
  const today = all.filter((e) => {
    const d = new Date(e.at);
    return d.getUTCFullYear() === new Date(now).getUTCFullYear() &&
      d.getUTCMonth() === new Date(now).getUTCMonth() &&
      d.getUTCDate() === new Date(now).getUTCDate();
  });

  const stat = (list, title) => {
    const sum = (k) => list.reduce((n, e) => n + (e.usage?.[k] ?? 0), 0);
    const elapsed = list.reduce((n, e) => n + (e.elapsedSec ?? 0), 0);
    console.log(title);
    console.log("  调用次数: " + list.length);
    console.log("  input tokens: " + sum("input_tokens"));
    console.log("  cached tokens: " + sum("cached_input_tokens"));
    console.log("  output tokens: " + sum("output_tokens"));
    console.log("  reasoning tokens: " + sum("reasoning_output_tokens"));
    console.log("  总耗时: " + elapsed.toFixed(1) + "s");
    if (list.length) {
      const byRole = {};
      for (const c of list) byRole[c.role ?? "(未记录)"] = (byRole[c.role ?? "(未记录)"] ?? 0) + 1;
      console.log("  按角色: " + JSON.stringify(byRole));
    }
    console.log("");
  };

  stat(recent, "最近 5 小时窗口（额度约束看这个）");
  stat(today, "今天累计（UTC 日）");
  console.log("  事件流: " + EVENTS_FILE);
}

// Overmind 的输出契约：它必须产出决策、拆包和每个包的 brief —— 主会话不参与这些判断。
// 主会话只负责：把需求原样转交、拿到结果、按拆包派工、转发用户的追加问题。
const OVERMIND_CONTRACT = [
  "",
  "除了回答问题，你必须额外产出以下结构化内容：",
  "",
  "## 决策记录",
  "你在这次规划里替人做的每一个决定，逐条列出：决定、理由、放弃了哪些方案、代价是什么。",
  "",
  "## 拆包",
  "按\"文件归属不重叠\"拆成可并行的包，每包一个明确交付物。",
  "",
  "## 每个包的 brief",
  "每个包按下面格式给出 brief。这份 brief 会原样发给执行者，不要省略字段：",
  "",
  "    Stakes: low | high",
  "    Hypothesis: <你对这个包的预判>",
  "    Goal / users / out of scope: ...",
  "    Done = (tangible check): <一条能跑的命令 + 期望输出>",
  "    Mode: think with me | do it for me",
  "    When done: show commands run and their output first, then the summary,",
  "    then the decisions and assumptions you made.",
  "",
  "注意 Done 栏只给\"一条命令 + 期望输出\"，不要穷举该测什么——测什么由执行者判断。",
  "",
  "## 每个包的 brief 正文（结构化 briefs 数组）",
  "除了上面的叙述，还要在结构化输出的 briefs 数组里，给每个包一条：",
  "  { \"packageId\": \"<包标识，如 pkg-a>\", \"body\": \"<该包 brief 原文>\" }",
  "body 必须是 brief 的逐字原文（含换行、代码块、中文），一字不改、不加解释、不重排换行。",
  "packageId 用包的稳定短标识，主会话靠它把引用对到包上。",
  "",
  "## 预期包集合（结构化 packages 数组）",
  "在结构化输出的 packages 数组里，给出这一批的全部包标识（每个包一个字符串，如 \"pkg-a\"）。",
  "packages 必须与 briefs 一一对应：少一个、多一个，这整批都不会发布，主会话拿不到可派工的引用。",
  "",
  "## 需要 Coder 的部分",
  "如果要动代码方向（接口设计、实现取舍、核心问题定位），在这里指明哪几包需要 Coder 介入。",
  ""
].join("\n");


// ---------- brief 产物：落盘、引用、核对 ----------
// 为什么要落盘：主会话只转交「产物引用」，不再复制正文；
// Worker 实收的正文就是落盘的那份字节，sha256 可逐字节核对。
// 写盘由外层封装做，规划模型仍是只读沙箱。

// 插件名（宿主按它建可写数据目录）：.minimax-plugin/plugin.json 的 name
function readPluginName() {
  const manifest = readJsonFile(join(ROOT, ".minimax-plugin", "plugin.json"));
  const name = manifest && typeof manifest.name === "string" ? manifest.name.trim() : "";
  return name ? name.normalize("NFKC").toLowerCase() : "plugin";
}

// 宿主把本地插件装在 <dataDir>/plugins/<name>，给它的可写数据目录是 <dataDir>/v2/plugin-data/hooks/<name>。
// 目录对不上就返回 null：宁可退回插件内 artifacts/，也不猜一个错的根。
function hostPluginDataDir() {
  if (basename(dirname(ROOT)) !== "plugins") return null;
  const dataDir = resolve(ROOT, "..", "..");
  if (!existsSync(join(dataDir, "v2"))) return null;
  return join(dataDir, "v2", "plugin-data", "hooks", readPluginName());
}

/**
 * brief 产物根目录（发布端与宿主读取端必须解析到同一个根）。
 * 优先级：显式参数 > CODE_TEAM_ARTIFACT_ROOT > 宿主注入的 PLUGIN_DATA > 推导出的宿主数据目录 > 插件内 artifacts/。
 * 返回绝对路径字符串。
 */
export function resolveArtifactRoot({ explicit } = {}) {
  const explicitRoot = String(explicit ?? "").trim();
  if (explicitRoot) return resolve(explicitRoot);
  const override = String(process.env[ARTIFACT_ROOT_ENV] || "").trim();
  if (override) return resolve(override);
  const pluginData = String(process.env[PLUGIN_DATA_ENV] || "").trim();
  if (pluginData) return join(resolve(pluginData), "artifacts");
  const hostData = hostPluginDataDir();
  if (hostData) return join(hostData, "artifacts");
  return ARTIFACTS_DIR;
}

// 文件名安全化：包标识可能带路径分隔符或中文，只留安全字符并附短哈希防撞名
function safeSegment(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48) || "pkg";
}

function readJsonFile(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * OpenAI 结构化输出（strict）的硬规则：
 *  1) 每个 object 节点必须显式带 additionalProperties:false；
 *  2) 每个 object 的 properties 里每个 key 都必须出现在该 object 的 required 里；
 *  3) required 里不能有 properties 里没有的 key。
 * 踩这条不是「校验不过」，是 API 直接拒绝整个请求（invalid_json_schema）。
 * 嵌套层级同样成立，所以递归检查。
 */
export function assertOpenAiStrictSchema(schema, path = "$") {
  const errors = [];
  const walk = (node, p) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object" || node.properties) {
      const props = node.properties || {};
      const required = node.required || [];
      if (node.additionalProperties !== false) {
        errors.push(p + " 缺 additionalProperties:false（strict 要求 object 节点禁止额外字段）");
      }
      for (const key of Object.keys(props)) {
        if (!required.includes(key)) errors.push(p + ".properties." + key + " 不在 required 里");
      }
      for (const key of required) {
        if (!(key in props)) errors.push(p + ".required 里的 " + key + " 在 properties 里不存在");
      }
    }
    if (node.items) walk(node.items, p + "[]");
    for (const [k, v] of Object.entries(node.properties || {})) walk(v, p + "." + k);
  };
  walk(schema, path);
  if (errors.length) {
    throw new Error("schema 不满足 OpenAI strict 规则：\n  - " + errors.join("\n  - "));
  }
  return true;
}

// 加载并校验 schema：非法就在本地报错，不浪费一次 API 调用。
function loadSchema(path) {
  const schema = readJsonFile(path);
  if (!schema) throw new Error("读不到 schema: " + path);
  assertOpenAiStrictSchema(schema, path);
  return schema;
}

// plan-schema.json 是形状的唯一来源；这里只实现它用到的子集
// （type / required / properties / items / additionalProperties:false）。
function validateAgainstSchema(schema, value, path, errors) {
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(path + " 应为对象");
      return;
    }
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(path + " 缺字段 " + key);
    }
    for (const [key, sub] of Object.entries(value)) {
      const prop = (schema.properties || {})[key];
      if (!prop) {
        if (schema.additionalProperties === false) errors.push(path + " 多余字段 " + key);
        continue;
      }
      validateAgainstSchema(prop, sub, path + "." + key, errors);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(path + " 应为数组");
      return;
    }
    if (schema.items) {
      value.forEach((v, i) => validateAgainstSchema(schema.items, v, path + "[" + i + "]", errors));
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") errors.push(path + " 应为字符串");
  }
}

function validatePlanResult(result) {
  let schema;
  try {
    schema = loadSchema(SCHEMA);
  } catch (err) {
    return { ok: false, errors: [err && err.message ? err.message : String(err)] };
  }
  const errors = [];
  validateAgainstSchema(schema, result, "$", errors);
  return { ok: errors.length === 0, errors };
}

// 取 brief 批次；任何一份不完整或包标识重复 → 整批不发布
// 整批约束：计划给出的预期包集合（result.packages）与实际 briefs 必须完全一致。
// 少一包、多一包、预期集合里有重复 → 整批不发布（fail-closed）。
// packages 缺失或为空 → 没有可比对的预期集合 → 同样整批不发布（fail-closed，不留库模式口子）。
function collectBriefs(result) {
  const expected = result && Array.isArray(result.packages) ? result.packages : null;
  if (!expected) throw new Error("预期包集合（packages）缺失");
  if (!expected.length) throw new Error("预期包集合（packages）是空的");
  const briefs = Array.isArray(result.briefs) ? result.briefs : [];
  if (!briefs.length) throw new Error("响应里没有 briefs");
  const seen = new Set();
  for (const b of briefs) {
    if (!b || typeof b.packageId !== "string" || !b.packageId.trim()) throw new Error("brief 缺 packageId");
    if (typeof b.body !== "string" || !b.body.trim()) throw new Error("brief " + b.packageId + " 缺正文");
    if (seen.has(b.packageId)) throw new Error("brief packageId 重复：" + b.packageId);
    seen.add(b.packageId);
  }
  const expectedSet = new Set();
  for (const id of expected) {
    if (typeof id !== "string" || !id.trim()) throw new Error("预期包集合里有空包标识");
    if (expectedSet.has(id)) throw new Error("预期包集合里包标识重复：" + id);
    expectedSet.add(id);
  }
  for (const id of expectedSet) {
    if (!seen.has(id)) throw new Error("缺少包：" + id + "（计划要求这一批包含它）");
  }
  for (const id of seen) {
    if (!expectedSet.has(id)) throw new Error("多出的包：" + id + "（计划里没有这个包）");
  }
  return briefs;
}

function appendEventRow(row) {
  const line = JSON.stringify({
    at: row.at ?? new Date().toISOString(),
    kind: row.kind ?? "call",
    role: row.role ?? null,
    backend: row.backend ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    project: row.project ?? null,
    session: row.session ?? null,
    task: row.task ?? null,
    skill: row.skill ?? null,
    plugin: row.plugin ?? null,
    elapsedSec: row.elapsedSec ?? null,
    usage: row.usage ?? null,
    ok: row.ok ?? true,
    note: row.note ?? null,
    projectKey: row.projectKey ?? null,
    threadId: row.threadId ?? null,
    publishedAtMs: row.publishedAtMs ?? null,
    planRevisionId: row.planRevisionId ?? null,
    refs: row.refs ?? null,
  });
  mkdirSync(dirname(EVENTS_LEDGER), { recursive: true });
  appendFileSync(EVENTS_LEDGER, line + "\n", "utf8");
}

/**
 * 落盘一批 brief，返回可派工的引用。
 * 整批语义：先把正文全部写进暂存目录并写清单，最后一次 rename 到位；
 * 中途失败 → 清掉暂存目录，不产出任何可派工引用。
 */
export function publishOvermindBriefs({ planRevisionId, projectKey, threadId, result, artifactRoot: root } = {}) {
  if (!planRevisionId) throw new Error("缺少 planRevisionId");
  const briefs = collectBriefs(result);
  const rootDir = resolveArtifactRoot({ explicit: root });
  const revDir = join(rootDir, "briefs", safeSegment(planRevisionId));
  const stage = join(rootDir, "briefs", ".staging-" + safeSegment(planRevisionId) + "-" + randomBytes(4).toString("hex"));
  mkdirSync(stage, { recursive: true });
  const refs = [];
  let manifest = null;
  try {
    for (const b of briefs) {
      const bytes = Buffer.from(b.body, "utf8");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const artifactId = safeSegment(b.packageId) + "-" + sha256.slice(0, 8) + ".md";
      writeFileSync(join(stage, artifactId), bytes);
      refs.push({ planRevisionId, packageId: b.packageId, artifactId, sha256, byteLength: bytes.length });
    }
    manifest = {
      planRevisionId,
      projectKey: projectKey ?? null,
      threadId: threadId ?? null,
      publishedAtMs: Date.now(),
      refs,
    };
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    rmSync(revDir, { recursive: true, force: true });
    renameSync(stage, revDir);
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
  // 同一线程的旧版本作废：resume 之后旧稿不可再派工（防误投旧稿）
  if (threadId) supersedeOlderRevisions(rootDir, threadId, planRevisionId, projectKey);
  appendEventRow({
    kind: "brief.published",
    role: "overmind",
    backend: "codex-cli",
    project: projectKey ?? null,
    session: threadId ?? null,
    skill: "code-team",
    plugin: "code-team",
    ok: true,
    projectKey: projectKey ?? null,
    threadId: threadId ?? null,
    publishedAtMs: manifest.publishedAtMs,
    planRevisionId,
    refs,
  });
  return refs;
}

// 把同一线程（且同一项目）的旧版本标记作废
function supersedeOlderRevisions(rootDir, threadId, planRevisionId, projectKey) {
  const briefsDir = join(rootDir, "briefs");
  let names = [];
  try {
    names = readdirSync(briefsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = join(briefsDir, name);
    const old = readJsonFile(join(dir, "manifest.json"));
    if (!old || old.planRevisionId === planRevisionId) continue;
    if (old.threadId !== threadId) continue;
    if ((old.projectKey ?? null) !== (projectKey ?? null)) continue;
    writeFileSync(join(dir, "supersededBy.json"), JSON.stringify({ planRevisionId }) + "\n", "utf8");
  }
}

/**
 * 按引用取回正文并核对。
 * 校验：版本 / 包标识 / 清单登记 / 文件存在 / sha256 / 字节数。
 * 任何一项不符 → ok:false（不返回正文）。
 */
export function readVerifiedBrief(ref, ctx = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!ref || typeof ref !== "object") return fail("引用格式不对");
  const { planRevisionId, packageId, artifactId, sha256 } = ref;
  if (!planRevisionId || !packageId || !artifactId || !sha256) return fail("引用字段缺失");
  if (ctx.planRevisionId && ctx.planRevisionId !== planRevisionId) return fail("引用属于另一个计划版本");
  if (ctx.packageId && ctx.packageId !== packageId) return fail("引用属于另一个包");
  // 根目录在 ref 校验之后才解析：畸形引用不碰文件系统，也不会抛。
  const rootDir = resolveArtifactRoot({ explicit: ctx.artifactRoot });
  const revDir = join(rootDir, "briefs", safeSegment(planRevisionId));
  const superseded = readJsonFile(join(revDir, "supersededBy.json"));
  if (superseded) return fail("该计划版本已被新版本取代（" + superseded.planRevisionId + "）");
  const manifest = readJsonFile(join(revDir, "manifest.json"));
  if (!manifest) return fail("产物清单缺失（该批次未完整发布）");
  if (manifest.planRevisionId !== planRevisionId) return fail("清单与引用的计划版本不一致");
  const entry = (manifest.refs || []).find(
    (r) => r.packageId === packageId && r.artifactId === artifactId && r.sha256 === sha256,
  );
  if (!entry) return fail("清单里没有这个包");
  const file = join(revDir, basename(artifactId));
  if (!existsSync(file)) return fail("产物文件不存在");
  // 读不出来也要返回 ok:false，不能抛：宿主 hook 里抛异常 = 闸门放行（fail-open）。
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    return fail("产物文件读不了：" + (err && err.message ? err.message : String(err)));
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) return fail("产物内容与 sha256 不符");
  if (ref.byteLength !== undefined && Number(ref.byteLength) !== bytes.length) return fail("产物长度不符");
  return {
    ok: true,
    // projectKey 只回报不拦截：发布方给的是项目名，宿主按 cwd 算的是路径，不同源，硬比会误杀。
    // 正文一致性由 sha256 保证；版本与包的一致性由上面的清单核对保证。
    text: bytes.toString("utf8"),
    sha256: actual,
    byteLength: bytes.length,
    planRevisionId,
    packageId,
    artifactId,
    projectKey: manifest.projectKey ?? null,
    threadId: manifest.threadId ?? null,
    publishedAtMs: manifest.publishedAtMs ?? null,
  };
}

/**
 * 查某计划版本已发布的包标识（派工方按这个集合取正文）。
 * 返回包标识数组；该版本没发布 / 已被新版本作废 / 清单读不出来 → 空数组（fail-closed）。
 */
export function listPublishedPackages({ planRevisionId, artifactRoot: root } = {}) {
  if (!planRevisionId) return [];
  const revDir = join(resolveArtifactRoot({ explicit: root }), "briefs", safeSegment(planRevisionId));
  if (existsSync(join(revDir, "supersededBy.json"))) return [];
  const manifest = readJsonFile(join(revDir, "manifest.json"));
  if (!manifest || manifest.planRevisionId !== planRevisionId) return [];
  return (manifest.refs || [])
    .map((r) => r && r.packageId)
    .filter((id) => typeof id === "string" && id);
}

/**
 * 派工标记：主会话只把这串引用交给 Worker，正文由宿主按引用取回并核对。
 * 字段与 BriefRef 一致；宿主 hook 按 "code-team-brief-ref:" 前缀取后面的 JSON 对象。
 */
export function formatBriefRef(ref) {
  return "code-team-brief-ref: " + JSON.stringify({
    planRevisionId: ref.planRevisionId,
    packageId: ref.packageId,
    artifactId: ref.artifactId,
    sha256: ref.sha256,
    byteLength: ref.byteLength,
  });
}

// 计划版本号：同一线程每次发布都涨一格（resume 必然是新版本，不会误投旧稿）
function nextRevisionId(rootDir, threadId) {
  const key = safeSegment(threadId || "no-thread");
  const file = join(rootDir, ".revisions", key + ".json");
  const cur = readJsonFile(file);
  const n = (cur && Number(cur.n) || 0) + 1;
  return {
    id: key + "-r" + n,
    commit() {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ n }) + "\n", "utf8");
    },
  };
}

function runPlan(args) {
  const role = args.role;
  if (!ROLES.includes(role)) {
    console.error("--role 必须是 " + ROLES.join(" 或 "));
    process.exit(2);
  }
  if (!args["prompt-file"]) {
    console.error("缺少 --prompt-file <需求文件>");
    process.exit(2);
  }
  const promptPath = resolve(String(args["prompt-file"]));
  if (!existsSync(promptPath)) {
    console.error("需求文件不存在: " + promptPath);
    process.exit(2);
  }

  const cfg = loadConfig();
  // team.json 的角色配置在 roles.* 下（provider/alerts 仍在顶层）；兼容旧的扁平写法。
  const roleCfg = cfg.roles?.[role] ?? cfg[role];
  if (!roleCfg) {
    console.error("team.json 里没有角色配置: " + role);
    process.exit(2);
  }
  const model = args.model ?? roleCfg.model;
  const effort = args.effort ?? roleCfg.effort;
  let prompt = readFileSync(promptPath, "utf8");
  // 契约是流程骨架（决策/拆包/brief/是否要 Coder），不受 --plain 影响。
  // --plain 只控制"要不要结构化 JSON 输出"，不控制"要不要给下游用的骨架"。
  if (role === "overmind") prompt = prompt + "\n" + OVERMIND_CONTRACT;

  // codex 的全局选项必须排在子命令之前，exec 的选项排在其后。
  const globalArgs = [...providerArgs(cfg), "-m", model, "-c", `model_reasoning_effort="${effort}"`];
  // exec 与 exec resume 的选项集不同：
  // resume 不接受 --sandbox / -C（沿用原线程设置），但接受 --skip-git-repo-check / --output-schema。
  const execArgs = ["--skip-git-repo-check", "--json"];
  if (!args.resume) {
    execArgs.unshift("--sandbox", "read-only");
    if (args.cwd) execArgs.push("-C", String(args.cwd));
  }
  // 按 role 选 schema：Coder 不该被迫输出 Overmind 的 briefs[]。
  // 加载时就校验 strict 规则 —— 非法 schema 不发给 API（API 会直接拒绝整个请求）。
  if (!args.plain) {
    const schemaPath = role === "coder" ? CODER_SCHEMA : SCHEMA;
    // schema 文件缺失 ⇒ 结构性输出没有形状约束，响应无法校验 ⇒ 发起调用前就中止（fail-closed）。
    if (!existsSync(schemaPath)) {
      console.error("schema 文件不存在，已中止（不发起调用）：" + schemaPath);
      process.exit(2);
    }
    try {
      loadSchema(schemaPath);
    } catch (err) {
      console.error("schema 不合法，已中止（不发起调用）：" + (err && err.message ? err.message : String(err)));
      process.exit(2);
    }
    execArgs.push("--output-schema", schemaPath);
  }

  const cmd = [];
  if (args.resume) cmd.push("exec", "resume", ...globalArgs, ...execArgs, String(args.resume));
  else cmd.push("exec", ...globalArgs, ...execArgs);

  const started = Date.now();
  // 直接跑 codex 的 JS 入口，不经 shell：避开 Windows .cmd 包装，也就没有 shell 注入面和弃用警告。
  const codexJs = resolveCodexEntry();
  const res = spawnSync(process.execPath, [codexJs, ...cmd], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  let usage = null;
  let threadId = null;
  let lastMessage = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === "thread.started") threadId = evt.thread_id;
    if (evt.type === "turn.completed") usage = evt.usage;
    if (evt.type === "item.completed" && evt.item?.type === "agent_message") lastMessage = evt.item.text;
  }

  if (res.error) {
    console.error("codex 调用失败: " + res.error.message);
    process.exit(1);
  }
  const event = {
    at: new Date().toISOString(),
    kind: "codex-call",
    role,
    backend: "codex-cli",
    model,
    effort,
    project: args.project ?? null,
    session: args.session ?? threadId ?? null,
    task: args.task ?? null,
    skill: args.skill ?? "code-team",
    plugin: args.plugin ?? "code-team",
    elapsedSec: Number(elapsed),
    usage,
    ok: res.status === 0,
    note: threadId ? "thread:" + threadId : null,
  };
  if (usage) appendUsage({ at: event.at, role, model, effort, elapsedSec: event.elapsedSec, threadId, usage });
  // 通用事件流：后端无关，换后端统计不用改。
  recordEvent(event);

  console.log(lastMessage || stdout || "(无输出)");
  console.error("\n--- codex 调用元信息 ---");
  console.error("role=" + role + " model=" + model + " effort=" + effort + " elapsed=" + elapsed + "s");
  if (threadId) console.error("thread_id=" + threadId);
  if (usage) console.error("usage=" + JSON.stringify(usage));
  if (res.status !== 0) {
    console.error(stderr.slice(0, 2000));
    process.exit(res.status ?? 1);
  }

  // 结构化响应 → 落盘 brief 产物。
  // 只有完整、通过校验的一整批才会发布；失败/半批/重复包一律不产出可派工引用。
  if (!args.plain && role === "overmind") {
    publishBriefsFromResult({ lastMessage, threadId: threadId || args.resume || null, args });
  }
}

// 发布入口：解析 → 校验 → 整批落盘 → 打印引用。
// 失败只报 stderr，不改退出码（plan/resume/--plain/budget 的退出码语义保持不变）。
function publishBriefsFromResult({ lastMessage, threadId, args }) {
  let result = null;
  try {
    result = JSON.parse(lastMessage);
  } catch {
    console.error("brief 产物未发布：响应不是 JSON");
    return;
  }
  const check = validatePlanResult(result);
  if (!check.ok) {
    console.error("brief 产物未发布：未通过 schema 校验（" + check.errors.join("；") + "）");
    return;
  }
  // 不依赖模型自觉：缺 briefs 补成空数组（strict 已保证键在，但内容可能是空）。
  // 补出来是空数组 → 没有可派工的包 → 不发布（fail-closed）。
  if (!Array.isArray(result.briefs)) result.briefs = [];
  if (!result.briefs.length) {
    console.error("brief 产物未发布：响应里没有 briefs");
    return;
  }
  const root = resolveArtifactRoot();
  const rev = nextRevisionId(root, threadId);
  let refs = [];
  try {
    refs = publishOvermindBriefs({
      planRevisionId: rev.id,
      projectKey: args.project ?? null,
      threadId,
      result,
      artifactRoot: root,
    });
  } catch (err) {
    console.error("brief 产物未发布：" + (err && err.message ? err.message : String(err)));
    return;
  }
  rev.commit();
  console.error("brief_plan_revision=" + rev.id);
  console.error("brief_refs=" + JSON.stringify(refs));
}

// 只有直接运行时才执行 CLI；被 import 时只提供函数（宿主 hook 要用 readVerifiedBrief）。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === "budget") {
    showBudget();
  } else if (cmd === "plan") {
    runPlan(args);
  } else {
    console.log("用法:");
    console.log("  codex-team.mjs plan --prompt-file <file> --role overmind|coder [--effort medium|high] [--model <slug>] [--resume <thread_id>] [--cwd <dir>] [--plain] [--project <名称>] [--task <名称>] [--skill <名称>] [--plugin <名称>]");
    console.log("  codex-team.mjs budget");
    process.exit(cmd ? 2 : 0);
  }
}
