#!/usr/bin/env node
// 撞墙后的续派判定：额度失败之后、重开 Worker 之前必须过这一关。
//
// 原因（2026-11-24 16:00 实测）：P2/P5/P9 三个包同时撞 Token Plan 上限被杀，
// 16:01:42 同一分钟内又重开 3 个续派 —— 零分析、零降并发、零落盘核查，
// P9 续派再跑 4900 秒。本模块把「撞墙后怎么续派」变成可判定、可恢复的策略。
//
// 判定口径（来自 Coder 对宿主失败事件的取证，此处照抄不改）：
//   1. 只有宿主失败事件 payload.error.code = 42212 才算额度撞墙；
//      其它机器码 => 普通失败；拿不到机器码 => 证据不足（unknown）。
//      普通失败不自动按额度事故处理。
//   2. 累计预留不得恢复原并发：按整个失败批次累计，滚动 60 秒窗口内
//      已预留 + 本次请求 < 原并发。
//   3. 原并发已经是 1 时不自动续派，交回 Overmind 重拆（1→1 不是降并发）。
//   4. 续派书必须写明「已落盘什么／没做什么」两段；允许有证据的零落盘
//      （工作树干净且无提交才是零落盘，干净但有提交不是）。
//   5. 判定只能基于可核对的证据：同一次失败 turn 的机器码（42212）、失败时刻、
//      原并发（来自账本/状态，不是提示词）、原 attempt 标识、原 Worker 工作树。
//      缺任何一项 => 证据不足（unknown）=> 拒签/交回 Overmind，绝不按额度事故放行。
//   6. 状态文件读不出来/解析失败/锁异常 => 拒签，不当空状态继续判。
//   7. 「是哪一次失败」必须钉死：失败批次的 attemptId / taskId / childTurnId 缺一不可，
//      请求里的标识（retryOfAttemptId 等）只作交叉校验，对不上就是别的任务 => 拒签。
//   8. 取证失败 ≠ 没有变更：git 子命令失败或拿不到基线提交 => 取证失败（拒签），
//      不折成「无变更 / 零落盘」。
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
  statSync, rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const QUOTA_PROTOCOL_CODE = 42212;
export const RETRY_WINDOW_MS = 60_000;

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

// 额度撞墙的判定：只有 42212。其它码是普通失败，没有码就是证据不足。
// attemptMatched 只认「明确为 false」；被调用方强行置 true 不算证据 ——
// 「是哪一次失败」由标识符（taskId / childSessionId / childTurnId / attemptId）自己证明。
export function classifyFailure(evidence) {
  const e = evidence ?? {};
  const observedAtMs = e.observedAtMs ?? (typeof e.at === "string" ? Date.parse(e.at) : e.at ?? null);
  const common = {
    source: e.source ?? "unknown",
    observedAtMs,
    taskId: e.taskId ?? null,
    childSessionId: e.childSessionId ?? null,
    childTurnId: e.childTurnId ?? null,
  };
  const raw = e.protocolCode ?? e.errorCode ?? e.payload?.error?.code ?? null;
  const code = raw === null || raw === undefined ? null : Number(raw);

  if (code === null) return { kind: "unknown", ...common };
  if (code !== QUOTA_PROTOCOL_CODE) return { kind: "failure", protocolCode: code, ...common };

  // 会话投影会被后续 turn 改写；P12 就是 Task 已 failed 而子会话已 idle、error_code=null。
  // 对不上同一次尝试就没有证据，不能按额度事故处理。
  if (e.attemptMatched === false) return { kind: "unknown", protocolCode: code, ...common };

  // 没有失败时刻 => 不知道是哪一次失败。
  if (!Number.isFinite(observedAtMs)) return { kind: "unknown", protocolCode: code, ...common };
  // 没有任何同一次失败的标识 => 只有机器码，证明不了是哪一次 attempt（强制 true 也不行）。
  if (!e.taskId && !e.childSessionId && !e.childTurnId && !e.attemptId) {
    return { kind: "unknown", protocolCode: code, ...common };
  }

  const providerMatch = /[（(](\d{3,5})[）)]/.exec(String(e.text ?? e.errorText ?? ""));
  return {
    kind: "quota",
    protocolCode: code,
    providerCode: e.providerCode ?? (providerMatch ? Number(providerMatch[1]) : null),
    ...common,
  };
}

// 在原 Worker 的目标工作树取证：git status + 基线到 HEAD 的提交。
// 取证失败 ≠ 没有变更：任何一条 git 子命令失败、或拿不到基线提交，
// 一律 ok:false（拒签），绝不折成「无变更 / 零落盘」。
export function collectWorktreeEvidence(worktreePath, { baseCommit = null, taskPatterns = null } = {}) {
  if (!worktreePath) return { ok: false, error: "缺少目标工作树路径", worktreePath: null };
  // 基线提交是必需的：没有它就看不见「已提交但工作树干净」的那部分变更。
  if (!baseCommit) return { ok: false, error: "没有基线提交，看不到基线到 HEAD 的已提交变更", worktreePath };
  const git = (args) => {
    const r = spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" });
    if (r.error) return { ok: false, error: "git " + args[0] + " 失败（" + r.error.message + "）" };
    if (r.status !== 0) return { ok: false, error: "git " + args[0] + " 失败（退出码 " + r.status + "）" };
    return { ok: true, out: r.stdout ?? "" };
  };
  const head = git(["rev-parse", "HEAD"]);
  if (!head.ok) return { ok: false, error: head.error + "：工作树不可用（不是 git 仓库或 git 不可用）", worktreePath };

  const status = git(["status", "--porcelain=v1"]);
  if (!status.ok) return { ok: false, error: status.error, worktreePath };
  const range = baseCommit + "..HEAD";
  const commitsRes = git(["log", "--format=%H %s", range]);
  if (!commitsRes.ok) return { ok: false, error: commitsRes.error + "（基线 " + baseCommit + " 到 HEAD 取不到提交）", worktreePath };
  const pathsRes = git(["diff", "--name-only", range]);
  if (!pathsRes.ok) return { ok: false, error: pathsRes.error, worktreePath };
  const statusEvidence = status.out;
  const commitsRaw = commitsRes.out;
  const pathsRaw = pathsRes.out;

  const commits = commitsRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.indexOf(" ");
    return { hash: line.slice(0, i), subject: line.slice(i + 1) };
  });
  const changedPaths = pathsRaw.split(/\r?\n/).filter(Boolean);
  const patterns = (taskPatterns ?? []).map((p) => new RegExp(p));

  // 不给任务关键词时按整段提交算；给了就只认与本包相关的提交/路径。
  const relevantCommits = patterns.length
    ? commits.filter((c) => patterns.some((re) => re.test(c.subject)))
    : commits;
  const relevantPaths = patterns.length
    ? changedPaths.filter((p) => patterns.some((re) => re.test(p)))
    : changedPaths;

  return {
    ok: true,
    worktreePath,
    baseCommit,
    headCommit: head.out.trim(),
    statusEvidence,
    changedPaths,
    commits,
    relevantCommits,
    relevantPaths,
    hasCommits: relevantCommits.length > 0,
    hasChanges: statusEvidence.trim() !== "",
  };
}

function worktreeProgress(evidence) {
  if (!evidence || evidence.ok === false) return { kind: "无取证", hasCommits: false, hasChanges: false };
  const hasCommits = Boolean(evidence.hasCommits ?? (evidence.commits?.length > 0));
  const hasChanges = Boolean(evidence.hasChanges ?? (String(evidence.statusEvidence ?? "").trim() !== ""));
  return { kind: hasCommits || hasChanges ? "有落盘" : "零落盘", hasCommits, hasChanges };
}

function validateBrief(brief) {
  if (!brief || typeof brief !== "object") return { ok: false, reason: "续派书缺失" };
  const hasPersisted = typeof brief.persistedWork === "string";
  const hasRemaining = typeof brief.remainingWork === "string" && brief.remainingWork.trim() !== "";
  if (!hasPersisted || !hasRemaining) return { ok: false, reason: "续派书缺少「已落盘什么／没做什么」两段" };
  return { ok: true };
}

function normalizeState(state) {
  if (state && state.batches !== undefined && (typeof state.batches !== "object" || state.batches === null || Array.isArray(state.batches))) {
    throw new Error("续派状态形状不对（batches 不是对象）");
  }
  const batches = {};
  for (const [id, b] of Object.entries(state?.batches ?? {})) {
    // 批次记录里的其它字段（失败证据）原样保留：状态文件也是账本的一部分。
    batches[id] = { ...b, batchId: id, reservations: Array.isArray(b?.reservations) ? b.reservations : [] };
  }
  return { version: state?.version ?? 1, batches };
}

// 路径比较：Windows 下大小写不敏感，统一斜杠。
function samePath(a, b) {
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

// 同一次失败的 attempt 必须被钉死：attemptId / taskId / childTurnId 三个标识缺一不可。
// 请求里的标识（retryOfAttemptId 等）只作交叉校验 —— 对不上就是别的任务，不放行。
const ATTEMPT_IDS = ["attemptId", "taskId", "childTurnId"];

export function pinAttempt(failedBatch = {}, request = {}) {
  const fb = failedBatch ?? {};
  const gaps = [];
  let contradicted = false;
  for (const key of ATTEMPT_IDS) {
    if (!fb[key]) gaps.push("失败 attempt 标识 " + key + " 缺失");
  }
  const reqAttempt = request.retryOfAttemptId ?? request.attemptId ?? null;
  if (reqAttempt && fb.attemptId && reqAttempt !== fb.attemptId) {
    gaps.push("请求指向的 attempt 与失败批次对不上");
    contradicted = true;
  }
  for (const key of ["taskId", "childTurnId"]) {
    const v = request[key] ?? null;
    if (!v) continue;
    if (fb[key] && fb[key] !== v) {
      gaps.push("请求指向的 " + key + " 与失败批次对不上");
      contradicted = true;
    }
  }
  const complete = ATTEMPT_IDS.every((k) => Boolean(fb[k]));
  return { gaps, contradicted, matched: complete ? (contradicted ? false : true) : null };
}

// 失败批次的必填证据：缺任何一项都不足以证明「同一次额度墙失败」。
// 提示词给的批次/并发/工作树不算证据 —— 证据必须来自账本（宿主还原）。
export function evidenceGaps(failedBatch = {}, request = {}, worktreeEvidence = null) {
  const fb = failedBatch ?? {};
  const gaps = [];
  const code = fb.protocolCode ?? fb.failureProtocolCode ?? fb.payload?.error?.code ?? null;
  if (code === null || code === undefined) gaps.push("失败机器码 protocolCode");
  else if (Number(code) !== QUOTA_PROTOCOL_CODE) gaps.push("失败机器码不是额度墙 42212");
  if (!Number.isFinite(Number(fb.failureAtMs))) gaps.push("失败时刻 failureAtMs");
  // 「是哪一次失败」：标识要齐，请求侧的标识要能对上。
  gaps.push(...pinAttempt(fb, request).gaps);
  if (!Number.isFinite(Number(fb.previousConcurrency)) || Number(fb.previousConcurrency) < 1) gaps.push("原并发 previousConcurrency");
  if (!fb.batchId) gaps.push("失败批次 batchId");
  if (!fb.worktreePath) gaps.push("原 Worker 工作树 worktreePath");
  if (!worktreeEvidence || worktreeEvidence.ok === false) gaps.push("工作树取证");
  else if (!worktreeEvidence.worktreePath) gaps.push("取证的工作树路径缺失");
  else if (fb.worktreePath && !samePath(fb.worktreePath, worktreeEvidence.worktreePath)) {
    gaps.push("取证的工作树不是原 Worker 工作树");
  } else if (!worktreeEvidence.baseCommit) {
    // 没有基线就看不见已提交的变更 —— 这不是「没有变更」。
    gaps.push("取证缺基线提交（看不到已提交的变更）");
  }
  if (fb.attemptMatched === false || request.attemptMatched === false) gaps.push("调用方明确说不是同一次失败");
  const reqBatch = request.failedBatchId ?? null;
  if (reqBatch && fb.batchId && reqBatch !== fb.batchId) gaps.push("请求指向的批次与失败批次对不上");
  const reqPrev = request.previousConcurrency;
  if (reqPrev !== undefined && reqPrev !== null && Number(reqPrev) !== Number(fb.previousConcurrency)) {
    gaps.push("请求声称的原并发与失败批次对不上");
  }
  return gaps;
}

// 续派判定。state 里存的是各失败批次已预留的名额，跨进程可恢复。
export function evaluateRetry(
  { request = {}, failedBatch = {}, worktreeEvidence = null, continuationBrief = null, nowMs = Date.now() } = {},
  state = null,
) {
  const fb = failedBatch ?? {};
  const batchId = fb.batchId ?? request.failedBatchId ?? null;
  const windowStartMs = nowMs - RETRY_WINDOW_MS;
  const progress = worktreeProgress(worktreeEvidence);
  const reqAttempt = request.retryOfAttemptId ?? request.attemptId ?? null;

  const facts = {
    failedBatchId: batchId,
    retryOfAttemptId: reqAttempt ?? fb.attemptId ?? null,
    attemptId: fb.attemptId ?? null,
    taskId: fb.taskId ?? null,
    childTurnId: fb.childTurnId ?? null,
    affectedPackageIds: fb.affectedPackageIds ?? request.packageIds ?? [],
    failureKind: fb.failureKind ?? "unknown",
    failureAtMs: fb.failureAtMs ?? null,
    protocolCode: fb.protocolCode ?? fb.failureProtocolCode ?? fb.payload?.error?.code ?? null,
    previousConcurrency: Number.isFinite(Number(fb.previousConcurrency)) ? Number(fb.previousConcurrency) : 0,
    requestedConcurrency: Number(request.concurrency ?? (request.packageIds?.length ?? 0)),
    reservedConcurrency: 0,
    attemptMatched: null,
    worktreePath: worktreeEvidence?.worktreePath ?? null,
    originalWorktreePath: fb.worktreePath ?? null,
    baseCommit: worktreeEvidence?.baseCommit ?? null,
    headCommit: worktreeEvidence?.headCommit ?? null,
    statusEvidence: worktreeEvidence?.statusEvidence ?? null,
    persistedWork: typeof continuationBrief?.persistedWork === "string" ? continuationBrief.persistedWork : null,
    remainingWork: typeof continuationBrief?.remainingWork === "string" ? continuationBrief.remainingWork : null,
    evidenceGaps: [],
    stateStatus: "unreadable",
  };
  let s = null;
  const reasons = [];

  const decide = (decision, reason, extra = {}) => {
    const payload = {
      failedBatchId: facts.failedBatchId,
      retryOfAttemptId: facts.retryOfAttemptId,
      attemptId: facts.attemptId,
      taskId: facts.taskId,
      childTurnId: facts.childTurnId,
      affectedPackageIds: facts.affectedPackageIds,
      failureKind: facts.failureKind,
      failureAtMs: facts.failureAtMs,
      protocolCode: facts.protocolCode,
      previousConcurrency: facts.previousConcurrency,
      requestedConcurrency: facts.requestedConcurrency,
      reservedConcurrency: facts.reservedConcurrency,
      attemptMatched: facts.attemptMatched,
      worktreePath: facts.worktreePath,
      originalWorktreePath: facts.originalWorktreePath,
      baseCommit: facts.baseCommit,
      headCommit: facts.headCommit,
      statusEvidence: facts.statusEvidence,
      persistedWork: facts.persistedWork,
      remainingWork: facts.remainingWork,
      evidenceGaps: facts.evidenceGaps,
      stateStatus: facts.stateStatus,
      decision,
      reason,
      progress: progress.kind,
    };
    return {
      ...payload,
      reasons: [...reasons, reason],
      windowStartMs,
      windowEndMs: nowMs,
      reservation: extra.reservation ?? null,
      nextState: extra.nextState !== undefined ? extra.nextState : s,
      event: { kind: "retry.decided", ...payload },
    };
  };

  // 0. 状态不可用（读不出来/形状不对）=> 拒签，不当空状态继续判。
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    facts.failureKind = "unknown";
    const reason = "续派状态不可用（读不出来或形状不对）—— 按证据不足拒签，不当空状态继续判";
    reasons.push(reason);
    return decide("deny", reason, { nextState: null });
  }
  try {
    s = normalizeState(state);
  } catch (err) {
    facts.failureKind = "unknown";
    const reason = "续派状态不可用（" + ((err && err.message) || err) + "）—— 按证据不足拒签";
    reasons.push(reason);
    return decide("deny", reason, { nextState: null });
  }
  facts.stateStatus = "ok";

  const batch = s.batches[batchId] ?? { batchId, reservations: [] };
  const reservedBefore = (batch.reservations ?? [])
    .filter((r) => r.reservedAtMs > windowStartMs && r.reservedAtMs <= nowMs)
    .reduce((n, r) => n + (r.reservedConcurrency ?? 0), 0);
  facts.reservedConcurrency = reservedBefore;

  // 1. 不是额度撞墙（普通失败或证据不足）=> 不按额度事故自动续派。
  if (facts.failureKind !== "quota") {
    const reason = facts.failureKind === "unknown"
      ? "失败证据不足（unknown），不按额度事故自动续派"
      : "非额度失败，不按额度事故自动续派";
    reasons.push(reason);
    return decide("deny", reason);
  }

  // 2. 原并发已是 1 => 没有可降的并发，交回 Overmind 重拆（1→1 不是降并发）。
  if (facts.previousConcurrency === 1) {
    const reason = "原并发已是 1，无法降并发，交回 Overmind 重拆";
    reasons.push(reason);
    return decide("resplit", reason);
  }

  // 3. 证据链：同一次失败的机器码/失败时刻/attempt/原并发/批次/原工作树，缺一项都不放行。
  //    attemptMatched 由标识符自己算出来，不采信调用方断言的 true。
  const pin = pinAttempt(fb, request);
  facts.attemptMatched =
    fb.attemptMatched !== false && request.attemptMatched !== false ? pin.matched : false;
  const gaps = evidenceGaps(fb, request, worktreeEvidence);
  facts.evidenceGaps = gaps;
  if (gaps.length) {
    facts.failureKind = "unknown";
    const reason = "失败批次证据不足（缺 " + gaps.join("、") + "）—— 按证据不足拒签，不按额度事故放行";
    reasons.push(reason);
    return decide("deny", reason);
  }

  if (facts.requestedConcurrency < 1) {
    const reason = "请求并发非法";
    reasons.push(reason);
    return decide("deny", reason);
  }

  // 4. 续派书两段必须齐全。
  const briefCheck = validateBrief(continuationBrief);
  if (!briefCheck.ok) {
    reasons.push(briefCheck.reason);
    return decide("deny", briefCheck.reason);
  }

  // 5. 工作树显示已有落盘，续派书却没写已落盘什么 => 会被重做/覆盖。
  if (progress.kind === "有落盘" && facts.persistedWork.trim() === "") {
    const reason = "工作树显示已有落盘，续派书未写明已落盘什么";
    reasons.push(reason);
    return decide("deny", reason);
  }

  // 6. 累计预留不得恢复原并发（跨分钟同样降并发）。
  if (reservedBefore + facts.requestedConcurrency >= facts.previousConcurrency) {
    const reason = `同批续派累计预留 ${reservedBefore} + 请求 ${facts.requestedConcurrency} ≥ 原并发 ${facts.previousConcurrency}：不得恢复原规模`;
    reasons.push(reason);
    return decide("deny", reason);
  }

  const reservation = {
    reservedAtMs: nowMs,
    reservedConcurrency: facts.requestedConcurrency,
    requestId: request.requestId ?? null,
    packageIds: request.packageIds ?? [],
    batchId,
    attemptId: facts.attemptId,
  };
  batch.reservations.push(reservation);
  s.batches[batchId] = batch;
  facts.reservedConcurrency = reservedBefore + facts.requestedConcurrency;

  const reason = `放行：累计预留 ${facts.reservedConcurrency} < 原并发 ${facts.previousConcurrency}，落盘进度 ${progress.kind}`;
  reasons.push(reason);
  return decide("allow", reason, { reservation });
}

// 批次状态：跨进程可恢复，重启后已预留的名额仍在。
// 读不出来/解析失败/形状不对 => 抛错：状态坏了不能当空状态用，
// 空状态会让后续判定失去依据（会按「没人预留过」放行）。
export function loadRetryState(file) {
  if (!existsSync(file)) return { version: 1, batches: {} };
  const raw = readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("续派状态文件损坏（不是合法 JSON）：" + file);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("续派状态文件形状不对（不是对象）：" + file);
  }
  return normalizeState(parsed);
}

export function saveRetryState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

// 并行请求串行化：同一批次的判定不能并发读改同一个状态文件。
export function withRetryLock(stateFile, fn) {
  const lockDir = stateFile + ".lock";
  mkdirSync(dirname(stateFile), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        // 上个进程崩了会留下陈旧锁，超过 30 秒就清掉。
        if (Date.now() - statSync(lockDir).mtimeMs > 30000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // 锁刚被别的进程清掉，重试。
      }
      if (Date.now() > deadline) throw new Error("获取续派状态锁超时: " + lockDir);
      sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

// 证据不足/状态不可用时的统一拒签（不按额度事故放行）。
function denyUnknown(reason, extra = {}) {
  const payload = {
    failedBatchId: extra.failedBatchId ?? null,
    retryOfAttemptId: extra.retryOfAttemptId ?? null,
    attemptId: extra.attemptId ?? null,
    taskId: extra.taskId ?? null,
    childTurnId: extra.childTurnId ?? null,
    affectedPackageIds: extra.affectedPackageIds ?? [],
    failureKind: "unknown",
    failureAtMs: extra.failureAtMs ?? null,
    protocolCode: extra.protocolCode ?? null,
    previousConcurrency: extra.previousConcurrency ?? 0,
    requestedConcurrency: extra.requestedConcurrency ?? 0,
    reservedConcurrency: 0,
    attemptMatched: null,
    worktreePath: extra.worktreePath ?? null,
    originalWorktreePath: extra.originalWorktreePath ?? null,
    baseCommit: null,
    headCommit: null,
    statusEvidence: null,
    persistedWork: null,
    remainingWork: null,
    evidenceGaps: extra.evidenceGaps ?? [],
    stateStatus: extra.stateStatus ?? "unreadable",
    decision: "deny",
    reason,
    progress: "无取证",
  };
  return {
    ...payload,
    reasons: [reason],
    windowStartMs: null,
    windowEndMs: null,
    reservation: null,
    nextState: null,
    event: { kind: "retry.decided", ...payload },
  };
}

// 读状态 -> 判定 -> 写状态，全过程持锁。宿主接线（A）用这个入口。
// 状态读不出来/锁拿不到/预留写不进去 => 拒签，不放行。
export function decideAndPersist({ stateFile, request = {}, failedBatch = {}, worktreeEvidence = null, continuationBrief = null, nowMs = Date.now() }) {
  try {
    return withRetryLock(stateFile, () => {
      const state = loadRetryState(stateFile);
      const decision = evaluateRetry({ request, failedBatch, worktreeEvidence, continuationBrief, nowMs }, state);
      if (decision.decision !== "allow") return decision;
      try {
        saveRetryState(stateFile, decision.nextState);
      } catch (err) {
        return denyUnknown("续派预留写不进去（" + ((err && err.message) || err) + "）—— 按证据不足拒签", {
          failedBatchId: decision.failedBatchId,
          attemptId: decision.attemptId,
          stateStatus: "unwritable",
        });
      }
      return decision;
    });
  } catch (err) {
    return denyUnknown("续派状态不可用（" + ((err && err.message) || err) + "）—— 按证据不足拒签，不当空状态继续判", {
      failedBatchId: failedBatch.batchId ?? request.failedBatchId ?? null,
      attemptId: failedBatch.attemptId ?? null,
      stateStatus: "unreadable",
    });
  }
}

// 宿主闸门入口：证据由宿主按 task_id 从自己的账本还原，这里只做判定。
// 只补账本还原出来的 attempt 标识；批次/并发/工作树一律不从提示词取。
export function evaluateRetryEvidence(evidence = {}, payload = {}) {
  const failedBatch = { ...(payload.failedBatch || {}) };
  if (!failedBatch.attemptId && evidence.attemptId) failedBatch.attemptId = evidence.attemptId;
  if (!failedBatch.taskId && evidence.taskId) failedBatch.taskId = evidence.taskId;
  if (!failedBatch.childTurnId && evidence.childTurnId) failedBatch.childTurnId = evidence.childTurnId;
  return decideAndPersist({ ...payload, failedBatch });
}
