#!/usr/bin/env node
// 生成一次内置派工的参数：{ invocationId, role, backend, agent, model, effort } + 派工附件。
//
// 用法：node scripts/dispatch-params.mjs <role> [--direction <id>] [--visible-file <json>]
//      node scripts/dispatch-params.mjs --capabilities
//
// 为什么有这段脚本：已保存的 model/effort 必须真的进入派工参数，
// 不能只显示在页面上（红灯症状之一）。
//
// 能力取证（只读本机文件，不发请求、不猜）：
//   1. <dataDir>/config.yaml —— 宿主自己的运行时配置：哪些 provider/model 真的装着，
//      哪些 effort 档位被支持。私有自定义 provider 只在这里有。
//   2. <dataDir>/agents/.builtin/<role>/agent.md —— 宿主对该角色实际使用的 model/effort。
//   3. <dataDir>/cache/models-dev-catalog.json —— 宿主自己的模型目录快照，
//      证明 <provider>/<model> 存在并给出该模型的 effort 档位。
// 取不到证据的已保存值不伪造"已生效"：派工参数里置空，原值保留在 requested 里，
// status 报 CAPABILITY_UNKNOWN。
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { teamConfig, resolveDirection, parseVisibleList, buildSpecialty } from "./skills-for.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.USERPROFILE || process.env.HOME || "";

// 宿主数据目录：宿主自己的优先级是环境变量 -> 显式参数 -> ~/.minimax（旧的 ~/.mavis）。
// 但数据目录整个搬走过（用户级环境变量未必被每个进程继承），所以最后一步按证据找：
// 宿主数据目录里一定有 config.yaml —— 从插件目录往上找，找到带 config.yaml 的那层。
export function resolveDataDir(explicit) {
  const explicitList = [
    explicit,
    process.env.MINIMAX_DATA_DIR,
    process.env.MAVIS_DATA_DIR,
  ].filter(Boolean);
  // 显式指定的数据目录就认它，不回退去别处找：用户说数据在这儿，就该只看这儿。
  // 目录里没有宿主证据（config.yaml / agents/）时，报"证不出来"，
  // 而不是悄悄换成另一台机器的目录。
  for (const dir of explicitList) {
    if (existsSync(dir)) return dir;
  }
  const ancestors = [];
  let dir = ROOT;
  for (let i = 0; i < 4; i++) {
    ancestors.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const candidates = [...ancestors, join(HOME, ".minimax"), join(HOME, ".mavis")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "config.yaml"))) return candidate;
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "agents"))) return candidate;
  }
  return candidates[0] ?? join(HOME, ".minimax");
}

const DATA_DIR = resolveDataDir(process.argv.includes("--data-dir") ? process.argv[process.argv.indexOf("--data-dir") + 1] : null);
const AGENTS_DIR = join(DATA_DIR, "agents");
const RUNTIME_CONFIG = join(DATA_DIR, "config.yaml");
const CATALOG_FILE = join(DATA_DIR, "cache", "models-dev-catalog.json");
// 宿主给私有自定义 provider 的 id 带的前缀（配置里是 custom_provider.<id>）。
const CUSTOM_PROVIDER_PREFIX = "custom_provider" + ":";

// ── 读宿主运行时配置（config.yaml 的最小子集：嵌套映射 + 短横线列表） ──
// 不引 YAML 依赖：只解析本文件用得到的形状，解析不了的字段直接忽略。
function parseYamlSubset(text) {
  const makeNode = () => ({ map: {}, list: null });
  const root = makeNode();
  const stack = [{ indent: -1, node: root }];
  const scalar = (raw) => {
    const v = raw.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
  };
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (trimmed.startsWith("- ")) {
      while (stack.length > 1 && stack[stack.length -1].indent >= indent) stack.pop();
      const owner = stack[stack.length - 1];
      owner.node.list = owner.node.list ?? [];
      owner.node.list.push(scalar(trimmed.slice(2)));
      continue;
    }
    const m = trimmed.match(/^([^:]+):(.*)$/);
    if (!m) continue;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const rest = m[2].trim();
    if (rest === "") {
      const child = makeNode();
      parent.map[m[1].trim()] = child;
      stack.push({ indent, node: child });
    } else {
      parent.map[m[1].trim()] = scalar(rest);
    }
  }
  const materialize = (node) => {
    if (node.list) return node.list.map((v) => (v && typeof v === "object" ? materialize(v) : v));
    const out = {};
    for (const [k, v] of Object.entries(node.map)) out[k] = v && typeof v === "object" ? materialize(v) : v;
    return out;
  };
  return materialize(root);
}

/** 宿主运行时配置里的模型与 effort 域。 */
export function readRuntimeEvidence() {
  const models = new Set();
  const effortOptions = new Map();
  if (!existsSync(RUNTIME_CONFIG)) return { models, effortOptions };
  let cfg;
  try {
    cfg = parseYamlSubset(readFileSync(RUNTIME_CONFIG, "utf8"));
  } catch {
    return { models, effortOptions };
  }
  // 宿主侧的 provider id：配置里 provider.<id> 就是 <id>；
  // custom_provider.<id> 在宿主那边带 custom_provider: 前缀。
  const collect = (prefix, providerKey) => {
    const provider = cfg?.[prefix]?.[providerKey];
    if (!provider) return;
    const prefixPart = prefix === "custom_provider" ? CUSTOM_PROVIDER_PREFIX : "";
    const keyOf = (mid) => prefixPart + providerKey + "/" + mid;
    for (const mid of Object.keys(provider.models ?? {})) {
      const key = keyOf(mid);
      models.add(key);
      const thinking = provider.models[mid]?.thinking;
      const options = Array.isArray(thinking?.effortOptions) ? thinking.effortOptions : null;
      if (options) effortOptions.set(key, options);
      else if (provider.models[mid]?.thinking_config?.mode === "switchable") effortOptions.set(key, ["on", "off"]);
    }
    const whitelist = provider.whitelist;
    if (Array.isArray(whitelist)) {
      for (const mid of whitelist) {
        const key = keyOf(mid);
        models.add(key);
        if (!effortOptions.has(key)) effortOptions.set(key, []);
      }
    }
  };
  for (const pid of Object.keys(cfg?.provider ?? {})) collect("provider", pid);
  for (const pid of Object.keys(cfg?.custom_provider ?? {})) collect("custom_provider", pid);
  return { models, effortOptions };
}

/** 读 agent 定义 frontmatter 里的 model / effort。 */
export function readAgentDefinition(role) {
  for (const file of [join(AGENTS_DIR, role, "agent.md"), join(AGENTS_DIR, ".builtin", role, "agent.md")]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const end = text.indexOf("---", 3);
    const front = text.slice(0, end === -1 ? text.length : end);
    const def = {};
    for (const key of ["model", "effort"]) {
      const m = front.match(new RegExp("^" + key + ":\\s*(.+)$", "m"));
      if (m) def[key] = m[1].trim().replace(/^["']|["']$/g, "");
    }
    if (def.model) return def;
  }
  return null;
}

let catalogCache;
function loadCatalog() {
  if (catalogCache !== undefined) return catalogCache;
  catalogCache = null;
  if (!existsSync(CATALOG_FILE)) return catalogCache;
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_FILE, "utf8"));
    catalogCache = parsed?.catalog ?? null;
  } catch {
    catalogCache = null;
  }
  return catalogCache;
}

/** 在本地目录快照里找 <provider>/<model>；custom_provider: 前缀在快照里是去前缀的键。 */
function findCatalogModel(modelKey) {
  const slash = modelKey.indexOf("/");
  if (slash <= 0 || slash === modelKey.length - 1) return null;
  const providerId = modelKey.slice(0, slash);
  const modelId = modelKey.slice(slash + 1);
  const catalog = loadCatalog();
  if (!catalog) return null;
  const bare = providerId.startsWith(CUSTOM_PROVIDER_PREFIX)
    ? providerId.slice(CUSTOM_PROVIDER_PREFIX.length)
    : providerId;
  const provider = catalog[providerId] ?? catalog[bare];
  const entry = provider?.models?.[modelId];
  return entry ? { providerId, modelId, entry } : null;
}

/**
 * 该模型支持哪些 effort 档位。
 * 运行时配置优先；目录快照里的 type=effort 给档位表，type=toggle 是二元开关
 * （宿主 Task 工具说明里明确写了 MiniMax M3 只认 on/off）。
 */
function effortDomain(modelKey) {
  const runtime = readRuntimeEvidence();
  if (runtime.effortOptions.has(modelKey)) {
    const fromRuntime = runtime.effortOptions.get(modelKey);
    if (fromRuntime.length) return fromRuntime;
  }
  const found = findCatalogModel(modelKey);
  if (!found) return null;
  const options = Array.isArray(found.entry.reasoning_options) ? found.entry.reasoning_options : [];
  const values = new Set();
  let toggle = false;
  for (const opt of options) {
    if (opt?.type === "effort" && Array.isArray(opt.values)) for (const v of opt.values) values.add(v);
    if (opt?.type === "toggle") toggle = true;
  }
  if (toggle) { values.add("on"); values.add("off"); }
  return values.size ? [...values] : null;
}

/** 这个模型本机装得下吗（能下传给 Task 工具）。 */
function modelExists(modelKey) {
  if (readRuntimeEvidence().models.has(modelKey)) return true;
  return !!findCatalogModel(modelKey);
}

/**
 * 判定已保存的 model/effort 能不能证实下传给宿主。
 * state: "confirmed" | "unknown"（unknown = 取不到证据，不伪造）。
 */
export function resolveCapability(role, model, effort) {
  const agentDef = readAgentDefinition(role);
  const modelKnown = typeof model === "string" && model.length > 0;
  const effortKnown = typeof effort === "string" && effort.length > 0;

  let modelState = "unknown";
  let modelValues = null;
  if (modelKnown) {
    if (agentDef?.model === model || modelExists(model)) {
      modelState = "confirmed";
      modelValues = [model];
    }
  } else {
    modelState = "confirmed";
  }
  // 域与 capabilitiesFor 同源：同一个模型集、同一套档位来源。

  let effortState = "unknown";
  let effortValues = null;
  if (effortKnown) {
    const domain = modelKnown ? effortDomain(model) : null;
    if (agentDef && agentDef.model === model && agentDef.effort === effort) {
      effortState = "confirmed";
      effortValues = domain ?? [effort];
    } else if (domain && domain.includes(effort)) {
      effortState = "confirmed";
      effortValues = domain;
    }
  } else {
    effortState = "confirmed";
  }

  return {
    model: { state: modelState, values: modelValues },
    effort: { state: effortState, values: effortValues },
  };
}

/**
 * 执行角色的 model/effort 能力域（契约 1 的 describe 形状）。
 *
 * 这是能力描述的**单一来源**：board 服务端 import 它做值域校验，
 * `--capabilities` CLI 也调用它，两边不会各说各话。
 *
 * values 是本机证据能证出来的闭集；证不出来就给 null + state:"unknown"，
 * 不猜、不放宽——放宽了 board 就会放行宿主兑现不了的值。
 */
export function capabilitiesFor(role, roleConfig, localContext = {}) {
  const cfg = roleConfig ?? {};
  const agentDef = readAgentDefinition(role);
  const runtime = readRuntimeEvidence();

  const models = new Set(runtime.models);
  if (agentDef?.model) models.add(agentDef.model);
  const efforts = new Set();
  for (const options of runtime.effortOptions.values()) for (const o of options) efforts.add(o);

  // effort 档位依赖具体模型：某个模型只认 on/off，另一个认 low..max。
  // 这里给的是"任一可用模型都支持的档位"闭集；派工时 resolveCapability 会按
  // 实际选中的模型再收紧一次。
  const savedModel = typeof cfg.model === "string" && cfg.model ? cfg.model : null;
  const savedEffort = typeof cfg.effort === "string" && cfg.effort ? cfg.effort : null;
  const modelValues = models.size ? [...models] : null;
  const effortValues = efforts.size ? [...efforts] : null;

  const modelState = modelValues ? "supported" : "unknown";
  const effortState = effortValues ? "supported" : "unknown";

  // default = 当前配置里**确实能下传**的值，用的是派工那条路的同一套判定：
  // effort 只在它所属的 model 下才算数（model=MiniMax-M3 只认 on/off，
  // 配成 high 就下传不了）。所以 default 与实际派工结果天然一致。
  const verdict = resolveCapability(role, savedModel, savedEffort);

  return {
    id: "mcode-agent",
    fields: {
      model: {
        type: "string",
        state: modelState,
        nullable: true,
        required: false,
        default: verdict.model.state === "confirmed" ? savedModel : null,
        values: modelValues,
      },
      effort: {
        type: "string",
        state: effortState,
        nullable: true,
        required: false,
        default: verdict.effort.state === "confirmed" ? savedEffort : null,
        values: effortValues,
      },
    },
    resume: "none",
    output: "text",
  };
}

/**
 * 某个模型支持哪些 effort 档位（证不出返回 null）。
 *
 * capabilitiesFor 的 effort 域是所有模型的并集——board 要校验
 * "model + effort" 这一对时，必须按**选中的那个 model** 收窄，
 * 否则 model=MiniMax-M3 配 effort=high 会被放行，派工时却又下传不了。
 */
export function effortValuesForModel(model) {
  if (typeof model !== "string" || !model) return null;
  return effortDomain(model);
}

/** 所有执行角色的能力域（控制台一次拿全）。 */
export function describeHostCapabilities(config) {
  const roles = {};
  for (const [role, rc] of Object.entries(config?.roles ?? {})) {
    if (rc?.backend !== "mcode-agent") continue;
    roles[role] = {
      backendOptions: ["mcode-agent"],
      backends: {
        "mcode-agent": capabilitiesFor(role, rc),
      },
    };
  }
  return roles;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const role = argv[0];
  if (!role && !argv.includes("--capabilities")) {
    console.error("用法：node scripts/dispatch-params.mjs <role> [--direction <id>] [--visible-file <json>]");
    process.exit(2);
  }

  if (argv.includes("--capabilities")) {
    // 与 board 走同一个 capabilitiesFor，不在这里另算一遍。
    console.log(JSON.stringify({ roles: describeHostCapabilities(teamConfig) }, null, 2));
    process.exit(0);
  }

  const roleCfg = teamConfig.roles?.[role] ?? teamConfig[role];
  if (!roleCfg) {
    console.error('team.json 里没有角色 "' + role + '"');
    process.exit(2);
  }

  const directionIndex = argv.indexOf("--direction");
  const visibleIndex = argv.indexOf("--visible-file");
  const direction = directionIndex === -1 ? null : argv[directionIndex + 1];
  const visibleFile = visibleIndex === -1 ? null : argv[visibleIndex + 1];

  let specialty;
  try {
    const directionConfig = resolveDirection(teamConfig, direction);
    const visibleList = parseVisibleList(visibleFile);
    specialty = buildSpecialty(directionConfig, visibleList);
  } catch (error) {
    console.error(error.path ? error.message : String(error));
    process.exit(1);
  }

  const savedModel = typeof roleCfg.model === "string" && roleCfg.model ? roleCfg.model : null;
  const savedEffort = typeof roleCfg.effort === "string" && roleCfg.effort ? roleCfg.effort : null;
  const isMcode = roleCfg.backend === "mcode-agent";
  const capability = isMcode
    ? resolveCapability(role, savedModel, savedEffort)
    : { model: { state: "confirmed", values: null }, effort: { state: "confirmed", values: null } };

  // 与 agent 自身声明相同的 model 不下传：显式传 model 会覆盖 agent 声明的 x-mavis.contextWindow，
  // 子会话被顶到模型目录里最大的上下文档（实测 512k → 1M，cacheRead 按累积上下文线性放大）。
  // agent 默认已经生效，下传同一个值没有任何收益，只有代价。
  const agentDef = readAgentDefinition(role);
  const sameAsAgentDefault = Boolean(agentDef?.model && savedModel && savedModel === agentDef.model);
  const model = capability.model.state === "confirmed" ? savedModel : null;
  // 真正下传给 Task 的是 dispatchModel：与 agent 自身声明相同的 model 不重复下传 ——
  // agent 默认已经生效，显式下传同一个值只会覆盖 agent 声明的 x-mavis.contextWindow
  //（实测：子会话从 512k 被顶成 1M，cacheRead 按累积上下文线性放大）。
  // 换模型（与 agent 默认不同）时照常下传，控制台改模型依然真的生效。
  const dispatchModel = sameAsAgentDefault ? null : model;
  const effort = capability.effort.state === "confirmed" ? savedEffort : null;
  const notes = [];
  if (sameAsAgentDefault) {
    notes.push("已保存的 model 与 agent 自身声明一致，未下传（显式传同一个 model 会覆盖 agent 声明的上下文窗口，实测 512k → 1M）");
  } else if (capability.model.state !== "confirmed") {
    notes.push("已保存的 model 取不到宿主证据，未下传（原值保留在 requested.model）");
  }
  if (capability.effort.state !== "confirmed") notes.push("已保存的 effort 取不到宿主证据，未下传（原值保留在 requested.effort）");

  const taskArgs = isMcode
    ? {
        agent_name: roleCfg.agent ?? role,
        ...(dispatchModel ? { model: dispatchModel } : {}),
        ...(effort ? { effort } : {}),
      }
    : null;

  console.log(JSON.stringify({
    invocationId: randomUUID(),
    role,
    backend: roleCfg.backend ?? null,
    agent: isMcode ? (roleCfg.agent ?? role) : null,
    model,
    effort,
    requested: { model: savedModel, effort: savedEffort },
    status: notes.length ? "CAPABILITY_UNKNOWN" : "OK",
    capability,
    taskArgs,
    attachment: { specialty },
    notes,
  }, null, 2));
}
