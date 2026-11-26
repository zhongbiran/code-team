#!/usr/bin/env node
// 派工前的额度守卫：算出「还能并行开几个 Worker」，避免整批撞 Token Plan 上限。
//
// 原因（2026-11-24 实测）：RC.DustFall 一次开 9 个 Worker，后 3 个撞上限被杀，
// 续跑又要再花 1000~3000s —— 同一份活干两遍，比慢更贵。
//
// 2026-11-25 修正：旧版把「近 5 小时派工包数 / 12」当成窗口占用百分比，
// 并把账本里缺失的 usage 当 0 打印，两者都不是真实用量。
// 现在窗口用量与单包成本都取自本机官方插件 mcode-trajectory-studio 的只读计量；
// 取不到就写「未知」，不再用经验值冒充。
//
// 2026-11-25 再修正（独立验收 FAIL）：计量未知仍然放行。
// 现在放行依据只有一条：本次涉及的包的真实计量已核对且完整。
// 经验并发数只作分批参考，不当放行依据。
//
// 用法：
//   node scripts/dispatch-guard.mjs --plan 9                       # 计划并行开 9 个包 → 打印建议并发度
//   node scripts/dispatch-guard.mjs --plan 9 --budget              # 附带账本侧用量明细
//   node scripts/dispatch-guard.mjs --plan 1 --pkg P9               # 点名本次涉及的包（首次派工也要点名）
//   node scripts/dispatch-guard.mjs --plan 1 --bind P9=<子会话ID>   # 绑定执行会话，读真实计量并判定单包成本
//
// 退出码：0 = 可以按计划开；2 = 拒签（单包越界 / 计量未知 / 建议降并发）
import { pathToFileURL } from "node:url";
import {
  DEFAULT_WINDOW_MS,
  TOKEN_LIMIT,
  TOOL_CALL_LIMIT,
  createMcpReader,
  evaluatePackageCost,
  readBindings,
  readLedgerEvents,
  readUsage,
} from "./trajectory-usage.mjs";

// 账本里同一条派工记录有两种 kind 拼法：旧记录器写的 "call"，
// 和 record-event.mjs 新增 --kind 后写的 "dispatch"。
// 两种都算，否则新写入的派工事件被完全漏统计，窗口占用被低估。
export const EXECUTION_KINDS = new Set(["call", "dispatch"]);

// 出现过执行尝试的 kind：这些包「应有计量」。
const ATTEMPT_KINDS = new Set(["call", "dispatch", "dispatch-result", "dispatch.started", "dispatch.settled"]);

/**
 * 统计 5 小时窗口里的执行侧事件与已派 worker 包数。
 * 只认 worker/explore（Codex 规划侧走另一套额度），包数按任务去重。
 */
export function countWindowPackages(events, { asOf = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  const recent = events.filter(e => {
    if (!EXECUTION_KINDS.has(e.kind)) return false;
    if (!e.role || !/^(worker|explore)$/.test(e.role)) return false;
    const t = new Date(e.at).getTime();
    return asOf - t < windowMs;
  });
  // 经验值：一次 Worker 包平均 2~4 次事件（dispatch + dispatch-result），失败重试再多 1~2 次。
  // 这里用"包数"而不是"事件数"更准：dispatch 事件是每个包 1 条。
  const dispatched = new Set(recent.filter(e => e.role === "worker").map(e => e.task)).size;
  return { recent, dispatched };
}

/**
 * 账本里出现过执行尝试的包（包号 -> 尝试次数）。
 * 判据（references/budget-policy.md）：这些包「应有计量」，
 * 拿不到计量就得拒签；没有出现在这里的包是第一次派工，不属于未知。
 */
export function collectAttemptPackages(events) {
  const out = new Map();
  for (const e of events || []) {
    if (!e || typeof e !== "object") continue;
    if (!ATTEMPT_KINDS.has(e.kind)) continue;
    if (e.role !== "worker") continue;
    const id = e.packageId || e.task;
    if (!id) continue;
    const prev = out.get(id) || { count: 0, lastAt: null };
    prev.count += 1;
    if (e.at && (!prev.lastAt || e.at > prev.lastAt)) prev.lastAt = e.at;
    out.set(id, prev);
  }
  return out;
}

/**
 * 合并显式绑定与账本绑定。
 * 缺 childSessionId 的尝试也要保留：那次尝试的计量缺失，必须让闸门看见，不能静默丢掉。
 */
export function collectBindings(explicitBindings = [], events = []) {
  const out = [];
  const seen = new Set();
  for (const b of [].concat(explicitBindings).concat(readBindings(events))) {
    if (!b || !b.packageId) continue;
    const key = [b.packageId, b.childSessionId || "", b.childTurnId || "", b.attemptId || ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

/**
 * 派工闸的放行 / 拒签判定。规则见 references/budget-policy.md：
 *   - 该包尚无任何尝试（第一次派工，用量尚未产生）→ 不属于未知，正常放行；
 *   - 该包已有尝试或已绑定，却拿不到完整计量
 *     （缺绑定、缺目标 turn、关键字段缺失、读取失败）→ 拒签；
 *   - 计量完整但越阈值 → 拆包 / 重新拆包，拒签；
 *   - 一个包都没点名也没绑定，而账本里已有历史尝试 → 无法识别该判哪个包，拒签。
 *
 * @param {{requested?:string[], bound?:string[], attempts?:Map, snapshot?:object}} input
 * @returns {{allowed:boolean, judged:string[], reasons:string[], basis:string[]}}
 */
export function decideDispatchGate({ requested = [], bound = [], attempts = new Map(), snapshot = null, meteringError = null } = {}) {
  const basis = [];
  const reasons = [];
  const judged = [];
  for (const id of [].concat(requested).concat([].concat(bound))) {
    if (id && !judged.includes(id)) judged.push(id);
  }

  if (!judged.length) {
    if (attempts.size) {
      reasons.push(
        "账本里有 " + attempts.size + " 个历史尝试包，但本次既没点名包（--pkg）也没绑定执行会话（--bind）："
        + "无法识别本次计划涉及哪个包，也拿不到任何真实计量 → 拒签。",
      );
    } else {
      basis.push("账本里没有历史尝试：本次是第一次派工，用量尚未产生，不属于未知 → 放行。");
    }
    return { allowed: reasons.length === 0, judged, reasons, basis };
  }

  for (const id of judged) {
    const pkg = snapshot && snapshot.packages ? snapshot.packages[id] : null;
    const expected = attempts.has(id) || [].concat(bound).includes(id) || Boolean(pkg);
    if (!expected) {
      basis.push(id + "：没有历史尝试也没有绑定（第一次派工），用量尚未产生 → 不判");
      continue;
    }
    if (!pkg) {
      reasons.push(
        id + "：有历史尝试或绑定，却拿不到计量（缺绑定、读取失败或超时"
        + (meteringError ? "；计量模块不可用：" + meteringError : "") + "）→ 拒签",
      );
      continue;
    }
    const verdict = evaluatePackageCost(snapshot, id);
    if (verdict === "continue") {
      basis.push(id + "：计量完整且未越阈值（toolCalls=" + pkg.usage.toolCalls
        + " totalTokens=" + pkg.usage.totalTokens + "）");
    } else if (verdict === "split") {
      reasons.push(id + "：工具调用 " + pkg.usage.toolCalls + " > " + TOOL_CALL_LIMIT + " → 需拆包，拒签");
    } else if (verdict === "resplit") {
      reasons.push(id + "：token " + pkg.usage.totalTokens + " > " + TOKEN_LIMIT + " → 需重新拆包，拒签");
    } else {
      reasons.push(id + "：用量未知（coverage=" + pkg.coverage
        + (pkg.warnings && pkg.warnings.length ? "；" + pkg.warnings.join("；") : "")
        + "）→ 拒签");
    }
  }
  return { allowed: reasons.length === 0, judged, reasons, basis };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    if (args[k] === undefined) args[k] = v;
    else if (Array.isArray(args[k])) args[k].push(v);
    else args[k] = [args[k], v];
  }
}

const plan = Number(args.plan || 0);
if (!plan) {
  console.error("用法: node scripts/dispatch-guard.mjs --plan <包数> [--budget] [--pkg <包名>] [--bind <包>=<子会话ID>] [--as-of <毫秒>]");
  process.exit(2);
}

const asOf = Number(args["as-of"] || Date.now());
const windowMs = DEFAULT_WINDOW_MS;

const events = readLedgerEvents();
// 账本有坏行 = 账本不可信：认不出哪些包该有计量，不能签发放行结论。
const corruptRows = events.filter((e) => e && e.corrupt === true);
if (corruptRows.length) {
  console.error("");
  console.error("⚠ 拒签：账本有 " + corruptRows.length + " 行坏行 —— 账本不可信，认不出哪些包该有计量。");
  process.exit(2);
}
const { recent, dispatched } = countWindowPackages(events, { asOf, windowMs });

// 5 小时窗口内的经验上限（实测：9 包并行 → 3 个撞上限；4 包并行 → 0 个撞上限）。
// 保守取 4 作为安全并发度；再按窗口已用比例折减。
// 注意：这里没有套餐余量分母，折减依据只是包数，不是 token 用量。
const SAFE_CONCURRENCY = 4;
const usedRatio = Math.min(1, dispatched / 12);
const suggested = Math.max(1, Math.floor(SAFE_CONCURRENCY * (1 - usedRatio * 0.75)));

console.log("=== 派工额度守卫 ===");
console.log("  计划包数: " + plan);
console.log("  近 5 小时已派 worker 包数: " + dispatched);
console.log("  并发建议: " + suggested + "（经验基线 " + SAFE_CONCURRENCY + "，按近 5 小时派工包数折减；只作分批参考，不是放行依据）");

// 本次涉及的包：--pkg 点名的 + --bind 绑定的。
const requested = [].concat(args.pkg || []).map(String).filter(Boolean);
const explicitBindings = [];
for (const raw of [].concat(args.bind || [])) {
  const [packageId, childSessionId] = String(raw).split("=");
  if (packageId && childSessionId) explicitBindings.push({ packageId, childSessionId });
}
// 账本里派工侧写下的绑定也读（宿主原生字段名由 readBindings 兼容）。
const bindings = collectBindings(explicitBindings, events);

let snapshot = null;
let meteringError = null;
if (bindings.length) {
  const reader = createMcpReader();
  try {
    snapshot = await readUsage(
      {
        projectKey: args.project || null,
        bindings,
        window: { fromMs: asOf - windowMs, toMs: asOf },
        asOfMs: asOf,
      },
      reader,
    );
  } catch (err) {
    // 计量模块坏了不是「没问题」，是没测到：记下来，判定阶段按 unknown 拒签。
    meteringError = (err && err.message) || String(err);
  } finally {
    await reader.close();
  }
}

if (snapshot) {
  const w = snapshot.windowUsage;
  console.log("  近 5 小时实测用量（已绑定会话）: total=" + w.totalTokens
    + " input=" + w.inputTokens
    + " cacheRead=" + w.cacheReadTokens
    + " decode=" + w.decodeTokens
    + " toolCalls=" + w.toolCalls
    + "（" + snapshot.source + "，覆盖 " + snapshot.coverage + "）");
  console.log("  单包成本:");
  for (const [packageId, pkg] of Object.entries(snapshot.packages)) {
    const verdict = evaluatePackageCost(snapshot, packageId);
    const why = verdict === "split"
      ? "需拆包（超过 " + TOOL_CALL_LIMIT + " 次工具调用）"
      : verdict === "resplit"
        ? "需重新拆包（超过 " + TOKEN_LIMIT + " token）"
        : verdict === "unknown"
          ? "用量未知（" + pkg.coverage
            + (pkg.warnings && pkg.warnings.length ? "；" + pkg.warnings.join("；") : "")
            + "），无法签发放行结论"
          : "可继续";
    console.log("    " + packageId + ": toolCalls=" + pkg.usage.toolCalls
      + " totalTokens=" + pkg.usage.totalTokens
      + " → " + why);
  }
} else {
  console.log("  近 5 小时实测用量: 未知（未绑定执行会话，无计量可读）");
  console.log("  单包成本: 未知（无绑定）");
}

if (args.budget) {
  const withUsage = recent.filter(e => e.usage);
  const missing = recent.length - withUsage.length;
  const sum = k => withUsage.reduce((n, e) => n + (e.usage?.[k] ?? 0), 0);
  const text = (v) => (missing ? "未知" : String(v));
  console.log("  执行侧 usage（账本）: input=" + text(sum("input_tokens"))
    + " output=" + text(sum("output_tokens"))
    + (missing ? "（" + missing + "/" + recent.length + " 条事件缺 usage 字段）" : ""));
  console.log("  (完整账本: node scripts/codex-team.mjs budget)");
}

// 判定：放行依据只有真实计量。
const attempts = collectAttemptPackages(events);
const gate = decideDispatchGate({
  requested,
  bound: explicitBindings.map(b => b.packageId),
  attempts,
  snapshot,
  meteringError,
});

console.log("  判定依据:");
if (gate.basis.length) {
  for (const line of gate.basis) console.log("    · " + line);
}
for (const line of gate.reasons) console.log("    ✗ " + line);
if (!gate.basis.length && !gate.reasons.length) console.log("    · 没有可判定的包");

if (!gate.allowed) {
  console.error("");
  console.error("⚠ 拒签：真实计量不可得或已越界，不签发放行结论。");
  for (const line of gate.reasons) console.error("   " + line);
  console.error("   放行需要：用 --pkg 点名本次涉及的包；重新派工已有尝试的包还要用 --bind <包>=<子会话ID> 绑定执行会话。");
  process.exit(2);
}

if (plan > suggested) {
  console.error("");
  console.error("⚠ 建议把并发降到 " + suggested + "（分批派，别一次全开）。");
  console.error("   整批开满的后果：后段包撞 Token Plan 上限被杀，续跑要再花一轮，净亏。");
  process.exit(2);
}
console.log("OK: 可以按计划派工（依据：真实计量已核对 " + gate.judged.length + " 个包"
  + (gate.basis.length ? "；" + gate.basis.join("；") : "") + "）");
}
