#!/usr/bin/env node
// 检查：任务方向路由 + 内置派工参数。
//
// 覆盖（全部跑在隔离目录里：临时 team.json、临时宿主数据目录、临时脚本副本）：
//   1. 旧入口逐字节不变：输出文本、退出码、忽略无关参数
//   2. 方向附件：可见性过滤、每包最多 2 个专业 skill、不投别的方向
//   3. 未知方向 / 清单格式错误 -> 退出码 1，stderr 给字段路径，stdout 不出部分结果
//   4. 派工参数：已保存的 model/effort 真的进入参数与 Task 参数
//   5. 能力未证实 -> CAPABILITY_UNKNOWN，保留原值，不伪造已生效
//   6. 检查器自身抓得住目标症状（"混入未命中插件"、"model 只显示在页面"）
//
// 用法：node checks/task-routing.mjs
// 可选：CT_SCRIPTS_DIR=<目录> 用别处的脚本副本跑（用来在可控坏现场验证本检查会红）
import { mkdtemp, mkdir, writeFile, copyFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_SRC = process.env.CT_SCRIPTS_DIR || join(ROOT, "scripts");

let failures = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { console.log("  ok   " + name); return true; }
  failures += 1;
  console.log("FAIL   " + name + (detail ? "  ->  " + detail : ""));
  return false;
};

const TEAM_CONFIG = {
  roles: {
    overmind: { label: "Overmind", kind: "decision", backend: "codex-cli", model: "gpt-6.2-astra", effort: "medium", agent: null, skills: ["superpowers:brainstorming"] },
    coder: { label: "Coder", kind: "decision", backend: "codex-cli", model: "gpt-6.2-sol", effort: "medium", agent: null, skills: [] },
    worker: { label: "Worker", kind: "execution", backend: "mcode-agent", model: "minimax/MiniMax-M3.1-Flash", effort: "high", agent: "worker", skills: ["superpowers:test-driven-development", "superpowers:verification-before-completion"] },
    explore: { label: "Explore", kind: "execution", backend: "mcode-agent", model: "custom_provider:opencode-go/iceman-contributor-free", effort: null, agent: "explore", skills: [] },
    verifier: { label: "Verifier", kind: "verification", backend: "mcode-agent", model: "minimax/MiniMax-M3.1-Flash", effort: "ultra", agent: "verifier", skills: [] },
  },
  routing: {
    directions: [
      { id: "frontend", skills: ["frontend-design:frontend-design", "senior-fullstack-developer:frontend-dev"] },
      { id: "four", skills: ["a:one", "b:two", "c:three", "d:four"] },
      { id: "fullstack", skills: ["senior-fullstack-developer:fullstack-dev"] },
    ],
  },
};

// 宿主自己的内置 agent 定义（模型/档位就是它声明的那一套）
const AGENT_DEFS = {
  worker: { model: "minimax/MiniMax-M3.1-Flash", effort: "high" },
  explore: { model: "custom_provider:opencode-go/iceman-contributor-free", effort: null },
  verifier: { model: "minimax/MiniMax-M3.1-Flash", effort: "medium" },
};

// 宿主运行时配置（隔离夹具）：公开 provider + 私有自定义 provider。
const RUNTIME_CONFIG_YAML = [
  "provider:",
  "  minimax:",
  "    models:",
  "      MiniMax-M3.1-Flash:",
  "        name: M3.1-Flash",
  "        thinking:",
  "          effortOptions:",
  "            - default",
  "            - low",
  "            - medium",
  "            - high",
  "            - xhigh",
  "            - max",
  "      MiniMax-M3:",
  "        name: M3",
  "        thinking_config:",
  "          mode: switchable",
  "custom_provider:",
  "  provider-f0370a:",
  "    models:",
  "      GLM-5.3-Flash:",
  "        name: GLM-5.3-Flash",
  "",
].join("\n");

const VISIBLE_FOUR = [
  { fullName: "b:two", visibleName: "b:two" },
  { fullName: "c:three", visibleName: "c-three" },
  { fullName: "d:four", visibleName: "d:four" },
];

// ── 隔离现场 ─────────────────────────────────────────────────────────
async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function makeSandbox(teamConfig) {
  const dir = await mkdtemp(join(tmpdir(), "ct-task-routing-"));
  await mkdir(join(dir, "scripts"), { recursive: true });
  await mkdir(join(dir, "config"), { recursive: true });
  for (const name of ["skills-for.mjs", "dispatch-params.mjs"]) {
    if (await exists(join(SCRIPTS_SRC, name))) {
      await copyFile(join(SCRIPTS_SRC, name), join(dir, "scripts", name));
    }
  }
  await writeFile(join(dir, "config", "team.json"), JSON.stringify(teamConfig, null, 2) + "\n", "utf8");

  // 隔离的宿主数据目录：只有内置 agent 定义 + 运行时配置，没有模型目录缓存。
  const data = join(dir, "data");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "config.yaml"), RUNTIME_CONFIG_YAML, "utf8");
  for (const [name, def] of Object.entries(AGENT_DEFS)) {
    const agentDir = join(data, "agents", ".builtin", name);
    await mkdir(agentDir, { recursive: true });
    const lines = ["---", "name: " + name, "model: " + def.model];
    if (def.effort) lines.push("effort: " + def.effort);
    lines.push("---", "", "body", "");
    await writeFile(join(agentDir, "agent.md"), lines.join("\n"), "utf8");
  }
  return { dir, data };
}

function run(sandbox, script, args) {
  const res = spawnSync(process.execPath, [join(sandbox.dir, "scripts", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, MINIMAX_DATA_DIR: sandbox.data },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error: res.error?.message };
}

async function writeVisible(sandbox, name, value) {
  const file = join(sandbox.dir, name);
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
  return file;
}

// ── 检查器自检用的判定函数（同时用于断言真实产物） ──────────────────
const REASONS = new Set(["not-visible", "visibility-unknown", "limit"]);

function validateSpecialty(specialty, { visible = null, allowed = null } = {}) {
  const problems = [];
  if (!specialty || typeof specialty !== "object") return ["specialty 不是对象"];
  if (!Array.isArray(specialty.skills) || !Array.isArray(specialty.skipped)) return ["skills/skipped 不是数组"];
  if (specialty.skills.length > 2) problems.push("专业 skill 超过 2 个");
  if (allowed && specialty.direction !== null && specialty.direction !== allowed) {
    problems.push("投了别的方向：" + specialty.direction);
  }
  for (const s of specialty.skills) {
    if (!s || typeof s.fullName !== "string" || typeof s.visibleName !== "string") {
      problems.push("skills 项形状不对");
      continue;
    }
    if (visible) {
      const hit = visible.find((v) => v.fullName === s.fullName);
      if (!hit) problems.push("混入了未命中插件：" + s.fullName);
      else if (hit.visibleName !== s.visibleName) problems.push("visibleName 不对：" + s.fullName);
    }
  }
  for (const s of specialty.skipped) {
    if (!s || typeof s.fullName !== "string" || !REASONS.has(s.reason)) problems.push("skipped 项形状不对");
  }
  return problems;
}

function validateDispatch(params, { savedModel = null, savedEffort = null } = {}) {
  const problems = [];
  if (!params || typeof params !== "object") return ["派工参数不是对象"];
  for (const key of ["invocationId", "role", "backend", "agent", "model", "effort"]) {
    if (!(key in params)) problems.push("缺字段：" + key);
  }
  if (savedModel && params.requested?.model === savedModel && params.model !== savedModel) {
    problems.push("已保存的 model 只显示在页面、未进入派工参数");
  }
  if (savedEffort && params.requested?.effort === savedEffort && params.effort !== savedEffort) {
    problems.push("已保存的 effort 只显示在页面、未进入派工参数");
  }
  return problems;
}

// ── 场景 1：旧入口逐字节不变 ─────────────────────────────────────────
async function scenarioLegacy(sandbox) {
  console.log("场景 1：旧入口逐字节不变");
  const worker = run(sandbox, "skills-for.mjs", ["worker"]);
  ok("worker 旧输出不变",
    worker.status === 0
    && worker.stdout === "可用 skill（命中才用，先加载再动手）：superpowers:test-driven-development、superpowers:verification-before-completion\n",
    JSON.stringify(worker.stdout));
  const explore = run(sandbox, "skills-for.mjs", ["explore"]);
  ok("无 skill 角色的旧输出不变",
    explore.status === 0 && explore.stdout === "（该角色未配置 skill）\n",
    JSON.stringify(explore.stdout));
  const unknown = run(sandbox, "skills-for.mjs", ["nosuchrole"]);
  ok("未知角色仍退出码 2", unknown.status === 2 && unknown.stderr.includes("没有角色"),
    "status=" + unknown.status + " stderr=" + JSON.stringify(unknown.stderr));
  const noArg = run(sandbox, "skills-for.mjs", []);
  ok("缺角色仍退出码 2 并给用法", noArg.status === 2 && noArg.stderr.includes("用法"),
    "status=" + noArg.status + " stderr=" + JSON.stringify(noArg.stderr));
  const stray = run(sandbox, "skills-for.mjs", ["worker", "--unrelated-flag"]);
  ok("无关参数不改变旧输出",
    stray.status === 0
    && stray.stdout === "可用 skill（命中才用，先加载再动手）：superpowers:test-driven-development、superpowers:verification-before-completion\n",
    JSON.stringify(stray.stdout));
}

// ── 场景 2：方向附件 ─────────────────────────────────────────────────
async function scenarioSpecialty(sandbox) {
  console.log("场景 2：方向附件");
  const visibleFile = await writeVisible(sandbox, "visible-four.json", VISIBLE_FOUR);
  const four = run(sandbox, "skills-for.mjs", ["worker", "--direction", "four", "--visible-file", visibleFile]);
  let parsed = null;
  try { parsed = JSON.parse(four.stdout); } catch { /* 下面用断言报出来 */ }
  ok("新入口输出 { role, specialty } JSON",
    four.status === 0 && parsed && parsed.role === "worker" && parsed.specialty,
    "status=" + four.status + " stdout=" + JSON.stringify(four.stdout).slice(0, 300));
  if (!parsed) return;
  const spec = parsed.specialty;
  ok("附件只含可见且在前 2 个的 skill",
    spec.skills.length === 2
    && spec.skills[0].fullName === "b:two" && spec.skills[1].fullName === "c:three",
    JSON.stringify(spec));
  ok("不可见项标 not-visible",
    spec.skipped.some((s) => s.fullName === "a:one" && s.reason === "not-visible"),
    JSON.stringify(spec.skipped));
  ok("超出 2 个的可见项标 limit",
    spec.skipped.some((s) => s.fullName === "d:four" && s.reason === "limit"),
    JSON.stringify(spec.skipped));
  ok("附件校验通过", validateSpecialty(spec, { visible: VISIBLE_FOUR, allowed: "four" }).length === 0,
    validateSpecialty(spec, { visible: VISIBLE_FOUR, allowed: "four" }).join("; "));

  const noList = run(sandbox, "skills-for.mjs", ["worker", "--direction", "four"]);
  let noListParsed = null;
  try { noListParsed = JSON.parse(noList.stdout); } catch { /* 断言里报 */ }
  ok("拿不到会话清单 -> 专业 skills 为空、标 visibility-unknown",
    noListParsed
    && noListParsed.specialty.skills.length === 0
    && noListParsed.specialty.skipped.length === 4
    && noListParsed.specialty.skipped.every((s) => s.reason === "visibility-unknown"),
    JSON.stringify(noListParsed?.specialty));

  const otherVisible = await writeVisible(sandbox, "visible-frontend.json", [
    { fullName: "frontend-design:frontend-design", visibleName: "frontend-design:frontend-design" },
  ]);
  const front = run(sandbox, "skills-for.mjs", ["worker", "--direction", "frontend", "--visible-file", otherVisible]);
  let frontParsed = null;
  try { frontParsed = JSON.parse(front.stdout); } catch { /* 断言里报 */ }
  ok("只投命中方向，不带其它方向的 skill",
    frontParsed
    && frontParsed.specialty.direction === "frontend"
    && frontParsed.specialty.skills.length === 1
    && frontParsed.specialty.skills[0].fullName === "frontend-design:frontend-design"
    && frontParsed.specialty.skipped.some((s) => s.fullName === "senior-fullstack-developer:frontend-dev" && s.reason === "not-visible"),
    JSON.stringify(frontParsed?.specialty));

  const noDirection = run(sandbox, "skills-for.mjs", ["worker"]);
  ok("未选方向时旧入口不受影响", noDirection.status === 0 && noDirection.stdout.startsWith("可用 skill"),
    JSON.stringify(noDirection.stdout));
}

// ── 场景 3：未知方向 / 坏清单 ───────────────────────────────────────
async function scenarioErrors(sandbox) {
  console.log("场景 3：未知方向与坏清单");
  const unknown = run(sandbox, "skills-for.mjs", ["worker", "--direction", "nosuchdir"]);
  ok("未知方向 -> 退出码 1", unknown.status === 1, "status=" + unknown.status + " stderr=" + JSON.stringify(unknown.stderr));
  ok("未知方向 -> stderr 给字段路径", unknown.stderr.includes("routing.directions.nosuchdir"),
    JSON.stringify(unknown.stderr));
  ok("未知方向 -> stdout 不出部分结果", unknown.stdout === "", JSON.stringify(unknown.stdout));

  const badFile = join(sandbox.dir, "broken.json");
  await writeFile(badFile, "{not json", "utf8");
  const broken = run(sandbox, "skills-for.mjs", ["worker", "--direction", "four", "--visible-file", badFile]);
  ok("坏清单 -> 退出码 1", broken.status === 1, "status=" + broken.status + " stderr=" + JSON.stringify(broken.stderr));
  ok("坏清单 -> stderr 给字段路径", broken.stderr.includes("visibleFile"), JSON.stringify(broken.stderr));
  ok("坏清单 -> stdout 不出部分结果", broken.stdout === "", JSON.stringify(broken.stdout));

  const missing = run(sandbox, "skills-for.mjs", ["worker", "--direction", "four", "--visible-file", join(sandbox.dir, "nope.json")]);
  ok("清单文件不存在 -> 退出码 1 且无 stdout",
    missing.status === 1 && missing.stdout === "", "status=" + missing.status + " stdout=" + JSON.stringify(missing.stdout));

  // 配置级错误（重复方向 ID、非法完整名）也要是字段错误。
  const badConfigs = [
    { name: "重复方向 ID", routing: { directions: [{ id: "a", skills: ["p:s"] }, { id: "a", skills: ["p:s"] }] }, expect: "routing.directions.a" },
    { name: "非法完整名", routing: { directions: [{ id: "a", skills: ["nocolon"] }] }, expect: "routing.directions.a.skills[0]" },
    { name: "非法方向 id", routing: { directions: [{ id: "Bad_ID", skills: [] }] }, expect: "routing.directions" },
  ];
  for (const bad of badConfigs) {
    const badSandbox = await makeSandbox({ roles: TEAM_CONFIG.roles, routing: bad.routing });
    try {
      const res = run(badSandbox, "skills-for.mjs", ["worker", "--direction", "a"]);
      ok(bad.name + " -> 退出码 1 且 stderr 给字段路径",
        res.status === 1 && res.stderr.includes(bad.expect) && res.stdout === "",
        "status=" + res.status + " stderr=" + JSON.stringify(res.stderr));
    } finally {
      await rm(badSandbox.dir, { recursive: true, force: true });
    }
  }
}

// ── 场景 4：派工参数 ────────────────────────────────────────────────
async function scenarioDispatch(sandbox) {
  console.log("场景 4：派工参数");
  if (!await exists(join(sandbox.dir, "scripts", "dispatch-params.mjs"))) {
    ok("派工参数脚本存在", false, "缺 scripts/dispatch-params.mjs：已保存的 model/effort 没有进入派工参数的入口");
    return;
  }
  const res = run(sandbox, "dispatch-params.mjs", ["worker"]);
  let params = null;
  try { params = JSON.parse(res.stdout); } catch { /* 断言里报 */ }
  if (!ok("派工参数脚本产出 JSON", params !== null,
    "status=" + res.status + " stdout=" + JSON.stringify(res.stdout).slice(0, 300) + " stderr=" + JSON.stringify(res.stderr).slice(0, 300))) return;

  ok("字段齐全",
    ["invocationId", "role", "backend", "agent", "model", "effort"].every((k) => k in params),
    JSON.stringify(params));
  ok("已保存的 model 真的进入派工参数",
    params.model === "minimax/MiniMax-M3.1-Flash",
    JSON.stringify(params));
  ok("已保存的 effort 真的进入派工参数",
    params.effort === "high",
    JSON.stringify(params));
  ok("Task 参数带上 agent/effort；与 agent 声明相同的 model 不重复下传",
    params.taskArgs?.agent_name === "worker"
    && params.taskArgs?.effort === "high"
    && !("model" in params.taskArgs),
    JSON.stringify(params.taskArgs));
  ok("派工参数校验通过", validateDispatch(params, { savedModel: "minimax/MiniMax-M3.1-Flash", savedEffort: "high" }).length === 0,
    validateDispatch(params, { savedModel: "minimax/MiniMax-M3.1-Flash", savedEffort: "high" }).join("; "));

  const decision = run(sandbox, "dispatch-params.mjs", ["overmind"]);
  let decisionParams = null;
  try { decisionParams = JSON.parse(decision.stdout); } catch { /* 断言里报 */ }
  ok("决策角色 agent 为 null、model 原样带出",
    decisionParams && decisionParams.agent === null && decisionParams.model === "gpt-6.2-astra",
    JSON.stringify(decisionParams));

  const visibleFile = await writeVisible(sandbox, "visible-four.json", VISIBLE_FOUR);
  const withSpec = run(sandbox, "dispatch-params.mjs", ["worker", "--direction", "four", "--visible-file", visibleFile]);
  let specParams = null;
  try { specParams = JSON.parse(withSpec.stdout); } catch { /* 断言里报 */ }
  ok("派工附件带上 specialty",
    specParams?.attachment?.specialty?.skills?.length === 2
    && specParams.attachment.specialty.skipped.some((s) => s.reason === "limit"),
    JSON.stringify(specParams?.attachment));
}

// ── 场景 5：能力未证实 -> CAPABILITY_UNKNOWN ───────────────────────
async function scenarioCapability(sandbox) {
  console.log("场景 5：能力未证实");
  if (!await exists(join(sandbox.dir, "scripts", "dispatch-params.mjs"))) {
    ok("派工参数脚本存在", false, "缺 scripts/dispatch-params.mjs：能力未证实时无处报告 CAPABILITY_UNKNOWN");
    return;
  }
  const verifier = run(sandbox, "dispatch-params.mjs", ["verifier"]);
  let params = null;
  try { params = JSON.parse(verifier.stdout); } catch { /* 断言里报 */ }
  if (!ok("verifier 派工参数产出 JSON", params !== null, "status=" + verifier.status + " stdout=" + JSON.stringify(verifier.stdout).slice(0, 300))) return;
  ok("未证实的 effort -> CAPABILITY_UNKNOWN",
    params.status === "CAPABILITY_UNKNOWN",
    JSON.stringify(params));
  ok("未证实的 effort 不进派工参数", params.effort === null, JSON.stringify(params));
  ok("原值保留供展示",
    params.requested?.effort === "ultra",
    JSON.stringify(params));
  ok("已证实的 model 仍然进派工参数",
    params.model === "minimax/MiniMax-M3.1-Flash",
    JSON.stringify(params));

  // 私有自定义 provider 只在宿主运行时配置里（不在公开目录快照里）——也必须能证实。
  const privateSandbox = await makeSandbox({
    ...TEAM_CONFIG,
    roles: {
      ...TEAM_CONFIG.roles,
      worker: { ...TEAM_CONFIG.roles.worker, model: "custom_provider:provider-f0370a/GLM-5.3-Flash", effort: null },
    },
  });
  try {
    const priv = run(privateSandbox, "dispatch-params.mjs", ["worker"]);
    let privParams = null;
    try { privParams = JSON.parse(priv.stdout); } catch { /* 断言里报 */ }
    ok("私有自定义 provider 的 model 也能证实并进派工参数",
      privParams && privParams.status === "OK"
      && privParams.model === "custom_provider:provider-f0370a/GLM-5.3-Flash",
      JSON.stringify(privParams));
    ok("换了模型（与 agent 默认不同）→ Task 参数里真的带上 model",
      privParams && privParams.taskArgs?.model === "custom_provider:provider-f0370a/GLM-5.3-Flash",
      JSON.stringify(privParams?.taskArgs));
  } finally {
    await rm(privateSandbox.dir, { recursive: true, force: true });
  }

  const badSandbox = await makeSandbox({
    ...TEAM_CONFIG,
    roles: {
      ...TEAM_CONFIG.roles,
      worker: { ...TEAM_CONFIG.roles.worker, model: "made-up/model-x", effort: null },
    },
  });
  try {
    const bad = run(badSandbox, "dispatch-params.mjs", ["worker"]);
    let badParams = null;
    try { badParams = JSON.parse(bad.stdout); } catch { /* 断言里报 */ }
    ok("未证实的 model -> CAPABILITY_UNKNOWN 且不伪造已生效",
      badParams && badParams.status === "CAPABILITY_UNKNOWN"
      && badParams.model === null
      && badParams.requested?.model === "made-up/model-x",
      JSON.stringify(badParams));
    ok("未证实时 Task 参数里没有 model",
      badParams && badParams.taskArgs && !("model" in badParams.taskArgs),
      JSON.stringify(badParams?.taskArgs));
  } finally {
    await rm(badSandbox.dir, { recursive: true, force: true });
  }
}

// ── 场景 6：检查器自己抓得住目标症状 ────────────────────────────────
async function scenarioDetector() {
  console.log("场景 6：检查器自身抓得住目标症状");
  const mixed = validateSpecialty(
    { direction: "frontend", skills: [{ fullName: "not:installed", visibleName: "not:installed" }], skipped: [] },
    { visible: [{ fullName: "frontend-design:frontend-design", visibleName: "frontend-design:frontend-design" }] },
  );
  ok("能抓出'混入未命中插件'", mixed.some((p) => p.includes("未命中插件")), JSON.stringify(mixed));

  const displayOnly = validateDispatch(
    { invocationId: "x", role: "worker", backend: "mcode-agent", agent: "worker", model: null, effort: null, requested: { model: "minimax/MiniMax-M3.1-Flash", effort: null } },
    { savedModel: "minimax/MiniMax-M3.1-Flash" },
  );
  ok("能抓出'model 只显示在页面、未进入派工参数'",
    displayOnly.some((p) => p.includes("只显示在页面")), JSON.stringify(displayOnly));

  const overflow = validateSpecialty(
    { direction: "four", skills: [{ fullName: "a:one", visibleName: "a:one" }, { fullName: "b:two", visibleName: "b:two" }, { fullName: "c:three", visibleName: "c:three" }], skipped: [] },
    { visible: null },
  );
  ok("能抓出'专业 skill 超过 2 个'", overflow.some((p) => p.includes("超过 2 个")), JSON.stringify(overflow));
}

// ── 场景 7：能力描述单一来源（board 与 CLI 同源） ────────────────
async function scenarioCapabilitySource(sandbox) {
  console.log("场景 7：能力描述单一来源");
  // 模块在 import 时就解析宿主数据目录，所以 import 之前必须先给沙箱环境变量，
  // 否则它会去找这台机器的真实目录，跟 CLI 子进程看到的不是同一处。
  const savedEnv = process.env.MINIMAX_DATA_DIR;
  process.env.MINIMAX_DATA_DIR = sandbox.data;
  let mod;
  try {
    mod = await import(pathToFileURL(join(sandbox.dir, "scripts", "dispatch-params.mjs")).href);
  } finally {
    if (savedEnv === undefined) delete process.env.MINIMAX_DATA_DIR;
    else process.env.MINIMAX_DATA_DIR = savedEnv;
  }
  if (typeof mod.capabilitiesFor !== "function") {
    ok("导出 capabilitiesFor 纯函数", false, "board 服务端没有可编程的能力接口，只能靠解析 CLI 文本");
    return;
  }
  ok("导出 capabilitiesFor 纯函数", true);

  const workerCfg = TEAM_CONFIG.roles.worker;
  const cap = mod.capabilitiesFor("worker", workerCfg);

  ok("形状是契约 1 的 describe",
    cap.id === "mcode-agent" && cap.resume === "none" && cap.output === "text"
    && typeof cap.fields?.model === "object" && typeof cap.fields?.effort === "object",
    JSON.stringify(cap).slice(0, 200));
  ok("字段形状完整（type/state/nullable/required/default/values）",
    ["model", "effort"].every((f) => {
      const x = cap.fields?.[f];
      return x && typeof x.type === "string" && typeof x.state === "string"
        && typeof x.nullable === "boolean" && typeof x.required === "boolean"
        && "default" in x && "values" in x;
    }),
    JSON.stringify(cap.fields));
  ok("state 取值在契约域内（supported/unsupported/unknown）",
    ["model", "effort"].every((f) => ["supported", "unsupported", "unknown"].includes(cap.fields[f].state)),
    JSON.stringify(cap.fields));
  ok("能证出 model 闭集时 state=supported 且 values 非空",
    cap.fields.model.state === "supported" && Array.isArray(cap.fields.model.values) && cap.fields.model.values.length > 0,
    JSON.stringify(cap.fields.model));
  ok("能证出 effort 闭集时 state=supported 且 values 非空",
    cap.fields.effort.state === "supported" && Array.isArray(cap.fields.effort.values) && cap.fields.effort.values.length > 0,
    JSON.stringify(cap.fields.effort));
  ok("default 是当前配置的已证实有效值",
    cap.fields.model.default === workerCfg.model && cap.fields.effort.default === workerCfg.effort,
    "model=" + cap.fields.model.default + " effort=" + cap.fields.effort.default);
  ok("当前值无效时 default 给 null",
    mod.capabilitiesFor("worker", { model: "made-up/model-x", effort: "ultra" }).fields.model.default === null,
    JSON.stringify(mod.capabilitiesFor("worker", { model: "made-up/model-x", effort: "ultra" }).fields.model));

  // 跨模型的无效组合：effort 只在它所属的 model 下才算数。
  // 沙箱里 minimax/MiniMax-M3 是 switchable（只认 on/off），
  // 配成 high 在派工时下传不了 —— default 也必须给 null。
  const crossModel = mod.capabilitiesFor("worker", { model: "minimax/MiniMax-M3", effort: "high" });
  ok("跨模型的无效 effort 组合 default 给 null",
    crossModel.fields.effort.default === null,
    JSON.stringify(crossModel.fields.effort));
  ok("能证出该模型自己的 effort 域（按 model 收窄）",
    typeof mod.effortValuesForModel === "function"
    && JSON.stringify(mod.effortValuesForModel("minimax/MiniMax-M3")) === JSON.stringify(["on", "off"]),
    JSON.stringify(mod.effortValuesForModel?.("minimax/MiniMax-M3")));

  // 派工输出的 capability.state 是逐值判定（confirmed/unknown，usage.md 的口径）；
  // describe 形状的 state 是契约 1 词表（supported/unsupported/unknown）。
  // 两处词表不能混：board 只认 supported，混了会把字段判成不可编辑。
  const dispatchOut = run(sandbox, "dispatch-params.mjs", ["worker"]);
  let dispatchJson = null;
  try { dispatchJson = JSON.parse(dispatchOut.stdout); } catch { /* 断言里报 */ }
  ok("派工输出的 capability.state 仍是 confirmed/unknown",
    ["confirmed", "unknown"].includes(dispatchJson?.capability?.model?.state),
    JSON.stringify(dispatchJson?.capability));
  ok("describe 形状的 state 不再用 confirmed",
    !["confirmed"].includes(cap.fields.model.state) && !["confirmed"].includes(cap.fields.effort.state),
    JSON.stringify(cap.fields));

  // CLI 与函数必须逐字相同：board 用函数、页面用 CLI，两边不能各说各话。
  const cli = run(sandbox, "dispatch-params.mjs", ["--capabilities"]);
  let cliJson = null;
  try { cliJson = JSON.parse(cli.stdout); } catch { /* 断言里报 */ }
  const fromFn = JSON.stringify(mod.capabilitiesFor("worker", workerCfg));
  const fromCli = JSON.stringify(cliJson?.roles?.worker?.backends?.["mcode-agent"]);
  ok("CLI 输出与 capabilitiesFor 逐字相同",
    fromFn === fromCli,
    "fn=" + fromFn + " cli=" + fromCli);

  // 证不出来时给 null + unknown，不猜、不放宽。
  const emptyDir = join(sandbox.dir, "empty-data");
  await mkdir(emptyDir, { recursive: true });
  const emptyEnv = { ...process.env, MINIMAX_DATA_DIR: emptyDir };
  const probe = spawnSync(process.execPath, [
    "-e",
    "import(" + JSON.stringify(pathToFileURL(join(sandbox.dir, "scripts", "dispatch-params.mjs")).href) + ")"
      + ".then(m=>console.log(JSON.stringify(m.capabilitiesFor('worker',{model:'minimax/MiniMax-M3.1-Flash'}))))",
  ], { encoding: "utf8", env: emptyEnv });
  let unknownCap = null;
  try { unknownCap = JSON.parse(probe.stdout); } catch { /* 断言里报 */ }
  ok("证不出来时 values=null 且 state=unknown",
    unknownCap?.fields?.model?.values === null && unknownCap?.fields?.model?.state === "unknown"
    && unknownCap?.fields?.effort?.values === null && unknownCap?.fields?.effort?.state === "unknown",
    "status=" + probe.status + " out=" + JSON.stringify(unknownCap ?? probe.stdout).slice(0, 200));
}

// ── 主流程 ─────────────────────────────────────────────────────────
const sandbox = await makeSandbox(TEAM_CONFIG);
try {
  await scenarioLegacy(sandbox);
  await scenarioSpecialty(sandbox);
  await scenarioErrors(sandbox);
  await scenarioDispatch(sandbox);
  await scenarioCapability(sandbox);
  await scenarioDetector();
  await scenarioCapabilitySource(sandbox);
} finally {
  await rm(sandbox.dir, { recursive: true, force: true });
}

console.log("");
if (failures) {
  console.log(failures + " 项未通过");
  process.exit(1);
}
console.log("PASS task-routing");
