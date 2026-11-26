#!/usr/bin/env node
// Code Team 派工闸门 —— 宿主 hook，在 Task 创建前拦住不合格的派工。
//
// 为什么存在（2026-11-25 复盘）：闸门写在事故之后，而且只是「需要人记得跑的脚本」，
// 三次撞额度事故时闸门一次都没生效。这里把闸门搬进宿主：Task 创建前自动判定，
// 不合格就 exit 2 拒绝，主会话绕不过去。
//
// 宿主契约（.builtin-skills/plugin-creator/references/local-plugin-hooks.md）：
//   stdin  = 一个 JSON 对象：hook_event_name / session_id / turn_id / cwd / tool_name / tool_input / tool_use_id
//   拒绝  = stderr 写原因 + exit 2（PreToolUse 才有效；其它退出码一律放行）
//   放行  = 静默 exit 0（不写 stdout，别污染模型上下文）
//   cwd   = 活动工作区，不是插件目录 —— 脚本路径一律用 PLUGIN_ROOT 推导
//   改写  = PreToolUse 可用 hookSpecificOutput.updatedInput 装入已验证的 brief 正文
//
// 事件：PreToolUse（判定）/ PostToolUse（回执记账）/ SubagentStop（验收结果）。
// B/C/D/E 四个模块是各自所有者的文件，这里只按它们的导出调用；
// 模块缺失或抛错时按模块降级，并把「该闸未生效」写进拒绝原因，不整体放行。
//
// 失败方向的口径（2026-11-25 独立验收 7 条缺陷之后，2026-11-26 第二轮 8 条之后）：
//   - 坏输入、坏状态、缺计量、模块缺失 —— 一律拒签，宁可误拒不可误放；
//   - 宿主对「hook 崩溃/超时」按放行处理，所以入口必须自己把加载失败变成拒签信号；
//   - 静态依赖一律动态加载：静态导入一旦缺文件，插件根本起不来，宿主按崩溃放行 = 闸门不存在。
import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 可选标记（写在 Task prompt 里）
const PLAN_RE = /code-team-plan:[ \t]*(\S+)/i;
const PACKAGE_RE = /code-team-package:[ \t]*(\S+)/i;
const BRIEF_REF_RE = /code-team-brief-ref:[ \t]*(\{[^\n]*\})/i;
// Worker 的真实工作树：派工时可以显式给（不给就用派工时的工作区）。
const WORKTREE_RE = /code-team-worktree:[ \t]*(.+)/i;
const RETRY_RE = /code-team-retry:[ \t]*(\{[^\n]*\})/i;
const CONTINUATION_RE = /code-team-continuation:[ \t]*(\{[^\n]*\})/i;
const SELF_EVIDENCE_RE = /code-team-self-evidence:[ \t]*(\{[^\n]*\})/i;
const VERDICT_RE = /code-team-verification-verdict:[ \t]*(pass|fail)/i;
// 验收口径键标记：没有它就不进验收闸（E 的口径键缺一不可，别让 marker-less 的派工被 E 拒）。
const VERIFICATION_KEY_RE = /code-team-verification-key:[ \t]*(\{[^\n]*\})/i;
// 验收结论必须带真实证据引用（E 的口径：空引用 = 无效结果）。
const EVIDENCE_RE = /code-team-verification-evidence:[ \t]*(\{[^\n]*\})/i;
// 像不像一份 brief（有归属段 / 验收段 / Done / .NET 验收命令）
const BRIEFLIKE_RE = /文件归属|文件所有权|归属文件|验收|Done|verify\.ps1|dotnet\s+build/i;
// 是不是 Code Team 自己的派工 —— 判据（三条任一命中即是）：
//   1) 正文里有 code-team-* 标记；
//   2) 任务描述里写了 Code Team；
//   3) brief 是 Overmind 产出的格式（Stakes / Hypothesis / Done = (tangible check) / Owner+Acceptance）。
// 靠这三条识别，才能在「缺 plan / package 标记」时仍判定它是 Code Team 派工并拒签；
// 普通（非 Code Team）的 worker 派工不命中任何一条，不受影响。
const CODE_TEAM_MARKER_RE = /code-team-[a-z-]+:/i;
const CODE_TEAM_DESC_RE = /code[\s-]*team/i;
const CODE_TEAM_BRIEF_RE = /Stakes:|Hypothesis:|Done\s*=\s*\(tangible check\)|Owner: *Worker/im;
// 终结成功才算「完成」（E 的口径：预留 / 运行中 / 失败都不算）。
const SUCCESS_OUTCOMES = new Set([
  "completed", "complete", "passed", "pass", "succeeded", "success", "done", "finished", "ok",
]);
// 注入正文的体积上限：超出就拒签，别把宿主 stdout 撑爆（宿主对超限输出的处理不可控）。
const MAX_INJECT_BYTES = 128 * 1024;

// 回执里的非终结状态：这些只是「开起来了」，不是「跑完了」，不能写 settled。
const NON_TERMINAL_STATUS = new Set([
  "started", "starting", "running", "pending", "queued", "accepted", "in_progress", "created",
]);

const MODULE_FILES = {
  B: "trajectory-usage.mjs",
  C: "retry-policy.mjs",
  D: "codex-team.mjs",
  E: "verification-policy.mjs",
};

// 检查脚本（编译闸 / 归属闸）：动态加载。
// 静态导入一旦缺文件，插件根本起不来 —— 宿主把「hook 崩溃」按放行处理，闸门等于不存在。
const CHECK_MODULES = {
  compileGate: { file: "brief-requires-compile-gate.mjs", export: "checkCompileGate" },
  fileOwnership: { file: "brief-file-ownership-disjoint.mjs", export: "checkFileOwnership" },
};
const checkCache = new Map();

async function loadCheck(deps, key) {
  const injected = deps && deps.checks ? deps.checks[key] : undefined;
  if (injected !== undefined) {
    if (injected === null) return { fn: null, error: "模块缺失" };
    if (typeof injected === "function") return { fn: injected, error: null };
    return { fn: null, error: "替身不是函数" };
  }
  const legacy = key === "compileGate" ? deps.checkCompileGate : deps.checkFileOwnership;
  if (typeof legacy === "function") return { fn: legacy, error: null };
  if (checkCache.has(key)) return checkCache.get(key);
  const spec = CHECK_MODULES[key];
  let res;
  try {
    const mod = await import(new URL("../checks/" + spec.file, import.meta.url).href);
    const fn = mod[spec.export];
    res = typeof fn === "function" ? { fn, error: null } : { fn: null, error: "模块没有导出 " + spec.export };
  } catch (err) {
    res = { fn: null, error: (err && err.message) || String(err) };
  }
  checkCache.set(key, res);
  return res;
}

// 归属提取（闸 2 要用）：和归属检查同一个模块，一起动态加载。
async function loadOwnership(deps) {
  const injected = deps && deps.checks ? deps.checks.fileOwnership : undefined;
  if (injected !== undefined) {
    if (injected === null) return { extract: null, error: "模块缺失" };
    if (typeof injected === "function") return { extract: injected, error: null };
    return { extract: null, error: "替身不是函数" };
  }
  if (typeof deps.extractOwnedFiles === "function") return { extract: deps.extractOwnedFiles, error: null };
  if (checkCache.has("ownership")) return checkCache.get("ownership");
  let res;
  try {
    const mod = await import(new URL("../checks/" + CHECK_MODULES.fileOwnership.file, import.meta.url).href);
    res = typeof mod.extractOwnedFiles === "function"
      ? { extract: mod.extractOwnedFiles, error: null }
      : { extract: null, error: "模块没有导出 extractOwnedFiles" };
  } catch (err) {
    res = { extract: null, error: (err && err.message) || String(err) };
  }
  checkCache.set("ownership", res);
  return res;
}

function loadTeamConfig() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, "config", "team.json"), "utf8"));
  } catch {
    return { roles: {} };
  }
}

function resolveRole(agentName, team) {
  if (!agentName) return null;
  for (const [key, role] of Object.entries(team.roles || {})) {
    if (role && role.agent && role.agent === agentName) return { key, ...role };
  }
  return null;
}

// 状态目录：宿主给的 PLUGIN_DATA（可写）；没有就退到临时目录，别写进插件目录
function defaultStateDir() {
  const base = String(process.env.PLUGIN_DATA || "").trim();
  return base || join(tmpdir(), "code-team-dispatch");
}

// 事件账本读不出来就是状态坏了，不当空状态用 —— 空状态会让所有闸失去依据。
function readEvents(dir) {
  const file = join(dir, "dispatch-events.jsonl");
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch {
      // 最后一行没有换行 = 上次进程崩在半行上，丢掉它继续；
      // 中间的坏行说明状态真的坏了，不能当空状态用。
      if (i === lines.length - 1 && !raw.endsWith("\n")) continue;
      throw new Error("状态文件损坏（有一行不是合法 JSON）：" + file);
    }
  }
  return out;
}

// 写不动就抛：写不动意味着后续判定没有依据，宁可误拒不可误放。
function appendEvent(dir, record) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "dispatch-events.jsonl"), JSON.stringify(record) + "\n", "utf8");
  return true;
}

const allow = (reason, extra = {}) => ({ decision: "allow", reason, findings: [], ...extra });
const deny = (reason, extra = {}) => ({ decision: "deny", reason, findings: [], ...extra });

// C / E 的状态文件读坏了必须拒签：模块自己会把坏状态当空状态，hook 侧先拦一道。
function assertStateFileParses(file, label) {
  if (!existsSync(file)) return;
  try {
    JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(label + " 状态文件损坏（读成空状态等于没闸）：" + file);
  }
}

function parseJsonMarker(text, re) {
  const m = re.exec(String(text || ""));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// 模块加载：测试可用 deps.modules 注入替身；真实运行按需动态 import，失败按模块降级
async function loadModule(deps, key) {
  const name = MODULE_FILES[key];
  const modules = deps.modules || {};
  if (Object.prototype.hasOwnProperty.call(modules, key)) {
    // 注入为 null = 显式声明该模块缺失（测试与降级路径）
    if (modules[key] === null) return { key, mod: null, error: "模块缺失" };
    return { key, mod: modules[key], error: null };
  }
  try {
    const mod = await import(new URL("../scripts/" + name, import.meta.url).href);
    return { key, mod, error: null };
  } catch (err) {
    return { key, mod: null, error: (err && err.message) || String(err) };
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------ 状态锁 -- */

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

// 归属检查与预留必须同一把锁：否则两个并发派工可以同时拿到冲突归属。
function acquireLock(stateDir, timeoutMs = 1500) {
  const lockDir = join(stateDir, "dispatch.lock");
  mkdirSync(stateDir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      return lockDir;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 30000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        /* 锁刚被别人清掉，重试 */
      }
      if (Date.now() > deadline) throw new Error("获取派工状态锁超时");
      sleep(20);
    }
  }
}

function releaseLock(lockDir) {
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* 锁没了就算了 */ }
}

/* ------------------------------------------------------------ git 取证 -- */

// git 子命令失败就是失败：折成空串 = 把「取不到证据」当成「没有变更」。
function gitOut(worktreePath, args) {
  const r = spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      error: (r.error && r.error.message) || ("git " + args.join(" ") + " 退出码 " + r.status),
    };
  }
  return { ok: true, out: r.stdout ?? "" };
}

// 派工时记基线提交：续派取证要「基线..HEAD」的提交，工作树干净不代表没提交。
function worktreeBaseCommit(worktreePath) {
  if (!worktreePath) return null;
  const r = gitOut(worktreePath, ["rev-parse", "HEAD"]);
  return r.ok ? r.out.trim() : null;
}

// 取证前自己把 git 跑一遍：任何一条子命令失败就拒签，不让 C 把失败折成空证据。
function collectGitEvidence(worktreePath, baseCommit) {
  if (!worktreePath) return { ok: false, error: "缺少原 Worker 工作树路径" };
  const head = gitOut(worktreePath, ["rev-parse", "HEAD"]);
  if (!head.ok) return { ok: false, error: head.error };
  const status = gitOut(worktreePath, ["status", "--porcelain=v1"]);
  if (!status.ok) return { ok: false, error: status.error };
  if (!baseCommit) return { ok: false, error: "没有派工时记下的基线提交，无法判断「已提交但工作树干净」" };
  const log = gitOut(worktreePath, ["log", "--format=%H %s", baseCommit + "..HEAD"]);
  if (!log.ok) return { ok: false, error: log.error };
  const diff = gitOut(worktreePath, ["diff", "--name-only", baseCommit + "..HEAD"]);
  if (!diff.ok) return { ok: false, error: diff.error };
  const commits = log.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(" ");
      return { hash: line.slice(0, i), subject: line.slice(i + 1) };
    });
  const changedPaths = diff.out.split(/\r?\n/).filter(Boolean);
  return {
    ok: true,
    worktreePath,
    baseCommit,
    headCommit: head.out.trim(),
    statusEvidence: status.out,
    commits,
    changedPaths,
    relevantCommits: commits,
    relevantPaths: changedPaths,
    hasCommits: commits.length > 0,
    hasChanges: status.out.trim() !== "",
  };
}

// 取证：优先用 C 的入口（带基线提交），C 的入口抛异常时用本 hook 自己取的证据
// （同一批 git 命令，上面已经 fail closed 过）。任何一条 git 失败都不会折成「无变更」。
function collectWorktreeEvidence(cmod, worktreePath, baseCommit, gitEvidence) {
  if (typeof cmod.collectWorktreeEvidence === "function") {
    try {
      const res = cmod.collectWorktreeEvidence(worktreePath, { baseCommit: baseCommit || null });
      if (res && res.ok === true) return res;
      if (!gitEvidence.ok) return res || { ok: false, error: "工作树取证失败", worktreePath };
    } catch {
      /* C 的入口坏了：下面用自己的证据 */
    }
  }
  if (!gitEvidence.ok) return { ok: false, error: gitEvidence.error, worktreePath };
  return gitEvidence;
}

/* -------------------------------------------------------- 回执解析 -- */

// 回执里捞 Task / 子会话标识；捞不到就如实留空，不许编。
// 宿主归档（local-task.js / local-task-append.js）给的是 sub_session_id / sub_turn_id，
// 宿主 runner 把原生工具结果放进 tool_response，所以字段名要一起认。
function extractReceipt(receipt, depth = 0) {
  const out = { taskId: null, childSessionId: null, childTurnId: null, outcome: null, failure: null, terminal: false };
  if (depth > 4) return out;
  if (typeof receipt === "string") {
    const raw = receipt.trim();
    if (!raw) return out;
    try {
      receipt = JSON.parse(raw);
    } catch {
      return out;
    }
  }
  if (!receipt || typeof receipt !== "object") return out;
  const pick = (keys, value) => {
    for (const k of keys) {
      if (value[k] !== undefined && value[k] !== null && value[k] !== "") return value[k];
    }
    return null;
  };
  out.taskId = pick(["taskId", "task_id", "taskid"], receipt);
  out.childSessionId = pick(["sub_session_id", "child_session_id", "childSessionId"], receipt);
  out.childTurnId = pick(["sub_turn_id", "child_turn_id", "childTurnId"], receipt);
  out.outcome = pick(["outcome", "status"], receipt);
  out.failure = pick(["failure", "error"], receipt);
  // 不提前返回：outcome / failure 可能在更深一层。
  for (const v of Object.values(receipt)) {
    if (v && typeof v === "object") {
      const sub = extractReceipt(v, depth + 1);
      for (const k of Object.keys(out)) {
        if (out[k] === null && sub[k] !== null) out[k] = sub[k];
      }
    }
  }
  return markTerminal(out);
}

// started / running 这类只是「开起来了」，不算终结；带 failure 一律算终结。
function markTerminal(out) {
  const status = out.outcome == null ? null : String(out.outcome).toLowerCase();
  out.terminal = Boolean(out.failure) || (status !== null && !NON_TERMINAL_STATUS.has(status));
  return out;
}

/* -------------------------------------------------------- 账本查询 -- */

// 按 task_id 严格还原宿主权威记录：同一个 task_id 的那一次 attempt。
// 不按包号、不按会话猜 —— 猜一次就是「请求 A 吃掉 B 的失败」。
function resolveTaskTarget(events, taskId) {
  if (!taskId) return { kind: "unknown", meta: null };
  const key = String(taskId);
  const records = events.filter(
    (e) => e.taskId !== null && e.taskId !== undefined && String(e.taskId) === key,
  );
  if (!records.length) return { kind: "unknown", meta: null };
  const started = records.filter((e) => e.event === "dispatch.started").pop();
  const base =
    started ||
    records.filter((e) => e.event === "dispatch.requested" || e.event === "dispatch.reserved").pop();
  if (!base) return { kind: "unknown", meta: null };
  const meta = {
    taskId: key,
    role: base.role || null,
    agentName: base.agentName || null,
    packageId: base.packageId || null,
    planId: base.planId || base.planRevisionId || null,
    attemptId: base.attemptId || null,
    projectKey: base.projectKey || null,
    sessionId: base.sessionId || null,
    worktreePath: base.worktreePath || null,
    baseCommit: base.baseCommit || null,
    isCodeTeam: base.isCodeTeam === true,
    requestKey: base.requestKey || null,
    settled: null,
  };
  // 已知非 Code Team 的任务：账本里记着它不是 Code Team 派工 → 不走派工闸门。
  if (!meta.isCodeTeam) return { kind: "foreign", meta };
  const settled = records
    .filter(
      (e) =>
        e.event === "dispatch.settled" &&
        (!meta.attemptId || !e.attemptId || e.attemptId === meta.attemptId),
    )
    .pop();
  meta.settled = settled || null;
  return { kind: "codeteam", meta };
}

// 这个项目 / 这个会话里有没有 Code Team 的痕迹：有痕迹却认不出目标 = 认不出归属。
function codeTeamFootprint(events, { projectKey, sessionId }) {
  return events.some(
    (e) =>
      e.isCodeTeam === true &&
      ((projectKey && e.projectKey === projectKey) || (sessionId && e.sessionId === sessionId)),
  );
}

function findPriorDecision(events, requestKey) {
  if (!requestKey) return null;
  return events
    .filter(
      (e) =>
        e.requestKey === requestKey &&
        (e.event === "dispatch.denied" || e.event === "dispatch.reserved"),
    )
    .pop();
}

/* ---------------------------------------------------- PreToolUse 判定 -- */

/**
 * PreToolUse 判定。返回 HookReply：{ decision, reason, findings, requestKey, updatedInput? }
 * deps 可注入：modules（B/C/D/E 替身）、checks（编译闸/归属闸替身）、
 *              checkCompileGate / checkFileOwnership / readEvents / appendEvent /
 *              teamConfig / nowMs / stateDir / reader
 */
/**
 * 从回执里挖失败证据：机器码（payload.error.code）+ 文本。
 * 宿主把原生工具结果放进 tool_response，错误形状不固定，所以逐层找。
 */
function extractFailureDetails(receipt, depth = 0) {
  const out = { protocolCode: null, text: null };
  if (!receipt || typeof receipt !== "object" || depth > 5) return out;
  const err = receipt.error || (receipt.payload && receipt.payload.error) || null;
  const code =
    receipt.protocolCode ??
    receipt.errorCode ??
    (err && (err.code ?? (err.payload && err.payload.error && err.payload.error.code))) ??
    null;
  if (typeof code === "number" && Number.isFinite(code)) out.protocolCode = code;
  const text = receipt.text ?? receipt.message ?? (err && (err.message ?? err.text)) ?? null;
  if (typeof text === "string" && text) out.text = text;
  if (out.protocolCode === null || !out.text) {
    for (const v of Object.values(receipt)) {
      if (v && typeof v === "object") {
        const sub = extractFailureDetails(v, depth + 1);
        if (out.protocolCode === null) out.protocolCode = sub.protocolCode;
        if (!out.text) out.text = sub.text;
      }
    }
  }
  return out;
}

/**
 * 从账本还原失败批次证据。口径（C 的规则）：
 * 批次 / 原并发 / 工作树 / 基线 / 机器码 / 失败时刻都来自账本，
 * 提示词里的同名字段不算证据（只是交叉校验）。
 *
 * 原并发 = 批次「实际启动区间」内该批次的包集合（不是失败前 60 秒的窗口估计）。
 */
function failedBatchFromLedger(events, meta) {
  const at = (e) => (Number.isFinite(e.observedAtMs) ? e.observedAtMs : Number(e.atMs) || 0);
  const projectKey = meta.projectKey || null;
  const planId = meta.planId || null;
  const sameGroup = (e) => e.projectKey === projectKey && (e.planId ?? null) === (planId ?? null);
  const settled = meta.settled || null;
  const targetAt = settled ? at(settled) : 0;
  // 批次启动区间：同一项目 + 同一计划版本下、失败之前被派出的那批包。
  const dispatched = events.filter(
    (e) =>
      (e.event === "dispatch.requested" || e.event === "dispatch.reserved") &&
      sameGroup(e) &&
      e.role === "worker" &&
      at(e) <= targetAt,
  );
  const batchStartMs = dispatched.length ? Math.min(...dispatched.map(at)) : targetAt;
  const batchEndMs = dispatched.length ? Math.max(...dispatched.map(at)) : targetAt;
  const packages = new Set(
    dispatched
      .filter((e) => at(e) >= batchStartMs && at(e) <= batchEndMs && e.packageId)
      .map((e) => e.packageId),
  );
  if (meta.packageId) packages.add(meta.packageId);
  const failure = (settled && settled.failure) || null;
  return {
    batchId: "batch:" + (projectKey || "no-project") + ":" + (planId || "no-plan"),
    previousConcurrency: Math.max(packages.size, 1),
    failureAtMs: settled ? at(settled) || null : null,
    attemptId: (settled && settled.attemptId) || meta.attemptId || null,
    taskId: meta.taskId || null,
    childTurnId: (settled && settled.childTurnId) || null,
    worktreePath: meta.worktreePath || (settled && settled.worktreePath) || null,
    baseCommit: meta.baseCommit || (settled && settled.baseCommit) || null,
    protocolCode: failure ? failure.protocolCode ?? null : null,
    failureText: failure ? failure.text ?? null : null,
  };
}

export async function handleDispatchHook(input, deps = {}) {
  // 顶层兜底：宿主对「hook 崩溃/超时」按放行处理，所以闸门内部异常时宁可误拒不可误放。
  try {
    return await dispatchDecision(input, deps);
  } catch (err) {
    const reason = "该闸未生效：hook 内部异常（" + ((err && err.message) || err) + "）—— 宁可误拒不可误放";
    try {
      appendEvent(deps.stateDir || defaultStateDir(), {
        schemaVersion: 1,
        eventId: randomUUID(),
        atMs: (deps.nowMs || Date.now)(),
        event: "dispatch.denied",
        reason,
        requestKey: [input && input.session_id, input && input.turn_id, input && input.tool_use_id].join("|"),
        toolName: (input && input.tool_name) || null,
      });
    } catch { /* 记不动也不能放行 */ }
    return deny(reason, { findings: [{ code: "hook-internal-error", severity: "error", message: reason }] });
  }
}

async function dispatchDecision(input, deps = {}) {
  const stateDir = deps.stateDir || defaultStateDir();
  const d = {
    teamConfig: loadTeamConfig(),
    nowMs: () => Date.now(),
    readEvents: () => readEvents(stateDir),
    appendEvent: (rec) => appendEvent(stateDir, rec),
    stateDir,
    ...deps,
  };

  // 事件信封：处理器与事件必须匹配，否则判不了 = 拒签。
  const eventName = input && input.hook_event_name;
  if (eventName !== "PreToolUse") {
    const reason =
      "事件信封不对：本处理器只处理 PreToolUse（实际 " + (eventName || "无") + "）—— 判不了就拒签";
    return deny(reason, {
      findings: [{ code: "event-envelope-mismatch", severity: "error", message: reason }],
    });
  }

  const tool = input.tool_name;
  if (!tool) {
    const reason = "派工工具名缺失，判不了 —— 宁可误拒不可误放";
    return deny(reason, {
      findings: [{ code: "tool-name-missing", severity: "error", message: reason }],
    });
  }
  if (tool !== "task" && tool !== "task_append") return allow("不是派工工具");
  if (String(process.env.CODE_TEAM_GATE || "").toLowerCase() === "off") {
    return allow("派工闸门已关闭（CODE_TEAM_GATE=off）");
  }

  const toolInput =
    input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
      ? input.tool_input
      : null;
  if (!toolInput) {
    return deny("派工参数缺失或不是对象 —— 宁可误拒不可误放", {
      findings: [{ code: "tool-input-invalid", severity: "error", message: "tool_input 不是对象，无法判定" }],
    });
  }

  const toolUseId = input.tool_use_id || "";
  const requestKey = [input.session_id || "", input.turn_id || "", toolUseId].join("|");
  const projectRoot = resolve(String(input.cwd || process.cwd()));
  const projectKey = projectRoot.toLowerCase();
  const atMs = d.nowMs();

  let events;
  try {
    events = d.readEvents() || [];
  } catch (err) {
    const reason = "状态文件不可读，该闸未生效：" + ((err && err.message) || err);
    return deny(reason, { findings: [{ code: "state-unreadable", severity: "error", message: reason }] });
  }

  // 同请求重放：按第一次的判定返回，不再重复判、不再重复写事件
  const prior = findPriorDecision(events, requestKey);
  if (prior) {
    return prior.event === "dispatch.denied"
      ? deny(prior.reason || "派工已被拒绝", { requestKey, replayed: true, findings: prior.findings || [] })
      : allow("重放同一请求：沿用首次判定", {
          requestKey,
          replayed: true,
          updatedInput: prior.updatedInput || null,
        });
  }

  const rawPrompt = String(toolInput.prompt || "");
  const content = String(toolInput.content || "");
  // 宿主真实 task_append 的入参是 {task_id, content}，正文在 content 里。
  const bodyText = tool === "task_append" ? (content || rawPrompt) : rawPrompt;
  const taskIdIn = toolInput.task_id || toolInput.taskId || null;

  const isCodeTeam =
    CODE_TEAM_MARKER_RE.test(bodyText) ||
    CODE_TEAM_DESC_RE.test(String(toolInput.description || "")) ||
    CODE_TEAM_BRIEF_RE.test(bodyText);

  // 宿主真实 task_append 只有 {task_id, content}，没有 agent_name；
  // 角色/包号/失败证据只能按 task_id 从账本还原，认不出归属就拒签。
  let meta = null;
  if (tool === "task_append") {
    const target = resolveTaskTarget(events, taskIdIn);
    if (target.kind === "foreign") {
      return allow("非 Code Team 任务，不走派工闸门");
    }
    if (target.kind === "unknown") {
      const reason =
        "该闸未生效：续派目标识别不出来（task_id=" +
        (taskIdIn || "无") +
        "）—— 无法确认归属，拒绝（不得兜底放行）";
      if (isCodeTeam || codeTeamFootprint(events, { projectKey, sessionId: input.session_id })) {
        return deny(reason, {
          findings: [{ code: "continuation-unresolved", severity: "error", message: reason }],
        });
      }
      // 这个项目 / 会话里没有任何 Code Team 痕迹 → 不是 Code Team 的活，不拦。
      return allow("非 Code Team 项目/会话，不走派工闸门");
    }
    meta = target.meta;
  }

  let role = resolveRole(toolInput.agent_name, d.teamConfig);
  if (tool === "task_append") {
    // 角色来自账本里那个 task_id 的记录；认不出就按 worker 处理（Code Team 派工都是 worker）。
    role = { key: (meta && meta.role) || "worker", agent: (meta && meta.agentName) || null };
  }

  const planFromText = (PLAN_RE.exec(bodyText) || [])[1] || null;
  const packageFromText = (PACKAGE_RE.exec(bodyText) || [])[1] || null;
  const planId = (meta && meta.planId) || planFromText;
  const packageId = (meta && meta.packageId) || packageFromText;

  // attempt 标识：每次派工一个，跨 PostToolUse 记账带到失败记录里。
  const attemptId = "att-" + randomUUID();

  // Worker 的真实工作树：派工时写进账本（续派取证要用它，不是续派时主会话的 cwd）。
  // brief 里可以用 code-team-worktree 显式指定；不给就用派工时的工作区。
  const wtMatch = WORKTREE_RE.exec(bodyText);
  const workerWorktree =
    tool === "task"
      ? resolve(String((wtMatch && wtMatch[1].trim()) || projectRoot))
      : (meta && meta.worktreePath) || projectRoot;
  const baseCommit =
    tool === "task" && role && role.key === "worker"
      ? worktreeBaseCommit(workerWorktree)
      : (meta && meta.baseCommit) || null;

  // 批次：同一项目 + 同一计划版本 = 一批。启动区间 = 该批第一次派工 → 本次派工。
  const batchGroup = events.filter(
    (e) =>
      e.event === "dispatch.requested" &&
      e.projectKey === projectKey &&
      (e.planId ?? null) === (planId ?? null) &&
      e.role === "worker",
  );
  const batchStartMs = batchGroup.length
    ? Math.min(...batchGroup.map((e) => Number(e.atMs) || 0), atMs)
    : atMs;
  const batchId = "batch:" + projectKey + ":" + (planId ?? "no-plan");

  const findings = [];
  // 引用绑定信息（项目 / 计划版本）：随事件记账，后面几次派工据此判「这是不是同一个项目的引用」。
  let briefPlanRevisionId = null;
  let briefProjectKey = null;

  // --- D：Code Team 首派必须带产物引用，正文由宿主按引用核对 -----------------
  let briefText = bodyText;
  let updatedInput = null;
  const refMatch = BRIEF_REF_RE.exec(bodyText);
  const needsRef = Boolean(role && role.key === "worker") && tool === "task" && isCodeTeam;
  if (!refMatch) {
    if (needsRef) {
      findings.push({
        code: "brief-ref-missing",
        severity: "error",
        brief: packageId,
        message:
          "Code Team 首派必须带 code-team-brief-ref（正文由 Overmind 发布，宿主按引用核对原文）—— 手写正文一律拒绝",
      });
    }
  } else {
    const dm = await loadModule(d, "D");
    if (!dm.mod) {
      findings.push({
        code: "brief-ref-unresolved",
        severity: "error",
        brief: packageId,
        message: "该闸未生效：D " + dm.error + "（本轮只转交产物引用，正文装不进去）",
      });
    } else {
      const ref = parseJsonMarker(bodyText, BRIEF_REF_RE);
      let verified = null;
      let dError = null;
      try {
        verified = dm.mod.readVerifiedBrief(ref, {
          planRevisionId: planId || undefined,
          packageId: packageId || undefined,
        });
        if (verified === null || verified === undefined) dError = "读取产物引用没有返回结果";
      } catch (err) {
        dError = (err && err.message) || String(err);
      }
      if (dError) {
        findings.push({
          code: "module-degraded",
          severity: "error",
          brief: packageId,
          message: "该闸未生效：D " + dError,
        });
      } else if (!verified.ok) {
        findings.push({
          code: "brief-ref-invalid",
          severity: "error",
          brief: packageId,
          message: "产物引用校验失败：" + (verified.error || "未知错误"),
        });
      } else {
        const bindError = checkRefBinding(events, {
          ref,
          verified,
          planId,
          packageId,
          projectKey,
        });
        if (bindError) {
          findings.push({
            code: "brief-ref-binding",
            severity: "error",
            brief: packageId,
            message: bindError,
          });
        } else if (Buffer.byteLength(String(verified.text), "utf8") > MAX_INJECT_BYTES) {
          findings.push({
            code: "brief-too-large",
            severity: "error",
            brief: packageId,
            message: "已验证正文超过注入上限（" + MAX_INJECT_BYTES + " 字节）—— 拒绝注入，避免宿主输出溢出",
          });
        } else {
          briefText = verified.text;
          updatedInput = injectVerifiedBody(tool, toolInput, verified.text);
          briefPlanRevisionId = (ref && ref.planRevisionId) || null;
          briefProjectKey = (verified && verified.projectKey) || null;
        }
      }
    }
  }
  const common = {
    schemaVersion: 1,
    eventId: randomUUID(),
    atMs,
    projectKey,
    planRevisionId: planId,
    planId,
    attemptId,
    // 派工时的工作树 + 基线提交：续派取证要用它们。
    worktreePath: workerWorktree,
    baseCommit,
    batchId,
    batchStartMs,
    batchEndMs: atMs,
    role: role ? role.key : null,
    backend: role ? role.backend || null : null,
    packageId,
    requestKey,
    sessionId: input.session_id || null,
    toolUseId: toolUseId || null,
    toolName: tool,
    agentName: toolInput.agent_name || (meta && meta.agentName) || null,
    taskId: taskIdIn,
    isCodeTeam,
    briefPlanRevisionId,
    briefProjectKey,
  };
  try {
    // 每次派工都记账（含非 Code Team 的）：没有这条，续派就认不出目标是不是自己的。
    d.appendEvent({ ...common, event: "dispatch.requested" });
  } catch (err) {
    const reason = "状态写不进去，该闸未生效：" + ((err && err.message) || err);
    return deny(reason, { findings: [{ code: "state-unwritable", severity: "error", message: reason }] });
  }

  if (!role) {
    if (isCodeTeam) {
      const reason = "Code Team 派工的角色认不出来（agent_name 不在 team.json 里）—— 宁可误拒不可误放";
      return deny(reason, {
        findings: [{ code: "role-unresolved", severity: "error", message: reason }],
      });
    }
    return allow("非 Code Team 角色，不走派工闸门");
  }

  const briefLike = BRIEFLIKE_RE.test(briefText);

  // 归属清单（闸 2 的输入）：模块缺失就降级，调用方按「该闸未生效」处理。
  const own = await loadOwnership(d);
  const owned = own.extract ? own.extract(briefText) : null;

  // --- 标记闸：Code Team 的 worker 派工必须带 plan + package ----------------
  if (role.key === "worker" && tool === "task" && isCodeTeam) {
    if (!planId) {
      findings.push({
        code: "code-team-marker-missing",
        severity: "error",
        brief: packageId,
        message: "Code Team 派工缺少 code-team-plan 标记 —— 没有批次边界，无法判定归属互斥",
      });
    }
    if (!packageId) {
      findings.push({
        code: "code-team-marker-missing",
        severity: "error",
        brief: packageId,
        message: "Code Team 派工缺少 code-team-package 标记 —— 没有包号，无法判定归属互斥",
      });
    }
  }

  // --- 闸 1：编译闸（只有 worker 的交付包要编译证据） ----------------------
  if (role.key === "worker") {
    const cg = await loadCheck(d, "compileGate");
    if (!cg.fn) {
      findings.push({
        code: "module-degraded",
        severity: "error",
        brief: packageId,
        message: "该闸未生效：编译闸 " + cg.error,
      });
    } else {
      findings.push(...cg.fn({ projectRoot, briefs: [{ id: packageId, text: briefText }] }));
    }
  }

  // --- B：单包成本闸（只在本包已有可读的历史尝试时才有得判） ---------------
  const bm = role.key === "worker" ? await loadModule(d, "B") : null;
  let ledger = [];
  if (bm && bm.mod && typeof bm.mod.readLedgerEvents === "function") {
    ledger = bm.mod.readLedgerEvents();
  }
  // 账本里有这个包的执行尝试吗？（第一次派工还没有用量，属于正常放行）
  const hasPriorAttempt = Boolean(
    packageId &&
      [...ledger, ...events].some((e) => {
        const kind = e.kind || e.event || "";
        const isAttemptKind =
          kind === "call" ||
          kind === "dispatch" ||
          kind === "dispatch-result" ||
          kind === "dispatch.started" ||
          kind === "dispatch.settled";
        if (!isAttemptKind) return false;
        if (e.role && e.role !== "worker") return false;
        const id = e.packageId || e.task || e.packageId;
        return id === packageId;
      }),
  );
  if (role.key === "worker" && hasPriorAttempt) {
    if (!bm.mod) {
      findings.push({ code: "module-degraded", severity: "error", brief: packageId, message: "该闸未生效：B " + bm.error });
    } else {
      try {
        const bindings = bm.mod.readBindings([...ledger, ...events]).filter((b) => !packageId || b.packageId === packageId);
        // 有尝试却读不到绑定 = 计量缺失 = 不能放行（原来这里直接跳过了）。
        if (!bindings.length) {
          findings.push({
            code: "metering-missing-binding",
            severity: "error",
            brief: packageId,
            message: "该闸未生效：本包有历史尝试但读不到执行绑定 —— 用量无从计算，拒绝派工",
          });
        } else {
          const reader = d.reader || bm.mod.createMcpReader();
          let snapshot;
          try {
            snapshot = await withTimeout(
              bm.mod.readUsage({ projectKey, bindings, window: null, asOfMs: atMs, deadlineMs: atMs + 2500 }, reader),
              3000,
              "读取真实用量超时",
            );
          } finally {
            if (reader && typeof reader.close === "function") await reader.close();
          }
          const cost = bm.mod.evaluatePackageCost(snapshot, packageId);
          if (cost === "split" || cost === "resplit") {
            findings.push({
              code: "package-cost-" + cost,
              severity: "error",
              brief: packageId,
              message: "单包成本越界（" + cost + "）—— 按成本闸拆包后再派",
            });
          } else if (cost === "unknown") {
            // 用量未知不是「没问题」，是「没测到」：按拒签处理。
            findings.push({
              code: "metering-unknown",
              severity: "error",
              brief: packageId,
              message: "该闸未生效：本包真实用量未知（计量不完整或读不到记录）—— 拒绝派工",
            });
          } else {
            const pkg = snapshot && snapshot.packages ? snapshot.packages[packageId] : null;
            if (pkg && pkg.records === 0) {
              // 指定了不存在的 turn 时聚合会是 complete / 0 条记录 / continue —— 那是没测到，不是没问题。
              findings.push({
                code: "metering-missing",
                severity: "error",
                brief: packageId,
                message: "该闸未生效：本包读不到任何计量记录（目标 turn 不存在或记录为空）—— 拒绝派工",
              });
            } else if (!pkg || !pkg.usage) {
              findings.push({
                code: "metering-missing",
                severity: "error",
                brief: packageId,
                message: "该闸未生效：本包计量结果缺关键字段 —— 拒绝派工",
              });
            }
          }
        }
      } catch (err) {
        findings.push({ code: "module-degraded", severity: "error", brief: packageId, message: "该闸未生效：B " + ((err && err.message) || err) });
      }
    }
  }

  // --- C：撞墙后的续派闸（只对撞墙续派适用） -------------------------------
  // task_append 的真实入参只有 {task_id, content}，角色/包号/失败证据都从账本还原；
  // 还原不出来就 fail closed（宁可误拒不可误放），不能当成「不是我们的任务」放行。
  if (tool === "task_append" && (meta || isCodeTeam)) {
    const retryMarker = parseJsonMarker(bodyText, RETRY_RE);
    // 失败证据只认账本：提示词里的 failure / 批次 / 并发不算证据。
    const settled = (meta && meta.settled) || null;
    if (!settled) {
      findings.push({
        code: "continuation-no-failure-evidence",
        severity: "error",
        brief: packageId,
        message:
          "该闸未生效：账本里这个任务没有终结失败记录（task_id=" +
          (taskIdIn || "无") +
          "）—— 没有失败证据，拒绝续派",
      });
    }
    const cm = await loadModule(d, "C");
    if (!cm.mod) {
      findings.push({ code: "module-degraded", severity: "error", brief: packageId, message: "该闸未生效：C " + cm.error });
    } else {
      try {
        assertStateFileParses(join(stateDir, "retry-state.json"), "续派");
        // 账本还原：批次 / 原并发 / 工作树 / 基线 / 机器码 / 失败时刻。
        const batch = failedBatchFromLedger(events, meta);
        const failureEvidence = {
          protocolCode: batch.protocolCode,
          text: batch.failureText,
          observedAtMs: batch.failureAtMs,
          taskId: batch.taskId,
          childTurnId: batch.childTurnId,
          attemptId: batch.attemptId,
          childSessionId: (settled && settled.childSessionId) || null,
        };
        const failureKind = classifyFailureKind(cm.mod, failureEvidence);
        const evidence = {
          role: role.key,
          packageId,
          planId,
          attemptId: batch.attemptId,
          taskId: batch.taskId,
          childTurnId: batch.childTurnId,
          batchId: batch.batchId,
          failureKind,
          failureAtMs: batch.failureAtMs,
          protocolCode: batch.protocolCode,
          // 原 Worker 的工作树：账本里这次 attempt 记的，不是续派时主会话的 cwd。
          worktreePath: batch.worktreePath,
          baseCommit: batch.baseCommit,
          previousConcurrency: batch.previousConcurrency,
        };
        // git 取证自己先跑一遍：任何一条子命令失败都拒签，不折成「无变更」。
        const gitEvidence = collectGitEvidence(batch.worktreePath, batch.baseCommit);
        if (!gitEvidence.ok) {
          findings.push({
            code: "worktree-git-failed",
            severity: "error",
            brief: packageId,
            message:
              "该闸未生效：工作树取证失败（" +
              gitEvidence.error +
              "）—— git 失败不折成「无变更」，拒绝续派",
          });
        }
        const worktree = collectWorktreeEvidence(
          cm.mod,
          batch.worktreePath || projectRoot,
          batch.baseCommit || null,
          gitEvidence,
        );
        const continuationBrief =
          parseJsonMarker(bodyText, CONTINUATION_RE) || parseContinuationFromText(briefText);
        const payload = {
          stateFile: join(stateDir, "retry-state.json"),
          evidence,
          // 顶层也摊开一份：C 改成吃归一化证据后，两种形状都拿得到。
          ...evidence,
          request: {
            requestId: requestKey,
            packageIds: packageId ? [packageId] : [],
            concurrency: (retryMarker && retryMarker.concurrency) || 1,
            // 这三个只作交叉校验：与账本还原的批次对不上，C 会拒签。
            retryOfAttemptId: (retryMarker && retryMarker.retryOfAttemptId) || null,
            failedBatchId: (retryMarker && retryMarker.failedBatchId) || null,
            previousConcurrency: (retryMarker && retryMarker.previousConcurrency) || null,
          },
          failedBatch: {
            batchId: batch.batchId,
            protocolCode: batch.protocolCode,
            failureAtMs: batch.failureAtMs,
            attemptId: batch.attemptId,
            taskId: batch.taskId,
            childTurnId: batch.childTurnId,
            failureKind,
            affectedPackageIds: packageId ? [packageId] : [],
            previousConcurrency: batch.previousConcurrency,
            worktreePath: batch.worktreePath,
            baseCommit: batch.baseCommit,
          },
          worktreeEvidence: worktree,
          continuationBrief,
          nowMs: atMs,
        };
        const decision = await callRetryPolicy(cm.mod, payload);
        if (!decision || (decision.decision !== "allow" && decision.allowed !== true)) {
          findings.push({
            code: "retry-denied",
            severity: "error",
            brief: packageId,
            message: "续派被拒：" + ((decision && decision.reason) || "并发/落盘证据不满足续派条件"),
          });
        }
      } catch (err) {
        findings.push({ code: "module-degraded", severity: "error", brief: packageId, message: "该闸未生效：C " + ((err && err.message) || err) });
      }
    }
  }

  // --- E：验收闸（同一口径只放行一次，且必须落盘） -------------------------
  let verificationKey = null;
  // 只在 prompt 带了口径键标记时才进验收闸。
  if (role.key === "verifier" && VERIFICATION_KEY_RE.test(bodyText)) {
    const em = await loadModule(d, "E");
    if (!em.mod) {
      findings.push({ code: "module-degraded", severity: "error", brief: packageId, message: "该闸未生效：E " + em.error });
    } else {
      try {
        assertStateFileParses(join(stateDir, "verification-state.json"), "验收");
        const marker = em.mod.parseVerificationMarker(bodyText);
        const criteriaRevisionId = (marker && marker.criteriaRevisionId) || null;
        const criteriaChange = (marker && marker.criteriaChange) || null;
        const vPlanId = planId || (marker && marker.planId) || null;
        // 预期包集合：显式给 D 已发布的包集合；拿不到就按 E 的「未知」语义处理（不自行放行整批验收）。
        let expectedPackages = null;
        const dm = await loadModule(d, "D");
        if (dm.mod && typeof dm.mod.listPublishedPackages === "function" && vPlanId) {
          const list = dm.mod.listPublishedPackages({ planRevisionId: vPlanId });
          if (Array.isArray(list) && list.length) expectedPackages = list;
        }
        const decision = em.mod.decideAndPersistVerification({
          stateFile: join(stateDir, "verification-state.json"),
          request: {
            projectKey,
            planId: vPlanId,
            criteriaRevisionId,
            criteriaChange,
            requestKey,
            // 只有「终结成功」的包才算完成：预留 / 运行中 / 失败都不算。
            packageStates: packageStatesOfPlan(events, projectKey, vPlanId),
            ...(expectedPackages ? { expectedPackages } : {}),
            nowMs: atMs,
          },
        });
        if (!decision.allowed) {
          findings.push({
            code: "verification-denied",
            severity: "error",
            brief: packageId,
            message: "验收派工被拒：" + (decision.reason || "同一验收口径下已派过一次"),
          });
        } else {
          verificationKey = decision.verificationKey;
        }
      } catch (err) {
        findings.push({ code: "module-degraded", severity: "error", brief: packageId, message: "该闸未生效：E " + ((err && err.message) || err) });
      }
    }
  }

  // --- E：执行者自证（首轮 FAIL 后由执行者交证据，不重派 Verifier） ---------
  const selfMarker = parseJsonMarker(bodyText, SELF_EVIDENCE_RE);
  if (selfMarker) {
    const em = await loadModule(d, "E");
    if (!em.mod) {
      findings.push({
        code: "module-degraded",
        severity: "error",
        brief: packageId,
        message: "该闸未生效：E " + em.error,
      });
    } else {
      try {
        em.mod.recordAndPersistVerification({
          stateFile: join(stateDir, "verification-state.json"),
          action: "self-evidence",
          payload: {
            verificationKey: selfMarker.verificationKey,
            packageId: selfMarker.packageId || packageId,
            commands: selfMarker.commands || [],
            exitCodes: selfMarker.exitCodes || [],
            outputRefs: selfMarker.outputRefs || [],
            commit: selfMarker.commit || null,
            atMs,
          },
        });
      } catch (err) {
        findings.push({
          code: "module-degraded",
          severity: "error",
          brief: packageId,
          message: "该闸未生效：E 自证记录失败 —— " + ((err && err.message) || err),
        });
      }
    }
  }

  // --- 归属互斥 + 预留：同一把锁内完成，避免并发拿到冲突归属 ---------------
  let lockDir = null;
  try {
    lockDir = acquireLock(stateDir);
  } catch (err) {
    const reason = "拿不到派工状态锁，该闸未生效：" + ((err && err.message) || err);
    return deny(reason, { findings: [{ code: "state-lock-unavailable", severity: "error", message: reason }] });
  }

  try {
    let fresh;
    try {
      fresh = d.readEvents() || [];
    } catch (err) {
      const reason = "状态文件不可读，该闸未生效：" + ((err && err.message) || err);
      return deny(reason, { findings: [{ code: "state-unreadable", severity: "error", message: reason }] });
    }

    // 锁内再查一次重放：并发同请求不能预留两次。
    const priorLocked = findPriorDecision(fresh, requestKey);
    if (priorLocked) {
      return priorLocked.event === "dispatch.denied"
        ? deny(priorLocked.reason || "派工已被拒绝", { requestKey, replayed: true, findings: priorLocked.findings || [] })
        : allow("重放同一请求：沿用首次判定", {
            requestKey,
            replayed: true,
            updatedInput: priorLocked.updatedInput || null,
          });
    }

    // --- 闸 2：文件归属互斥（只在同一 plan 内比较） -------------------------
    if (role.key === "worker" && tool === "task" && (briefLike || isCodeTeam)) {
      if (!own.extract) {
        findings.push({
          code: "module-degraded",
          severity: "error",
          brief: packageId,
          message: "该闸未生效：归属检查 " + own.error,
        });
      } else {
        // 批次边界：只有两边都有 planId 且相等才算同批；
        // 历史条目没有 plan 标记，不参与比较。
        const siblings = fresh.filter(
          (e) =>
            e.event === "dispatch.reserved" &&
            e.projectKey === projectKey &&
            e.owned &&
            e.owned.length &&
            planId &&
            e.planId === planId &&
            e.packageId !== packageId,
        );
        const fo = await loadCheck(d, "fileOwnership");
        if (!fo.fn) {
          findings.push({
            code: "module-degraded",
            severity: "error",
            brief: packageId,
            message: "该闸未生效：归属检查 " + fo.error,
          });
        } else {
          findings.push(
            ...fo.fn({
              projectRoot,
              briefs: [{ id: packageId, text: briefText, owned }].concat(
                siblings.map((e) => ({ id: e.packageId || e.eventId, owned: e.owned })),
              ),
            }),
          );
        }
      }
    }

    if (findings.length) {
      const reason = findings.map((f) => f.message).join("\n");
      try {
        d.appendEvent({ ...common, event: "dispatch.denied", reason, findings });
      } catch { /* 记不动也不能放行 */ }
      return deny(reason, { requestKey, findings });
    }

    try {
      d.appendEvent({
        ...common,
        event: "dispatch.reserved",
        owned: owned && owned.length ? owned : null,
        verificationKey,
        // 重放要能恢复已验证正文，就得有地方存它。
        updatedInput: updatedInput || null,
      });
    } catch (err) {
      const reason = "预留写不进去，该闸未生效：" + ((err && err.message) || err);
      return deny(reason, { findings: [{ code: "state-unwritable", severity: "error", message: reason }] });
    }
    return allow("闸门通过", { requestKey, owned, updatedInput, verificationKey });
  } finally {
    releaseLock(lockDir);
  }
}

// 引用必须绑定同一项目、同一计划版本、同一包。
function checkRefBinding(events, { ref, verified, planId, packageId, projectKey }) {
  const refPlan = (ref && ref.planRevisionId) || (verified && verified.planRevisionId) || null;
  const refPackage = (ref && ref.packageId) || (verified && verified.packageId) || null;
  if (planId && refPlan && refPlan !== planId) {
    return "产物引用属于另一个计划版本（" + refPlan + " ≠ " + planId + "）";
  }
  if (packageId && refPackage && refPackage !== packageId) {
    return "产物引用属于另一个包（" + refPackage + " ≠ " + packageId + "）";
  }
  // 项目：同一计划版本在别的项目用过 → 不是本项目的引用。
  const prior = events.filter(
    (e) =>
      (e.event === "dispatch.requested" || e.event === "dispatch.reserved") &&
      e.briefPlanRevisionId &&
      refPlan &&
      e.briefPlanRevisionId === refPlan,
  );
  if (prior.some((e) => e.projectKey !== projectKey)) {
    return "该计划版本已用于另一个项目，引用不属于本项目";
  }
  const priorProject = prior.map((e) => e.briefProjectKey).filter(Boolean);
  const verifiedProject = (verified && verified.projectKey) || null;
  if (verifiedProject && priorProject.some((p) => p !== verifiedProject)) {
    return "产物引用属于另一个项目";
  }
  return null;
}

// 按工具实际的正文键注入：task → prompt；task_append → content（不加 prompt）。
function injectVerifiedBody(tool, toolInput, text) {
  const next = { ...toolInput };
  if (tool === "task_append") {
    delete next.prompt;
    next.content = text;
  } else {
    next.prompt = text;
  }
  return next;
}

// 失败类型：优先用 C 模块自己的分类器；C 改接口了就退回本地口径（只有 42212 算额度撞墙）。
function classifyFailureKind(cmod, evidence) {
  if (!evidence) return "unknown";
  if (typeof cmod.classifyFailure === "function") {
    try {
      // 不强行置 attemptMatched：C 的口径是「标识符自己证明」，调用方置 true 不算证据。
      const f = cmod.classifyFailure({ ...evidence });
      return f.kind || "unknown";
    } catch {
      /* 分类器坏了就退回本地口径 */
    }
  }
  const raw = evidence.protocolCode ?? evidence.errorCode ?? evidence.payload?.error?.code ?? null;
  if (raw === null || raw === undefined) return "unknown";
  return Number(raw) === 42212 ? "quota" : "failure";
}

// C 的入口名可能随 C 的改造变；这里按优先级找一个能用的，都找不到就当闸失效。
// 契约：hook 侧负责从账本还原归一化证据（role/packageId/planId/attemptId/batchId/
// failureKind/failureAtMs/worktreePath），C 侧只负责判定。
// decideAndPersist 吃整包 payload；evaluateRetry 吃归一化证据。
async function callRetryPolicy(cmod, payload) {
  if (typeof cmod.evaluateRetryEvidence === "function") return cmod.evaluateRetryEvidence(payload.evidence, payload);
  if (typeof cmod.decideAndPersist === "function") return cmod.decideAndPersist(payload);
  if (typeof cmod.evaluateRetry === "function") return cmod.evaluateRetry(payload);
  throw new Error("C 模块没有可用的续派判定入口");
}

// 续派书两段：从 prompt 里认「已落盘什么／没做什么」
function parseContinuationFromText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const take = (patterns) => {
    for (let i = 0; i < lines.length; i++) {
      if (!patterns.some((p) => p.test(lines[i]))) continue;
      const block = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) {
          if (block.length) break;
          continue;
        }
        block.push(lines[j]);
      }
      return block.join("\n").trim();
    }
    return "";
  };
  return {
    persistedWork: take([/已落盘/, /落盘情况/]),
    remainingWork: take([/没做什么/, /未做什么/, /未完成/, /剩余工作/]),
  };
}

// 验收的包完成证据：只有「终结成功」的包才算完成。
function packageStatesOfPlan(events, projectKey, planId) {
  const inPlan = (e) =>
    e.projectKey === projectKey && (!planId || !e.planId || e.planId === planId);
  const packages = new Set();
  for (const e of events) {
    if (e.event !== "dispatch.settled") continue;
    if (!inPlan(e)) continue;
    if (e.packageId) packages.add(e.packageId);
  }
  const out = [];
  for (const pkg of packages) {
    const settled = events
      .filter((e) => e.event === "dispatch.settled" && inPlan(e) && e.packageId === pkg)
      .pop();
    const outcome = settled ? String(settled.outcome || "").toLowerCase() : "";
    const ok = Boolean(settled) && !settled.failure && SUCCESS_OUTCOMES.has(outcome);
    out.push({
      packageId: pkg,
      status: ok ? "success" : outcome || (settled ? "failed" : "reserved"),
      attemptId: settled && settled.attemptId ? settled.attemptId : "",
    });
  }
  return out;
}

/* ------------------------------------------------------- PostToolUse -- */

/** PostToolUse：Task 回执 -> dispatch.started / dispatch.settled（拿不到就留空） */
export async function handlePostToolUse(input, deps = {}) {
  const stateDir = deps.stateDir || defaultStateDir();
  const d = {
    nowMs: () => Date.now(),
    readEvents: () => readEvents(stateDir),
    appendEvent: (rec) => appendEvent(stateDir, rec),
    ...deps,
  };
  const eventName = input && input.hook_event_name;
  if (eventName !== "PostToolUse") {
    const reason =
      "事件信封不对：本处理器只处理 PostToolUse（实际 " + (eventName || "无") + "）—— 判不了就拒签";
    return deny(reason, {
      findings: [{ code: "event-envelope-mismatch", severity: "error", message: reason }],
    });
  }
  const tool = input.tool_name;
  if (!tool) {
    const reason = "回执工具名缺失，判不了 —— 宁可误拒不可误放";
    return deny(reason, {
      findings: [{ code: "tool-name-missing", severity: "error", message: reason }],
    });
  }
  if (tool !== "task" && tool !== "task_append") return allow("不是派工工具");
  let events;
  try {
    events = d.readEvents() || [];
  } catch (err) {
    const reason = "状态文件不可读，回执未记账：" + ((err && err.message) || err);
    return deny(reason, { findings: [{ code: "state-unreadable", severity: "error", message: reason }] });
  }
  const toolUseId = input.tool_use_id || "";
  const prior = events
    .filter(
      (e) =>
        (e.event === "dispatch.requested" || e.event === "dispatch.reserved" || e.event === "dispatch.denied") &&
        e.sessionId === (input.session_id || null) &&
        e.toolUseId === toolUseId,
    )
    .pop();
  if (!prior) return allow("找不到对应的派工请求");
  const info = extractReceipt(input.tool_response);
  const common = {
    schemaVersion: 1,
    eventId: randomUUID(),
    atMs: d.nowMs(),
    projectKey: prior.projectKey,
    planRevisionId: prior.planRevisionId || null,
    planId: prior.planId || prior.planRevisionId || null,
    role: prior.role,
    backend: prior.backend || null,
    packageId: prior.packageId,
    attemptId: prior.attemptId || null,
    // 派工时的工作树 + 基线：续派取证要用它们，不是续派时主会话的 cwd。
    worktreePath: prior.worktreePath || null,
    baseCommit: prior.baseCommit || null,
    batchId: prior.batchId || null,
    isCodeTeam: prior.isCodeTeam === true,
    requestKey: prior.requestKey,
    sessionId: prior.session_id || prior.sessionId || null,
    toolUseId,
    toolName: tool,
    agentName: prior.agentName || null,
    taskId: prior.taskId || info.taskId || null,
  };
  try {
    if (info.taskId || info.childSessionId) {
      d.appendEvent({
        ...common,
        event: "dispatch.started",
        taskId: info.taskId || prior.taskId || null,
        childSessionId: info.childSessionId,
        childTurnId: info.childTurnId,
        verificationKey: prior.verificationKey || null,
      });
    }
    // 只有终结才写 settled：status=started 只是「开起来了」。
    if (info.terminal && (info.outcome || info.failure)) {
      const failureDetail = extractFailureDetails(input.tool_response);
      d.appendEvent({
        ...common,
        event: "dispatch.settled",
        outcome: info.outcome,
        // 失败证据必须能证明「是哪一次失败」：机器码 + 时刻 + attempt/turn 标识。
        failure: {
          ...(failureDetail.protocolCode !== null ? { protocolCode: failureDetail.protocolCode } : {}),
          ...(failureDetail.text ? { text: failureDetail.text } : {}),
          observedAtMs: d.nowMs(),
          attemptId: prior.attemptId || null,
          taskId: info.taskId || prior.taskId || null,
          childTurnId: info.childTurnId || null,
          childSessionId: info.childSessionId || null,
        },
        taskId: info.taskId || prior.taskId || null,
        childSessionId: info.childSessionId,
        childTurnId: info.childTurnId,
        observedAtMs: d.nowMs(),
      });
    }
  } catch (err) {
    const reason = "回执记账写不进去，该闸未生效：" + ((err && err.message) || err);
    return deny(reason, { findings: [{ code: "state-unwritable", severity: "error", message: reason }] });
  }
  // E：验收任务真的启动了 -> 占用名额
  if (prior.verificationKey && info.taskId) {
    const em = await loadModule(d, "E");
    if (!em.mod) {
      /* 降级：写进事件，不抛 */
    } else {
      try {
        em.mod.recordAndPersistVerification({
          stateFile: join(stateDir, "verification-state.json"),
          action: "started",
          payload: {
            verificationKey: prior.verificationKey,
            requestKey: prior.requestKey,
            taskId: info.taskId,
            childSessionId: info.childSessionId,
            atMs: d.nowMs(),
          },
        });
      } catch (err) {
        // 记账失败不能装作成功：Task 已经跑了，但要把原因交给宿主与主会话
        const reason = "该闸未生效：E 验收启动记账失败 —— " + ((err && err.message) || err);
        try {
          d.appendEvent({ ...common, event: "dispatch.degraded", degraded: [{ module: "E", reason }] });
        } catch { /* 记不动也不能放行 */ }
        return deny(reason, { findings: [{ code: "module-degraded", severity: "error", message: reason }] });
      }
    }
  }
  return allow("已记账", { info });
}

/** SubagentStop：验收结束 -> recordVerificationOutcome（判不出结论就不写） */
export async function handleSubagentStop(input, deps = {}) {
  const stateDir = deps.stateDir || defaultStateDir();
  const d = {
    nowMs: () => Date.now(),
    readEvents: () => readEvents(stateDir),
    ...deps,
  };
  const eventName = input && input.hook_event_name;
  if (eventName !== "SubagentStop") {
    const reason =
      "事件信封不对：本处理器只处理 SubagentStop（实际 " + (eventName || "无") + "）—— 判不了就拒签";
    return deny(reason, {
      findings: [{ code: "event-envelope-mismatch", severity: "error", message: reason }],
    });
  }
  let events;
  try {
    events = d.readEvents() || [];
  } catch {
    return allow("状态文件不可读，验收结论未落盘");
  }
  const message = String(input.last_assistant_message || "");
  const m = VERDICT_RE.exec(message);
  if (!m) return allow("没有验收结论标记，不记");
  // 证据引用：E 的口径是「空引用 = 无效结果」，所以必须从验收结论里取真实引用。
  const evidenceMarker = parseJsonMarker(message, EVIDENCE_RE);
  const outputRefs = evidenceMarker && Array.isArray(evidenceMarker.outputRefs)
    ? evidenceMarker.outputRefs.map(String).filter(Boolean)
    : [];
  const commands = evidenceMarker && Array.isArray(evidenceMarker.commands)
    ? evidenceMarker.commands.map(String).filter(Boolean)
    : [];
  // 退出码传原始值：null 被洗成 0 的话，E 就判不出「null 退出码」。
  const exitCodes = evidenceMarker && Array.isArray(evidenceMarker.exitCodes)
    ? [...evidenceMarker.exitCodes]
    : [];
  const agentId = input.agent_id || null;
  const started = events
    .filter((e) => e.event === "dispatch.started" && e.role === "verifier")
    .filter((e) => !agentId || !e.childSessionId || e.childSessionId === agentId)
    .pop();
  if (!started) return allow("找不到验收任务记录，不记");
  const em = await loadModule(d, "E");
  if (!em.mod) return allow("E 模块不可用，验收结论未落盘");
  // 证据不足就不记结论：E 的口径是「空引用 = 无效结果」，
  // 记了也只会把验收挂在 started 上，且 FAIL 缺命令会让后续自证永远判无效。
  if (!outputRefs.length) {
    process.stderr.write(
      "dispatch-hook: 验收结论没有真实证据引用（code-team-verification-evidence: {\"outputRefs\":[...]}），本次不落盘\n",
    );
    return allow("验收结论缺证据引用，未落盘");
  }
  if (m[1].toLowerCase() === "fail" && (!commands.length || !exitCodes.length)) {
    process.stderr.write(
      "dispatch-hook: FAIL 结论缺失败命令与退出码（code-team-verification-evidence 里带 commands/exitCodes），本次不落盘\n",
    );
    return allow("FAIL 结论缺命令与退出码，未落盘");
  }
  try {
    em.mod.recordAndPersistVerification({
      stateFile: join(stateDir, "verification-state.json"),
      action: "result",
      payload: {
        verificationKey: started.verificationKey,
        taskId: started.taskId,
        childSessionId: started.childSessionId,
        verdict: m[1].toLowerCase(),
        // FAIL 时必须带失败命令与退出码，否则执行者自证永远判无效。
        evidence: {
          outputRefs,
          ...(commands.length ? { commands } : {}),
          ...(exitCodes.length ? { exitCodes } : {}),
        },
        atMs: d.nowMs(),
      },
    });
  } catch (err) {
    return allow("验收结论落盘失败：" + ((err && err.message) || err));
  }
  return allow("验收结论已落盘");
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// PowerShell 管道给原生进程会带 UTF-8 BOM；不剥掉就会解析失败
function stripBom(text) {
  return String(text || "").replace(/^\uFEFF/, "").trim();
}

async function main() {
  const print = process.argv.includes("--print");
  let event = null;
  try {
    const raw = await readStdin();
    const text = stripBom(raw);
    let input = null;
    try {
      input = JSON.parse(text);
    } catch {
      input = null;
    }
    // 坏 JSON / 空对象 = 判不了 = 拒签（PreToolUse 的 exit 2 才是拦得住的那一种）。
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      // 只认 hook_event_name 这一个字段来决定走哪条路：
      // 正文里出现 SubagentStop 字样不算数（那会让坏输入被当成可放行）。
      const name = /"hook_event_name"\s*:\s*"([A-Za-z]+)"/.exec(text || "");
      if (name && name[1] === "SubagentStop") {
        // SubagentStop 不会创建任务；exit 2 是「让 agent 继续跑」，会成环，那一路只能 exit 0。
        process.stderr.write("dispatch-hook: stdin 不是 JSON（SubagentStop），本路径不拦\n");
        process.exit(0);
      }
      process.stderr.write("dispatch-hook: stdin 不是合法 JSON 对象，无法判定 —— 拒签\n");
      process.exit(2);
    }
    event = input.hook_event_name;
    currentEvent = event;
    // 事件名不认识 = 判不了 = 拒签（PreToolUse 的 exit 2 才是拦得住的那一种）
    if (event !== "PreToolUse" && event !== "PostToolUse" && event !== "SubagentStop") {
      process.stderr.write("dispatch-hook: hook_event_name 缺失或不认识，无法判定 —— 拒签\n");
      process.exit(2);
    }
    let reply;
    try {
      if (event === "PostToolUse") reply = await handlePostToolUse(input);
      else if (event === "SubagentStop") reply = await handleSubagentStop(input);
      else reply = await handleDispatchHook(input);
    } catch (err) {
      const reason = "该闸未生效：hook 内部异常（" + ((err && err.message) || err) + "）—— 宁可误拒不可误放";
      process.stderr.write(reason + "\n");
      // SubagentStop 的 exit 2 是「让 agent 继续跑」，会成环；那一路只能 exit 0。
      process.exit(event === "SubagentStop" ? 0 : 2);
    }
    if (print) {
      console.log(JSON.stringify(reply, null, 2));
      process.exit(0);
    }
    if (reply.decision === "deny") {
      process.stderr.write(String(reply.reason || "派工被拒绝").trim() + "\n");
      process.exit(2);
    }
    if (reply.updatedInput) {
      try {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: reply.updatedInput } }) + "\n",
        );
      } catch (err) {
        process.stderr.write("dispatch-hook: 注入正文写不出去（" + ((err && err.message) || err) + "）—— 拒签\n");
        process.exit(2);
      }
    }
    process.exit(0);
  } catch (err) {
    // 最外层：hook 自己出问题也不能用异常码退出（宿主只认 0 与 2）
    process.stderr.write("dispatch-hook: hook 自身异常（" + ((err && err.message) || err) + "）\n");
    process.exit(event === "SubagentStop" ? 0 : 2);
  }
}

// 进程级异常也要变成拒签信号：宿主把「hook 崩溃」按放行处理。
let currentEvent = null;
function failClosed(reason) {
  process.stderr.write("dispatch-hook: " + reason + "\n");
  process.exit(currentEvent === "SubagentStop" ? 0 : 2);
}
process.on("uncaughtException", (err) => failClosed("进程级异常（" + ((err && err.message) || err) + "）—— 拒签"));
process.on("unhandledRejection", (err) => failClosed("未处理的 Promise 拒绝（" + ((err && err.message) || err) + "）—— 拒签"));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
