import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  classifyFailure, collectWorktreeEvidence, evaluateRetry,
  loadRetryState, decideAndPersist, QUOTA_PROTOCOL_CODE,
} from "../scripts/retry-policy.mjs";

const MODULE_URL = pathToFileURL(join(import.meta.dirname, "..", "scripts", "retry-policy.mjs")).href;

// 账本原值（config/events.jsonl）：三个包 16:00:46 被杀，16:01:42 重开续派。
const FAIL_AT = [
  Date.parse("2026-11-24T16:00:46.259Z"),
  Date.parse("2026-11-24T16:00:46.349Z"),
  Date.parse("2026-11-24T16:00:46.441Z"),
];
const RETRY_AT = [
  Date.parse("2026-11-24T16:01:42.768Z"),
  Date.parse("2026-11-24T16:01:42.857Z"),
  Date.parse("2026-11-24T16:01:42.947Z"),
];

// 原 Worker 的工作树（失败时取证的那棵树，不是主会话 cwd）。
// 用相对路径占位：这里是数据，不是本机路径。
const WORKTREE = "work/pkg-c";

// 失败批次证据：机器码 + 失败时刻 + attempt 标识 + 原并发 + 批次 + 原工作树。
// 缺任何一项都不是「同一次额度墙失败」，判定一律降级为 unknown。
const failedBatch = (over = {}) => ({
  batchId: "batch-2026-11-24T160046Z",
  failureKind: "quota",
  protocolCode: QUOTA_PROTOCOL_CODE,
  failureAtMs: FAIL_AT[2],
  previousConcurrency: 3,
  attemptId: "att-p2",
  taskId: "task-p2",
  childTurnId: "turn-p2",
  worktreePath: WORKTREE,
  affectedPackageIds: ["P2", "P5", "P9"],
  ...over,
});

const evidence = (over = {}) => ({
  ok: true,
  worktreePath: WORKTREE,
  baseCommit: "base0000",
  headCommit: "head1111",
  statusEvidence: " M Src/02-Application/Domain/Helper/SimulationEngine.cs",
  hasCommits: true,
  hasChanges: true,
  commits: [{ hash: "abc1234", subject: "P5 模拟引擎" }],
  ...over,
});

const brief = (over = {}) => ({
  persistedWork: "已落盘 IisRemountPolicy",
  remainingWork: "IISManagerService 剩余部分",
  ...over,
});

const request = (over = {}) => ({
  requestId: "req",
  packageIds: ["P2"],
  concurrency: 1,
  retryOfAttemptId: "att-p2",
  failedBatchId: "batch-2026-11-24T160046Z",
  ...over,
});

const STATE = { version: 1, batches: {} };

test("classifyFailure: 宿主失败事件 42212 = 额度撞墙", () => {
  const r = classifyFailure({
    source: "host-failure-event",
    taskId: "task-p2",
    childTurnId: "turn-7",
    payload: { error: { code: QUOTA_PROTOCOL_CODE } },
    text: "供应商返回错误 (2056)",
    observedAtMs: FAIL_AT[2],
  });
  assert.equal(r.kind, "quota");
  assert.equal(r.protocolCode, 42212);
  assert.equal(r.providerCode, 2056);
  assert.equal(r.observedAtMs, FAIL_AT[2]);
  assert.equal(r.taskId, "task-p2");
  assert.equal(r.childTurnId, "turn-7");
});

test("classifyFailure: 其它机器码是普通失败，不按额度事故处理", () => {
  const r = classifyFailure({
    source: "host-failure-event",
    taskId: "task-p2",
    payload: { error: { code: 40001 } },
    observedAtMs: 1,
  });
  assert.equal(r.kind, "failure");
  assert.equal(r.protocolCode, 40001);
});

test("classifyFailure: 缺机器码 => unknown", () => {
  const r = classifyFailure({ source: "session-projection", status: "failed", observedAtMs: 1 });
  assert.equal(r.kind, "unknown");
  assert.equal(r.protocolCode, undefined);
});

test("classifyFailure: 会话态对不上同一次尝试 => unknown（P12 反例）", () => {
  const r = classifyFailure({
    source: "session-projection",
    errorCode: 42212,
    attemptMatched: false,
    taskId: "task-p2",
    observedAtMs: 1,
  });
  assert.equal(r.kind, "unknown");
});

test("classifyFailure: 被强行置 attemptMatched=true 也不算数 —— 没有同一次失败的标识仍是 unknown", () => {
  const r = classifyFailure({
    source: "host-failure-event",
    attemptMatched: true,
    payload: { error: { code: QUOTA_PROTOCOL_CODE } },
    observedAtMs: FAIL_AT[2],
  });
  assert.equal(r.kind, "unknown");
  assert.equal(r.protocolCode, 42212);
});

test("classifyFailure: 缺失败时刻 => unknown（不知道是哪一次失败）", () => {
  const r = classifyFailure({
    source: "host-failure-event",
    taskId: "task-p2",
    payload: { error: { code: QUOTA_PROTOCOL_CODE } },
  });
  assert.equal(r.kind, "unknown");
});

test("事故顺序回放：三路同分钟续派不能恢复原并发 3", () => {
  let state = { version: 1, batches: {} };
  const decisions = [];
  for (const at of RETRY_AT) {
    const d = evaluateRetry({
      request: request({ requestId: "retry-" + at }),
      failedBatch: failedBatch(),
      worktreeEvidence: evidence(),
      continuationBrief: brief(),
      nowMs: at,
    }, state);
    decisions.push(d);
    if (d.decision === "allow") state = d.nextState;
  }

  assert.deepEqual(decisions.map((d) => d.decision), ["allow", "allow", "deny"]);
  // 实际放行的续派并发合计 = 2 < 原并发 3。
  const granted = decisions.filter((d) => d.decision === "allow").reduce((n, d) => n + d.requestedConcurrency, 0);
  assert.equal(granted, 2);
  assert.ok(granted < 3);
  // 累计预留也不能回到 3。
  assert.equal(decisions[2].reservedConcurrency, 2);
  assert.ok(decisions[2].reservedConcurrency < 3);
  assert.match(decisions[2].reason, /不得恢复原规模/);
});

test("放行记录可追溯：工作树、两段进度说明、较低并发、证据链", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });

  assert.equal(d.decision, "allow");
  assert.equal(d.event.kind, "retry.decided");
  assert.equal(d.event.worktreePath, WORKTREE);
  assert.equal(d.event.originalWorktreePath, WORKTREE);
  assert.equal(d.event.baseCommit, "base0000");
  assert.equal(d.event.headCommit, "head1111");
  assert.match(d.event.statusEvidence, /SimulationEngine\.cs/);
  assert.equal(d.event.persistedWork, "已落盘 IisRemountPolicy");
  assert.equal(d.event.remainingWork, "IISManagerService 剩余部分");
  assert.equal(d.event.previousConcurrency, 3);
  assert.equal(d.event.requestedConcurrency, 1);
  assert.equal(d.event.reservedConcurrency, 1);
  assert.ok(d.event.reservedConcurrency < d.event.previousConcurrency);
  assert.deepEqual(d.event.affectedPackageIds, ["P2", "P5", "P9"]);
  assert.equal(d.event.failureKind, "quota");
  assert.equal(d.event.failureAtMs, FAIL_AT[2]);
  assert.equal(d.event.protocolCode, 42212);
  assert.equal(d.event.attemptId, "att-p2");
  assert.equal(d.event.taskId, "task-p2");
  assert.equal(d.event.attemptMatched, true);
  assert.deepEqual(d.event.evidenceGaps, []);
  assert.equal(d.event.stateStatus, "ok");
});

test("跨分钟续派仍须降并发", () => {
  const later = FAIL_AT[2] + 5 * 60 * 1000;
  const same = evaluateRetry({
    request: request({ concurrency: 3 }),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: later,
  }, { version: 1, batches: {} });
  assert.equal(same.decision, "deny");

  const lower = evaluateRetry({
    request: request({ concurrency: 2 }),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: later,
  }, { version: 1, batches: {} });
  assert.equal(lower.decision, "allow");
  assert.ok(lower.reservedConcurrency < lower.previousConcurrency);
});

test("原并发为 1 时不自动续派，交回 Overmind 重拆（1→1 不记成降并发）", () => {
  const state = { version: 1, batches: {} };
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch({ previousConcurrency: 1 }),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, state);
  assert.equal(d.decision, "resplit");
  assert.match(d.reason, /重拆/);
  // 没放行就没预留：1→1 不能被记成「降了并发」。
  assert.deepEqual(d.nextState.batches, {});
  assert.equal(d.reservation, null);
});

test("缺少目标工作树取证 => 不放行", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: null,
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /工作树取证/);
  assert.equal(d.failureKind, "unknown");
});

test("干净工作树但有提交 => 不算零落盘", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence({ statusEvidence: "", hasChanges: false }),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "allow");
  assert.equal(d.progress, "有落盘");
});

test("干净工作树且无提交 => 允许有证据的零落盘", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence({ statusEvidence: "", hasChanges: false, hasCommits: false, commits: [] }),
    continuationBrief: brief({ persistedWork: "" }),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "allow");
  assert.equal(d.progress, "零落盘");
});

test("工作树已有落盘但续派书没写已落盘什么 => 不放行", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: brief({ persistedWork: "" }),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /未写明已落盘/);
});

test("续派书缺「已落盘／没做什么」两段 => 不放行", () => {
  const noRemaining = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: { persistedWork: "已落盘 x" },
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(noRemaining.decision, "deny");
  assert.match(noRemaining.reason, /两段/);

  const noPersisted = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: { remainingWork: "还剩 y" },
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(noPersisted.decision, "deny");
});

test("非额度失败与证据不足都不自动续派", () => {
  const ordinary = evaluateRetry({
    request: request(),
    failedBatch: failedBatch({ failureKind: "failure" }),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(ordinary.decision, "deny");
  assert.match(ordinary.reason, /非额度失败/);

  const unknown = evaluateRetry({
    request: request(),
    failedBatch: failedBatch({ failureKind: "unknown" }),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(unknown.decision, "deny");
  assert.match(unknown.reason, /证据不足/);
});

test("证据链缺项一律降级 unknown 拒签：机器码/失败时刻/attempt 标识/原并发/批次/原工作树", () => {
  const cases = [
    [{ protocolCode: undefined }, /失败机器码/],
    [{ failureAtMs: undefined }, /失败时刻/],
    [{ attemptId: undefined, taskId: undefined, childTurnId: undefined }, /attempt 标识/],
    [{ previousConcurrency: undefined }, /原并发/],
    [{ batchId: undefined }, /batchId/],
    [{ worktreePath: undefined }, /原 Worker 工作树/],
  ];
  for (const [over, re] of cases) {
    const d = evaluateRetry({
      request: request(),
      failedBatch: failedBatch(over),
      worktreeEvidence: evidence(),
      continuationBrief: brief(),
      nowMs: RETRY_AT[0],
    }, { version: 1, batches: {} });
    assert.equal(d.decision, "deny", JSON.stringify(over));
    assert.equal(d.failureKind, "unknown", JSON.stringify(over));
    assert.match(d.reason, re);
  }
});

test("机器码不是额度墙 => 不按额度事故放行", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch({ protocolCode: 40001 }),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /42212/);
});

test("续派证据必须钉死同一次失败：请求 A 不能消费 B 的 42212", () => {
  // B 的失败记录没有 attemptId（只有宿主侧 taskId/childTurnId）=> 证明不了是哪一次失败。
  const noAttemptId = evaluateRetry({
    request: request({ retryOfAttemptId: "att-A" }),
    failedBatch: failedBatch({ attemptId: undefined, taskId: "task-B", childTurnId: "turn-B" }),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(noAttemptId.decision, "deny");
  assert.equal(noAttemptId.failureKind, "unknown");
  assert.match(noAttemptId.reason, /attemptId 缺失/);

  // attemptId 直接对不上：请求 A 指向的失败和账本里的失败不是同一次。
  const mismatch = evaluateRetry({
    request: request({ retryOfAttemptId: "att-A" }),
    failedBatch: failedBatch({ attemptId: "att-B", taskId: "task-B", childTurnId: "turn-B" }),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(mismatch.decision, "deny");
  assert.equal(mismatch.attemptMatched, false);
  assert.match(mismatch.reason, /attempt/);

  // 证据缺 childTurnId => 同样没钉死是哪一次失败。
  const noTurn = evaluateRetry({
    request: request({ retryOfAttemptId: "att-A" }),
    failedBatch: failedBatch({ childTurnId: undefined }),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(noTurn.decision, "deny");
  assert.equal(noTurn.failureKind, "unknown");
  assert.match(noTurn.reason, /childTurnId 缺失/);

  // 请求侧的 taskId / childTurnId 只作交叉校验，对不上一样拒签。
  const reqMismatch = evaluateRetry({
    request: request({ retryOfAttemptId: "att-p2", taskId: "task-别的" }),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(reqMismatch.decision, "deny");
  assert.match(reqMismatch.reason, /taskId/);
});

test("证据齐全且 attempt 对得上 => 放行（钉死同一次失败不误拒）", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "allow");
  assert.equal(d.attemptMatched, true);
  assert.equal(d.childTurnId, "turn-p2");
});

test("请求指向的 attempt 与失败批次对不上 => 拒签（不是同一次失败）", () => {
  const d = evaluateRetry({
    request: request({ retryOfAttemptId: "att-其它" }),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /attempt/);
  assert.equal(d.attemptMatched, false);
});

test("请求声称的原并发与失败批次对不上 => 拒签（提示词抬高原并发不算数）", () => {
  const d = evaluateRetry({
    request: request({ previousConcurrency: 9 }),
    failedBatch: failedBatch({ previousConcurrency: 2 }),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /原并发/);
});

test("取证的工作树路径缺失 => 拒签（说不清是在哪棵树取证的）", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence({ worktreePath: undefined }),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /工作树路径缺失/);
});

test("取证的工作树不是原 Worker 工作树 => 拒签（不能拿主会话 cwd 充数）", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence({ worktreePath: "work/主会话-cwd" }),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /原 Worker 工作树/);
});

test("状态读不出来不当空状态：状态文件损坏 => 拒签", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retry-corrupt-"));
  const file = join(dir, "retry-state.json");
  try {
    writeFileSync(file, "{ not json at all", "utf8");
    assert.throws(() => loadRetryState(file), /损坏/);

    const d = decideAndPersist({
      stateFile: file,
      request: request(),
      failedBatch: failedBatch(),
      worktreeEvidence: evidence(),
      continuationBrief: brief(),
      nowMs: RETRY_AT[0],
    });
    assert.equal(d.decision, "deny");
    assert.equal(d.failureKind, "unknown");
    assert.match(d.reason, /状态不可用/);
    // 坏状态没有被当成空状态覆盖掉。
    assert.equal(readFileSync(file, "utf8"), "{ not json at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("状态缺失（文件不存在）=> 视为没有预留过，判定照常", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retry-nostate-"));
  const file = join(dir, "retry-state.json");
  try {
    const d = decideAndPersist({
      stateFile: file,
      request: request(),
      failedBatch: failedBatch(),
      worktreeEvidence: evidence(),
      continuationBrief: brief(),
      nowMs: RETRY_AT[0],
    });
    assert.equal(d.decision, "allow");
    assert.equal(d.stateStatus, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateRetry 拿不到状态 => 拒签，不当空状态继续判", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, null);
  assert.equal(d.decision, "deny");
  assert.equal(d.failureKind, "unknown");
  assert.match(d.reason, /状态不可用/);
});

test("进程重启后仍能恢复已预留名额", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retry-restart-"));
  const file = join(dir, "retry-state.json");
  try {
    const first = decideAndPersist({
      stateFile: file,
      request: request(),
      failedBatch: failedBatch({ previousConcurrency: 2 }),
      worktreeEvidence: evidence(),
      continuationBrief: brief(),
      nowMs: RETRY_AT[0],
    });
    assert.equal(first.decision, "allow");

    // 模拟进程重启：新进程重新从磁盘读状态。
    const reloaded = loadRetryState(file);
    const second = evaluateRetry({
      request: request({ requestId: "req-2" }),
      failedBatch: failedBatch({ previousConcurrency: 2 }),
      worktreeEvidence: evidence(),
      continuationBrief: brief(),
      nowMs: RETRY_AT[0] + 1000,
    }, reloaded);
    assert.equal(second.decision, "deny");
    assert.match(second.reason, /累计预留 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("预留按失败批次归并：别的批次的预留不占本批名额", () => {
  const now = RETRY_AT[0];
  const state = {
    version: 1,
    batches: {
      "batch-别的": { batchId: "batch-别的", reservations: [{ reservedAtMs: now, reservedConcurrency: 2 }] },
    },
  };
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: now,
  }, state);
  assert.equal(d.decision, "allow");
  assert.equal(d.reservedConcurrency, 1);
});

test("滚动 60 秒窗口边界：窗口外的预留不计入本批累计", () => {
  const now = RETRY_AT[0];
  const at = (ms) => ({ reservedAtMs: ms, reservedConcurrency: 2 });
  const state = {
    version: 1,
    batches: {
      "batch-2026-11-24T160046Z": {
        batchId: "batch-2026-11-24T160046Z",
        reservations: [at(now - 60_000)],
      },
    },
  };
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: evidence(),
    continuationBrief: brief(),
    nowMs: now,
  }, state);
  // 窗口是 (now-60s, now]：正好卡在窗口边上的那条不算。
  assert.equal(d.reservedConcurrency, 1);
  assert.equal(d.decision, "allow");
});

const CHILD = `
import { decideAndPersist } from ${JSON.stringify(MODULE_URL)};
const d = decideAndPersist({
  stateFile: process.argv[1],
  request: { requestId: process.argv[2], packageIds: ["P"], concurrency: 1, retryOfAttemptId: "att-1", failedBatchId: "b1" },
  failedBatch: {
    batchId: "b1", failureKind: "quota", protocolCode: 42212, failureAtMs: 1000,
    previousConcurrency: 2, attemptId: "att-1", taskId: "task-1", childTurnId: "turn-1", worktreePath: "work/b1",
    affectedPackageIds: ["P"],
  },
  worktreeEvidence: { ok: true, worktreePath: "work/b1", baseCommit: "b", headCommit: "h", statusEvidence: " M a", hasCommits: true, hasChanges: true },
  continuationBrief: { persistedWork: "x", remainingWork: "y" },
  nowMs: 2000,
});
console.log(d.decision);
`;

function runChild(args) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, ["--input-type=module", "-e", CHILD, ...args], { encoding: "utf8" });
    let out = "";
    cp.stdout.on("data", (d) => { out += d; });
    cp.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

test("并行请求串行化：两个进程抢同一失败批次只有一个放行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retry-parallel-"));
  const file = join(dir, "retry-state.json");
  try {
    const [a, b] = await Promise.all([
      runChild([file, "A"]),
      runChild([file, "B"]),
    ]);
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    const decisions = [a.out, b.out].sort();
    assert.deepEqual(decisions, ["allow", "deny"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retry.decided 事件写进账本，旧字段仍在", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retry-ledger-"));
  const file = join(dir, "events.jsonl");
  const prev = process.env.CODE_TEAM_EVENTS_LEDGER;
  process.env.CODE_TEAM_EVENTS_LEDGER = file;
  try {
    const { recordEvent } = await import("../scripts/record-event.mjs");
    const d = evaluateRetry({
      request: request(),
      failedBatch: failedBatch(),
      worktreeEvidence: evidence(),
      continuationBrief: brief(),
      nowMs: RETRY_AT[0],
    }, { version: 1, batches: {} });
    recordEvent({ ...d.event, role: "worker", backend: "mcode-agent", project: "RC.DustFall", task: "P2 续派" });

    const row = JSON.parse(readFileSync(file, "utf8").trim());
    assert.equal(row.kind, "retry.decided");
    assert.equal(row.decision, "allow");
    assert.equal(row.failedBatchId, "batch-2026-11-24T160046Z");
    assert.equal(row.previousConcurrency, 3);
    assert.equal(row.requestedConcurrency, 1);
    assert.equal(row.reservedConcurrency, 1);
    assert.equal(row.worktreePath, WORKTREE);
    assert.equal(row.persistedWork, "已落盘 IisRemountPolicy");
    assert.equal(row.remainingWork, "IISManagerService 剩余部分");
    // 证据链字段也要落账本，否则事后查不了「凭哪几条证据放行的」。
    assert.equal(row.protocolCode, 42212);
    assert.equal(row.attemptId, "att-p2");
    assert.equal(row.taskId, "task-p2");
    // 钉死的那一次失败要落账本：事后查得到「凭哪一次 attempt 放行的」。
    assert.equal(row.childTurnId, "turn-p2");
    assert.equal(row.attemptMatched, true);
    assert.deepEqual(row.evidenceGaps, []);
    assert.equal(row.stateStatus, "ok");
    // 旧账本字段不受影响
    assert.equal(row.role, "worker");
    assert.equal(row.project, "RC.DustFall");
    assert.ok(row.at);
  } finally {
    if (prev === undefined) delete process.env.CODE_TEAM_EVENTS_LEDGER;
    else process.env.CODE_TEAM_EVENTS_LEDGER = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectWorktreeEvidence: 真实 git 仓库取 status 与基线后提交", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retry-wt-"));
  try {
    const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "worker@local"]);
    git(["config", "user.name", "worker"]);
    writeFileSync(join(dir, "a.txt"), "1\n");
    git(["add", "."]);
    git(["commit", "-qm", "P2 首次落盘"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    writeFileSync(join(dir, "b.txt"), "2\n");
    git(["add", "."]);
    git(["commit", "-qm", "P2 续派落盘"]);

    const clean = collectWorktreeEvidence(dir, { baseCommit: base });
    assert.equal(clean.ok, true);
    assert.equal(clean.hasCommits, true);
    assert.equal(clean.hasChanges, false);
    assert.equal(clean.statusEvidence.trim(), "");
    assert.equal(clean.relevantCommits.length, 1);
    assert.match(clean.relevantCommits[0].subject, /P2 续派落盘/);

    writeFileSync(join(dir, "c.txt"), "3\n");
    const dirty = collectWorktreeEvidence(dir, { baseCommit: base });
    assert.equal(dirty.hasChanges, true);
    assert.match(dirty.statusEvidence, /c\.txt/);

    const scoped = collectWorktreeEvidence(dir, { baseCommit: base, taskPatterns: ["P9"] });
    assert.equal(scoped.hasCommits, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectWorktreeEvidence: 拿不到基线提交 => 取证失败（不折成零落盘）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retry-wt-nobase-"));
  try {
    const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "worker@local"]);
    git(["config", "user.name", "worker"]);
    writeFileSync(join(dir, "a.txt"), "1\n");
    git(["add", "."]);
    git(["commit", "-qm", "P2 落盘"]);

    // 基线传空 => 看不见「已提交但工作树干净」的变更 => 取证失败（拒签），不是「零落盘」。
    const ev = collectWorktreeEvidence(dir, { baseCommit: null });
    assert.equal(ev.ok, false);
    assert.match(ev.error, /基线/);

    const d = evaluateRetry({
      request: request(),
      failedBatch: failedBatch({ worktreePath: dir }),
      worktreeEvidence: ev,
      continuationBrief: brief(),
      nowMs: RETRY_AT[0],
    }, { version: 1, batches: {} });
    assert.equal(d.decision, "deny");
    assert.match(d.reason, /工作树取证/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectWorktreeEvidence: git 子命令失败 => 取证失败（不折成无变更）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retry-wt-gitfail-"));
  try {
    const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "worker@local"]);
    git(["config", "user.name", "worker"]);
    writeFileSync(join(dir, "a.txt"), "1\n");
    git(["add", "."]);
    git(["commit", "-qm", "P2 落盘"]);

    // 基线不是合法 commit => git log 失败 => 取证失败，不折成「无提交 / 零落盘」。
    const ev = collectWorktreeEvidence(dir, { baseCommit: "not-a-commit" });
    assert.equal(ev.ok, false);
    assert.match(ev.error, /git/);

    const d = evaluateRetry({
      request: request(),
      failedBatch: failedBatch({ worktreePath: dir }),
      worktreeEvidence: ev,
      continuationBrief: brief(),
      nowMs: RETRY_AT[0],
    }, { version: 1, batches: {} });
    assert.equal(d.decision, "deny");
    assert.match(d.reason, /工作树取证/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("干净树 + 基线后有提交 => 判为「有落盘」（已提交的变更要看得见）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retry-wt-committed-"));
  try {
    const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "worker@local"]);
    git(["config", "user.name", "worker"]);
    writeFileSync(join(dir, "a.txt"), "1\n");
    git(["add", "."]);
    git(["commit", "-qm", "基线"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "b.txt"), "2\n");
    git(["add", "."]);
    git(["commit", "-qm", "P2 续派落盘"]);

    const ev = collectWorktreeEvidence(dir, { baseCommit: base });
    assert.equal(ev.ok, true);
    assert.equal(ev.hasCommits, true);
    assert.equal(ev.hasChanges, false);
    assert.equal(ev.statusEvidence.trim(), "");

    const d = evaluateRetry({
      request: request(),
      failedBatch: failedBatch({ worktreePath: dir }),
      worktreeEvidence: ev,
      continuationBrief: brief(),
      nowMs: RETRY_AT[0],
    }, { version: 1, batches: {} });
    assert.equal(d.decision, "allow");
    assert.equal(d.progress, "有落盘");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("取证失败（ok:false）=> 拒签，不放行", () => {
  const d = evaluateRetry({
    request: request(),
    failedBatch: failedBatch(),
    worktreeEvidence: { ok: false, error: "git log 失败（退出码 128）", worktreePath: WORKTREE },
    continuationBrief: brief(),
    nowMs: RETRY_AT[0],
  }, { version: 1, batches: {} });
  assert.equal(d.decision, "deny");
  assert.equal(d.failureKind, "unknown");
  assert.match(d.reason, /工作树取证/);
});

test("collectWorktreeEvidence: 干净树且无提交 => 零落盘（有证据），取证仍然可用", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-retry-wt-empty-"));
  try {
    const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "worker@local"]);
    git(["config", "user.name", "worker"]);
    writeFileSync(join(dir, "a.txt"), "1\n");
    git(["add", "."]);
    git(["commit", "-qm", "基线"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    const ev = collectWorktreeEvidence(dir, { baseCommit: base });
    assert.equal(ev.ok, true);
    assert.equal(ev.hasCommits, false);
    assert.equal(ev.hasChanges, false);
    assert.equal(ev.statusEvidence.trim(), "");
    // 取证可用：这样的证据能让判定承认「有证据的零落盘」。
    const d = evaluateRetry({
      request: request(),
      failedBatch: failedBatch({ worktreePath: dir }),
      worktreeEvidence: ev,
      continuationBrief: brief({ persistedWork: "" }),
      nowMs: RETRY_AT[0],
    }, { version: 1, batches: {} });
    assert.equal(d.decision, "allow");
    assert.equal(d.progress, "零落盘");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
