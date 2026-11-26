#!/usr/bin/env node
// 执行侧真实用量的读取与单包成本判定。
//
// 为什么不用账本里的 usage：mcode-agent 侧写进 config/events.jsonl 的 usage 字段
// 100% 为 null，账本只能证明「派过几个包」，证明不了「花了多少」。
// 真实计量一直在本机官方插件 mcode-trajectory-studio 的只读投影里（2026-11-25 实测）。
//
// 口径（2026-11-25 实测校准，见 test/fixtures/trajectory-usage/）：
//   - 计量来源：官方 MCP 的 trajectory_get(summary) 逐条记录；
//   - 记录级 usage：inputTokens / outputTokens / cacheReadTokens / totalTokens，
//     totalTokens = inputTokens + outputTokens + cacheReadTokens；
//   - 会话级 Studio 汇总把 outputTokens 记作 decodeTokens，
//     其会话总额与逐条求和一致（P9 首跑：380 次调用 / 66,935,410 token）；
//   - 工具调用数 = 逐条记录 toolCallCount 之和（= 会话级 toolCalls）。
// 读不到就报 unknown，不用经验值兜底。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(ROOT, "config", "events.jsonl");

export const SOURCE = "mcode-trajectory-studio";
// Overmind 裁定的阈值：严格大于才触发，等于阈值不触发。
export const TOOL_CALL_LIMIT = 200;
export const TOKEN_LIMIT = 60_000_000;
export const DEFAULT_WINDOW_MS = 5 * 60 * 60 * 1000;

const COVERAGE_RANK = { complete: 2, partial: 1, unknown: 0 };

/* ------------------------------------------------------------------ 账本 -- */

/**
 * 读插件自己的事件账本（C 也在写这个文件，所以只读不写）。
 * 坏行不静默丢弃：标成 corrupt 事件，交给闸门把覆盖降为 unknown。
 */
export function readLedgerEvents(file = LEDGER) {
  if (!existsSync(file)) return [];
  const out = [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object") {
      out.push({ kind: "ledger.corrupt", corrupt: true, at: null, line: i + 1 });
      continue;
    }
    out.push(parsed);
  }
  return out;
}

// 宿主回执有两套字段名：插件自己写的 childSessionId，与宿主原生的
// sub_session_id / child_session_id（宿主归档 local-task.js 里的真字段）。
// 读取侧必须一起认：认不到绑定就等于拿不到计量，闸门会把「没测到」当成「没问题」。
const SESSION_ID_KEYS = ["childSessionId", "child_session_id", "sub_session_id", "subSessionId"];
const TURN_ID_KEYS = ["childTurnId", "child_turn_id", "sub_turn_id", "subTurnId"];
const PACKAGE_ID_KEYS = ["packageId", "package_id"];
const ATTEMPT_ID_KEYS = ["attemptId", "attempt_id"];

/** 在事件及其嵌套回执（tool_response / result）里找第一个非空字符串字段。 */
function findString(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const hit = findString(v, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 从账本里取出「逻辑包 → 执行子会话」的绑定。
 * 派工侧写下的事件带子会话/turn 标识（task_append 续派会复用同一个子会话），
 * 没有 packageId 时退回到事件里的任务描述，作为包标识。
 */
// 一次执行尝试的事件：派工请求 / 已启动 / 已终结（被拒的另算，没跑起来不产生用量）。
const ATTEMPT_EVENT_KINDS = new Set(["dispatch.requested", "dispatch.started", "dispatch.settled"]);

/**
 * 从账本里取出「逻辑包 → 执行子会话」的绑定。
 * 关键：按 attemptId 逐次核对 —— 一次尝试没有子会话绑定也要出现在结果里
 * （childSessionId 为 null），否则这次尝试的计量缺失会被静默吞掉。
 * 账本有坏行时，所有绑定标记为 corrupt：账本不可信 ⇒ 覆盖降为 unknown。
 */
export function readBindings(events) {
  const entries = new Map(); // key -> 绑定记录（按出现顺序）
  const denied = new Set();  // 被拒的派工：没跑起来，不算一次尝试
  let corrupt = false;

  for (const e of events || []) {
    if (!e || typeof e !== "object") continue;
    if (e.corrupt === true) { corrupt = true; continue; }
    const kind = e.kind || e.event || null;
    const attemptId = findString(e, ATTEMPT_ID_KEYS);
    if (attemptId && kind === "dispatch.denied") { denied.add(attemptId); continue; }
    const childSessionId = findString(e, SESSION_ID_KEYS);
    const childTurnId = findString(e, TURN_ID_KEYS);
    const packageId = findString(e, PACKAGE_ID_KEYS) || e.task || null;
    const atMs = eventTime(e);
    if (attemptId && ATTEMPT_EVENT_KINDS.has(kind)) {
      // 一次尝试 = 一个 attemptId：请求/启动/终结三条记录合并成一条。
      const key = "a:" + attemptId;
      const rec = entries.get(key) || {
        packageId, attemptId, childSessionId: null, childTurnId: null, taskId: e.taskId || null, atMs,
      };
      if (packageId && !rec.packageId) rec.packageId = packageId;
      if (childSessionId && !rec.childSessionId) {
        rec.childSessionId = childSessionId;
        rec.childTurnId = childTurnId;
      }
      if (rec.atMs === null) rec.atMs = atMs;
      entries.set(key, rec);
      continue;
    }
    if (!childSessionId) continue; // 没有子会话就不是绑定
    const key = "b:" + [packageId, childSessionId, childTurnId].join("|");
    if (entries.has(key)) continue;
    entries.set(key, { packageId, attemptId, childSessionId, childTurnId, taskId: e.taskId || null, atMs });
  }

  const out = [];
  for (const [key, rec] of entries) {
    if (key.startsWith("a:") && denied.has(rec.attemptId)) continue;
    out.push(corrupt ? { ...rec, corrupt: true } : rec);
  }
  return out;
}

/** 事件时刻：hook 事件用 atMs，账本行用 at（ISO 字符串）。 */
function eventTime(e) {
  if (typeof e.atMs === "number" && Number.isFinite(e.atMs)) return e.atMs;
  if (typeof e.at === "string") {
    const t = Date.parse(e.at);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/* ------------------------------------------------------------ 计量口径 -- */

function blankUsage() {
  return { inputTokens: 0, cacheReadTokens: 0, decodeTokens: 0, totalTokens: 0, toolCalls: 0 };
}

/** 记录级 usage → 守卫口径。outputTokens 即 Studio 汇总里的 decodeTokens。 */
function recordUsage(record) {
  const u = record && record.usage ? record.usage : null;
  const inputTokens = u && typeof u.inputTokens === "number" ? u.inputTokens : 0;
  const decodeTokens = u && typeof u.outputTokens === "number" ? u.outputTokens : 0;
  const cacheReadTokens = u && typeof u.cacheReadTokens === "number" ? u.cacheReadTokens : 0;
  const totalTokens = u && typeof u.totalTokens === "number"
    ? u.totalTokens
    : inputTokens + decodeTokens + cacheReadTokens;
  return { inputTokens, cacheReadTokens, decodeTokens, totalTokens };
}

function addUsage(target, record) {
  const u = recordUsage(record);
  target.inputTokens += u.inputTokens;
  target.cacheReadTokens += u.cacheReadTokens;
  target.decodeTokens += u.decodeTokens;
  target.totalTokens += u.totalTokens;
  // 缺调用次数是缺值，不是零：记成 null（未知）；null 一旦出现就粘住，不能再当数字累加。
  const calls = record && typeof record.toolCallCount === "number"
    ? record.toolCallCount
    : (missingCallCount(record) ? null : 0);
  if (calls === null) target.toolCalls = null;
  else if (target.toolCalls !== null) target.toolCalls += calls;
  return target;
}

// 缺值（null）不能当 0 累加：一处缺值，合计也是缺值。
function sumKnown(a, b) {
  return a === null || b === null ? null : a + b;
}

function worstCoverage(a, b) {
  return COVERAGE_RANK[a] <= COVERAGE_RANK[b] ? a : b;
}

// 记录级 usage 的关键字段：缺一个就不能当成 0 记账。
const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "totalTokens"];

/**
 * 一条记录是否「本该有计量」：助手消息都带 usage，用户消息不带；
 * usage 对象在、但关键字段缺了也算缺 —— 缺字段不能当 0 记账。
 */
function expectsUsage(record) {
  if (!record) return false;
  const u = record.usage;
  if (!u || typeof u !== "object") {
    return record.role === "assistant" || (record.toolCallCount || 0) > 0;
  }
  return USAGE_FIELDS.some((f) => typeof u[f] !== "number");
}

/**
 * 调用次数是否「缺值」：这条记录本该带 toolCallCount 却没有。
 * 用户消息本来就没有工具调用，不算缺值；其余（带 usage 的 / 助手消息）缺了就是缺值。
 */
function missingCallCount(record) {
  if (!record) return false;
  if (typeof record.toolCallCount === "number") return false;
  if (record.role === "user") return false;
  const u = record.usage;
  if (u && typeof u === "object") return true;
  return record.role === "assistant";
}

/** 同一会话里 msgId 重复时只留最新的一条（按 rowId / createdAtMs）。 */
function dedupeRecords(records) {
  const byKey = new Map();
  for (const r of records || []) {
    const key = r && r.msgId ? r.msgId : "row:" + (r && r.rowId != null ? r.rowId : String(byKey.size));
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, r); continue; }
    const newer = (r.rowId ?? 0) > (prev.rowId ?? 0)
      || ((r.rowId ?? 0) === (prev.rowId ?? 0) && (r.createdAtMs ?? 0) >= (prev.createdAtMs ?? 0));
    if (newer) byKey.set(key, r);
  }
  return [...byKey.values()];
}

/** 覆盖度：unknown = 没测到；partial = 测到但不全；complete = 齐全。 */
function coverageOf(records, { error, warnings, pageTruncated }) {
  if (error) return "unknown";
  if (!records || records.length === 0) return "unknown";
  if (pageTruncated) return "partial";
  if (warnings && warnings.length) return "partial";
  // 调用次数字段缺失 = 缺值：不能当 0 记账，覆盖降为 unknown。
  if (records.some(missingCallCount)) return "unknown";
  if (records.some(expectsUsage)) return "partial";
  return "complete";
}

/**
 * 一次尝试是否落在窗口内：时间不明的按在窗口内处理（宁可误拒不可误放）。
 * 窗口只决定「哪些记录进窗口用量」，不放松逐尝试核对 —— 缺绑定的尝试照样拉 unknown。
 */
function attemptInWindow(attempt, win) {
  if (!win) return true;
  const at = attempt && typeof attempt.atMs === "number" && Number.isFinite(attempt.atMs) ? attempt.atMs : null;
  if (at === null) return true;
  return at >= win.fromMs && at < win.toMs;
}

/* ------------------------------------------------------------ 读取计量 -- */

/**
 * 读取绑定子会话的计量并汇总成快照。
 *
 * @param {{projectKey?:string, bindings?:Array, window?:object, asOfMs?:number, deadlineMs?:number}} options
 * @param {{readSession:Function}} reader 读一个子会话的记录；测试可替换
 * @returns {Promise<object>} UsageSnapshot
 */
export async function readUsage(
  { projectKey = null, bindings = [], window = null, asOfMs = Date.now(), deadlineMs = null } = {},
  reader,
) {
  if (!reader || typeof reader.readSession !== "function") {
    throw new Error("readUsage 需要 reader.readSession");
  }
  const win = normalizeWindow(window, asOfMs);
  const packages = {};
  const warnings = [];
  const sessions = new Map(); // childSessionId -> { records, coverage, summary, error }

  const loadSession = async (childSessionId) => {
    if (sessions.has(childSessionId)) return sessions.get(childSessionId);
    const result = await reader.readSession({ childSessionId, deadlineMs });
    const records = dedupeRecords(result && result.records);
    const pageTruncated = Boolean(result && (result.truncated || result.omitted));
    const entry = {
      records,
      error: (result && result.error) || null,
      warnings: (result && result.warnings) || [],
      summary: (result && result.summary) || null,
      pageTruncated,
      coverage: coverageOf(records, {
        error: (result && result.error) || null,
        warnings: (result && result.warnings) || [],
        pageTruncated,
      }),
    };
    sessions.set(childSessionId, entry);
    return entry;
  };

  for (const binding of bindings || []) {
    const packageId = binding && binding.packageId ? binding.packageId : null;
    const childSessionId = binding && binding.childSessionId ? binding.childSessionId : null;
    if (!packageId) { warnings.push("binding_without_package_id:" + (childSessionId || "unknown")); continue; }
    const pkg = packages[packageId] || (packages[packageId] = {
      packageId,
      coverage: "unknown",
      usage: blankUsage(),
      windowUsage: blankUsage(),
      attempts: [],
      warnings: [],
      sessionIds: [],
      corrupt: false,
    });
    // 账本有坏行 = 账本不可信：这个包的计量不能当完整。
    if (binding && binding.corrupt) pkg.corrupt = true;
    // 有尝试但没有绑定 ⇒ 这次尝试的计量缺失，必须让闸门看见（不能静默跳过）。
    if (!childSessionId) {
      const reason = "attempt_without_binding:" + packageId + ":" + ((binding && binding.attemptId) || "unknown");
      pkg.warnings.push(reason);
      warnings.push(reason);
      pkg.attempts.push({
        attemptId: (binding && binding.attemptId) || null,
        childSessionId: null,
        childTurnId: null,
        atMs: (binding && binding.atMs) ?? null,
        bound: false,
        coverage: "unknown",
        usage: blankUsage(),
        sessionTotals: null,
      });
      continue;
    }

    const session = await loadSession(childSessionId);
    if (session.error) {
      const reason = "session_read_failed:" + childSessionId + ":" + session.error;
      pkg.warnings.push(reason);
      warnings.push(reason);
    }
    for (const w of session.warnings) {
      pkg.warnings.push(w);
    }
    const scoped = binding.childTurnId
      ? session.records.filter((r) => r && r.turnId === binding.childTurnId)
      : session.records;

    // 指定了目标 turn 却一条记录都没有 = 查不到这次尝试，不是「用量为零」。
    if (binding.childTurnId && scoped.length === 0) {
      const reason = "target_turn_not_found:" + childSessionId + ":" + binding.childTurnId;
      pkg.warnings.push(reason);
      warnings.push(reason);
    }

    const attemptUsage = blankUsage();
    for (const r of scoped) addUsage(attemptUsage, r);
    pkg.attempts.push({
      attemptId: binding.attemptId || null,
      childSessionId,
      childTurnId: binding.childTurnId || null,
      atMs: binding.atMs ?? null,
      bound: true,
      coverage: coverageOf(scoped, {
        error: session.error,
        warnings: session.warnings,
        pageTruncated: session.pageTruncated,
      }),
      usage: attemptUsage,
      sessionTotals: session.summary
        ? {
          toolCalls: session.summary.toolCalls ?? null,
          totalTokens: session.summary.totalTokens ?? null,
          inputTokens: session.summary.inputTokens ?? null,
          cacheReadTokens: session.summary.cacheReadTokens ?? null,
          decodeTokens: session.summary.decodeTokens ?? null,
        }
        : null,
    });

    if (!pkg.sessionIds.includes(childSessionId)) pkg.sessionIds.push(childSessionId);
  }

  // 包级汇总：跨尝试取唯一记录（同一子会话被 task_append 复用时只计一次）。
  for (const pkg of Object.values(packages)) {
    const union = new Map();
    let coverage = "complete";
    let seenAny = false;
    for (const attempt of pkg.attempts) {
      // 逐尝试核对：每一次尝试都要有可读计量；没绑定的也算一次尝试（拉成 unknown）。
      seenAny = true;
      coverage = worstCoverage(coverage, attempt.coverage);
      const session = attempt.bound ? sessions.get(attempt.childSessionId) : null;
      if (!session) continue;
      const scoped = attempt.childTurnId
        ? session.records.filter((r) => r && r.turnId === attempt.childTurnId)
        : session.records;
      for (const r of scoped) {
        const key = attempt.childSessionId + "|" + (r.msgId || "row:" + (r.rowId ?? union.size));
        union.set(key, r);
      }
    }
    if (!seenAny) coverage = "unknown";
    // 账本有坏行 = 账本不可信 = 这个包的计量不能当完整。
    if (pkg.corrupt) coverage = "unknown";
    pkg.coverage = coverage;
    pkg.usage = blankUsage();
    pkg.windowUsage = blankUsage();
    for (const r of union.values()) {
      addUsage(pkg.usage, r);
      const at = r.createdAtMs ?? null;
      if (at !== null && win && at >= win.fromMs && at < win.toMs) addUsage(pkg.windowUsage, r);
    }
    pkg.records = union.size;
    delete pkg.sessionIds;
  }

  const projectUsage = blankUsage();
  const projectWindowUsage = blankUsage();
  let projectCoverage = "complete";
  let anyPackage = false;
  for (const pkg of Object.values(packages)) {
    anyPackage = true;
    projectCoverage = worstCoverage(projectCoverage, pkg.coverage);
    for (const k of Object.keys(projectUsage)) {
      projectUsage[k] = sumKnown(projectUsage[k], pkg.usage[k]);
      projectWindowUsage[k] = sumKnown(projectWindowUsage[k], pkg.windowUsage[k]);
    }
  }
  if (!anyPackage) projectCoverage = "unknown";

  return {
    source: SOURCE,
    observedAtMs: Date.now(),
    projectKey,
    window: win,
    coverage: projectCoverage,
    packages,
    usage: {
      source: SOURCE,
      observedAtMs: Date.now(),
      coverage: projectCoverage,
      scope: "project",
      projectKey,
      packageId: null,
      attemptId: null,
      childSessionId: null,
      childTurnId: null,
      ...projectUsage,
    },
    windowUsage: {
      source: SOURCE,
      observedAtMs: Date.now(),
      coverage: projectCoverage,
      scope: "project",
      projectKey,
      packageId: null,
      attemptId: null,
      childSessionId: null,
      childTurnId: null,
      ...projectWindowUsage,
    },
    warnings,
  };
}

function normalizeWindow(window, asOfMs) {
  if (!window) return { fromMs: asOfMs - DEFAULT_WINDOW_MS, toMs: asOfMs };
  if (typeof window.fromMs === "number" && typeof window.toMs === "number") {
    return { fromMs: window.fromMs, toMs: window.toMs };
  }
  const ms = typeof window.ms === "number" ? window.ms : DEFAULT_WINDOW_MS;
  return { fromMs: asOfMs - ms, toMs: asOfMs };
}

/* ------------------------------------------------------------ 成本判定 -- */

/**
 * 单包成本闸：>200 次工具调用要求拆包，>60,000,000 token 要求重新拆包，
 * 两者同时越界保留重拆结论。计量缺失或不完整时返回 unknown，不签发放行。
 */
export function evaluatePackageCost(snapshot, packageId) {
  const pkg = snapshot && snapshot.packages ? snapshot.packages[packageId] : null;
  if (!pkg || !pkg.usage) return "unknown";
  const { totalTokens, toolCalls } = pkg.usage;
  if (typeof totalTokens === "number" && totalTokens > TOKEN_LIMIT) return "resplit";
  if (typeof toolCalls === "number" && toolCalls > TOOL_CALL_LIMIT) return "split";
  // 逐尝试核对：每一次尝试都必须有绑定且计量完整，否则这个包的结论是 unknown。
  for (const attempt of pkg.attempts || []) {
    if (attempt.bound === false) return "unknown";
    if (attempt.coverage && attempt.coverage !== "complete") return "unknown";
  }
  if (pkg.coverage !== "complete") return "unknown";
  return "continue";
}

/* --------------------------------------------------------- MCP 只读读取 -- */

/** 找到本机官方插件 mcode-trajectory-studio 的目录（只读定位，不写死路径）。 */
export function resolveStudioServerRoot() {
  const override = process.env.MCODE_TRAJECTORY_STUDIO_ROOT;
  if (override && existsSync(join(override, "server", "main.mjs"))) return resolve(override);
  const minimaxHome = resolve(ROOT, "..", "..");
  const bases = [
    join(minimaxHome, "v2", "plugin-cache", "official"),
    join(minimaxHome, "plugin-cache", "official"),
  ];
  const fallback = [];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    let entries = [];
    try { entries = readdirSync(base); } catch { continue; }
    for (const entry of entries) {
      const dir = join(base, entry);
      if (!existsSync(join(dir, "server", "main.mjs"))) continue;
      const manifest = join(dir, ".minimax-plugin", "plugin.json");
      if (existsSync(manifest)) {
        try {
          if (JSON.parse(readFileSync(manifest, "utf8")).name === "mcode-trajectory-studio") return dir;
        } catch { /* 清单读不了就当不是目标插件 */ }
      }
      fallback.push(dir);
    }
  }
  return fallback[0] || null;
}

/**
 * 找到运行时数据目录（Studio 只读投影所在处）。
 * 服务端默认按 HOME/.minimax 找，但插件目录本身就住在数据目录里（<dataDir>/plugins/<plugin>），
 * 所以优先用插件根推导出来的目录，免得在 USERPROFILE 指向别处的机器上读到空库。
 */
export function resolveRuntimeDataDir() {
  const fromEnv = process.env.MINIMAX_DATA_DIR || process.env.MAVIS_DATA_DIR;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const candidate = resolve(ROOT, "..", "..");
  if (existsSync(join(candidate, "v2", "sqlite")) || existsSync(join(candidate, "v2", "sessions"))) {
    return candidate;
  }
  return null;
}

/**
 * deadline 归一：既接受绝对 epoch ms（宿主传 atMs + 2500），也接受相对毫秒（100 = 100ms）。
 * 小于 1e12 视为相对时长（1e12ms 约为 2001 年），否则视为绝对截止时刻。
 */
export function resolveDeadline(deadlineMs) {
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs)) return null;
  if (deadlineMs <= 0) return Date.now();
  return deadlineMs < 1e12 ? Date.now() + deadlineMs : deadlineMs;
}

/**
 * 通过官方 MCP server 的 stdio JSON-RPC 读取子会话计量（只读）。
 * 帧格式：每行一个 JSON对象（NDJSON），initialize → notifications/initialized → tools/call。
 */
export function createMcpReader({
  serverRoot = resolveStudioServerRoot(),
  nodeBin = process.execPath,
  dataDir = resolveRuntimeDataDir(),
} = {}) {
  let child = null;
  let lines = null;
  const pending = new Map();
  let nextId = 1;
  let killOnExit = null;
  let failed = null;      // 一旦超时/失败，这个 reader 就废了：不再重连。
  let deadlineAt = null;  // 本次调用的绝对截止时刻（epoch ms）

  // 到期或子进程退出：全部 pending 拒掉 + 杀子进程 + 拆管道，不留悬挂 promise。
  function abortAll(reason) {
    for (const [, p] of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
    const c = child;
    child = null;
    if (lines) { try { lines.close(); } catch { /* 已关 */ } lines = null; }
    if (killOnExit) { process.removeListener("exit", killOnExit); killOnExit = null; }
    if (!c) return;
    try { c.kill("SIGKILL"); } catch { /* 已退出 */ }
    for (const s of [c.stdin, c.stdout, c.stderr]) { try { s && s.destroy(); } catch { /* 忽略 */ } }
  }

  async function ensure() {
    if (failed) throw new Error(failed);
    if (child) return;
    if (!serverRoot) throw new Error("找不到 mcode-trajectory-studio 的 server/main.mjs");
    child = spawn(nodeBin, [join(serverRoot, "server", "main.mjs")], {
      cwd: serverRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: dataDir ? { ...process.env, MINIMAX_DATA_DIR: dataDir } : process.env,
    });
    child.on("error", (err) => {
      failed = "mcp_spawn_failed:" + err.message;
      abortAll(failed);
    });
    // 子进程自己退出：pending 必须拒掉，不然调用方永远等着。
    child.on("exit", () => {
      if (!pending.size) return;
      abortAll("mcp_server_exited");
    });
    // 不吊住父进程：调用方忘了 close（异常/超时路径）时，父进程也得能自然退出。
    // 请求在途时再 ref 回来（见 request），否则读不到 MCP 响应。
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr]) {
      if (s && typeof s.unref === "function") s.unref();
    }
    // 父进程先走时带走子进程：否则它被孤儿化，会一直活到机器重启。
    killOnExit = () => { try { if (child) child.kill("SIGKILL"); } catch { /* 已经没了 */ } };
    process.once("exit", killOnExit);
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (!pending.size && child) child.unref();
      if (msg.error) entry.reject(new Error(msg.error.message || "mcp_error"));
      else entry.resolve(msg.result);
    });
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "code-team", version: "1.1.0" },
    });
    notify("notifications/initialized", {});
  }

  function request(method, params) {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      if (failed) { reject(new Error(failed)); return; }
      if (!child) { reject(new Error("mcp_closed")); return; }
      const entry = { resolve, reject, timer: null };
      pending.set(id, entry);
      // deadline 真正生效：到点就中止这次请求，并把整个 reader 拆掉。
      if (deadlineAt !== null) {
        const remain = deadlineAt - Date.now();
        if (remain <= 0) {
          pending.delete(id);
          failed = "mcp_deadline_exceeded";
          abortAll(failed);
          reject(new Error(failed));
          return;
        }
        // 定时器不能 unref：到期必须真的触发，请求才能返回错误。
        entry.timer = setTimeout(() => {
          failed = "mcp_deadline_exceeded";
          abortAll(failed);
        }, remain);
      }
      child.ref();   // 请求在途：事件循环必须活着，否则读不到响应
      child.stdin.write(payload);
    });
  }

  function notify(method, params) {
    if (!child) return;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async function callTool(name, args) {
    const result = await request("tools/call", { name, arguments: args });
    if (result && result.isError) {
      const text = result.content && result.content[0] ? result.content[0].text : "tool_error";
      throw new Error(text);
    }
    const text = result && result.content && result.content[0] ? result.content[0].text : null;
    if (!text) throw new Error("empty_tool_result");
    return JSON.parse(text);
  }

  return {
    async readSession({ childSessionId, deadlineMs }) {
      // deadline 覆盖 initialize 与所有工具调用：到点就中止，不许挂着。
      deadlineAt = resolveDeadline(deadlineMs);
      try {
        await ensure();
        const records = [];
        const warnings = [];
        let offset = 0;
        let truncated = false;
        let omitted = 0;
        for (;;) {
          const page = await callTool("trajectory_get", {
            sessionId: childSessionId,
            offset,
            limit: 1000,
            detailLevel: "summary",
          });
          for (const e of page.events || []) {
            records.push({
              msgId: e.msgId ?? null,
              rowId: e.rowId ?? null,
              turnId: e.turnId ?? null,
              role: e.role ?? null,
              createdAtMs: e.createdAtMs ?? null,
              // 缺失的调用次数保持 null：缺值不能当 0（0 是「真的没有调用」）。
              toolCallCount: typeof e.toolCallCount === "number" ? e.toolCallCount : null,
              usage: e.usage ?? null,
            });
          }
          for (const w of page.warnings || []) warnings.push(w);
          if (page.truncated) truncated = true;
          if (page.omitted) omitted += page.omitted;
          if (page.nextOffset == null) break;
          offset = page.nextOffset;
        }
        let summary = null;
        try {
          summary = await callTool("trajectory_summary", { sessionId: childSessionId });
        } catch (err) {
          warnings.push("summary_unavailable:" + err.message);
        }
        if (summary && summary.recordsUnavailable) warnings.push("records_unavailable");
        if (summary && summary.sqlite === false) warnings.push("no_sqlite_projection");
        if (summary && summary.unreadableRows) warnings.push("unreadable_rows:" + summary.unreadableRows);
        for (const w of (summary && summary.warnings) || []) warnings.push(w);
        return { records, warnings, summary, truncated, omitted };
      } catch (err) {
        return { records: [], warnings: [], error: String(err && err.message ? err.message : err) };
      }
    },
    async close() {
      const c = child;
      child = null;
      if (lines) { try { lines.close(); } catch { /* 已经关了 */ } lines = null; }
      if (killOnExit) { process.removeListener("exit", killOnExit); killOnExit = null; }
      for (const [, p] of pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error("mcp_closed"));
      }
      pending.clear();
      deadlineAt = null;
      if (!c) return;
      try { c.kill(); } catch { /* 已经退出 */ }
      try { c.kill("SIGKILL"); } catch { /* 已经退出 */ }
      for (const s of [c.stdin, c.stdout, c.stderr]) { try { s && s.destroy(); } catch { /* 忽略 */ } }
    },
    get pid() { return child ? child.pid : null; },
  };
}

/* -------------------------------------------------------------- CLI -- */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const argv = process.argv.slice(2);
  const binds = [];
  let asOf = Date.now();
  let project = null;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--bind" && argv[i + 1]) {
      const [packageId, childSessionId] = String(argv[++i]).split("=");
      binds.push({ packageId, childSessionId });
    } else if (token === "--as-of" && argv[i + 1]) {
      asOf = Number(argv[++i]);
    } else if (token === "--project" && argv[i + 1]) {
      project = argv[++i];
    }
  }
  const reader = createMcpReader();
  const snapshot = await readUsage(
    { projectKey: project, bindings: binds, window: { fromMs: asOf - DEFAULT_WINDOW_MS, toMs: asOf }, asOfMs: asOf },
    reader,
  );
  await reader.close();
  console.log(JSON.stringify(snapshot, null, 2));
  for (const [id, pkg] of Object.entries(snapshot.packages)) {
    console.error(id + " → " + evaluatePackageCost(snapshot, id)
      + "  toolCalls=" + pkg.usage.toolCalls + " totalTokens=" + pkg.usage.totalTokens
      + " coverage=" + pkg.coverage);
  }
}
