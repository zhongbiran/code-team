import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  evaluateVerification, recordVerificationStarted, recordVerificationOutcome, recordSelfEvidence,
  decideAndPersistVerification, recordAndPersistVerification, loadVerificationState, saveVerificationState,
  parseVerificationMarker, verificationKeyOf, setPublishedPackagesProvider,
} from "../scripts/verification-policy.mjs";

const execFileAsync = promisify(execFile);
const MODULE_URL = pathToFileURL(join(import.meta.dirname, "..", "scripts", "verification-policy.mjs")).href;

const PROJECT = "d:/projects/x";
const PLAN = "P1";
const CRITERIA = "crit-1";
const KEY = verificationKeyOf({ projectKey: PROJECT, planId: PLAN, criteriaRevisionId: CRITERIA });

// 包完成证据：只有「终结成功 + 对应 attempt」才算完成。
const done = (packageId) => ({ packageId, status: "completed", attemptId: "attempt-" + packageId });

const request = (over = {}) => ({
  projectKey: PROJECT,
  planId: PLAN,
  criteriaRevisionId: CRITERIA,
  completedPackages: [done("P1"), done("P2")],
  expectedPackages: ["P1", "P2"],
  requestKey: "req-1",
  ...over,
});

// 回放：预留 → 启动 → 首轮 FAIL → 执行者按原失败命令自证。
function failThenSelfEvidence(state) {
  let s = state;
  s = recordVerificationStarted(
    { verificationKey: KEY, requestKey: "req-1", taskId: "task-1", childSessionId: "child-1" },
    s,
  );
  s = recordVerificationOutcome(
    {
      verificationKey: KEY,
      taskId: "task-1",
      verdict: "fail",
      evidence: {
        commands: ["node --test test/verification-policy.test.mjs"],
        exitCodes: [1],
        outputRefs: ["out/task-1.log"],
      },
    },
    s,
  );
  return s;
}

const selfEvidence = (over = {}) => ({
  verificationKey: KEY,
  packageId: "P2",
  commands: ["node --test test/verification-policy.test.mjs"],
  exitCodes: [0],
  outputRefs: ["out/task-1.log"],
  commit: "abc1234",
  ...over,
});

test("首次派工：同一口径下预留一次，实际启动 0 次", () => {
  const d = evaluateVerification(request(), { version: 1, verifications: {} });
  assert.equal(d.decision, "allow");
  assert.equal(d.allowed, true);
  assert.equal(d.action, "reserve");
  assert.equal(d.verificationKey, KEY);
  assert.equal(d.nextState.verifications[KEY].reservedCount, 1);
  assert.equal(d.nextState.verifications[KEY].startedCount, 0);
  assert.equal(d.event.kind, "verification.reserved");
  assert.equal(d.event.verificationKey, KEY);
  assert.equal(d.event.criteriaRevisionId, CRITERIA);
  assert.equal(d.event.requestKey, "req-1");
});

test("同请求重放：同一 requestKey 幂等放行，不重复占用名额", () => {
  const first = evaluateVerification(request(), { version: 1, verifications: {} });
  const second = evaluateVerification(request(), first.nextState);
  assert.equal(second.decision, "allow");
  assert.equal(second.action, "replay");
  assert.equal(second.nextState.verifications[KEY].reservedCount, 1);
});

test("换个 requestKey 再预留同一口径：拒绝", () => {
  const first = evaluateVerification(request(), { version: 1, verifications: {} });
  const second = evaluateVerification(request({ requestKey: "req-2" }), first.nextState);
  assert.equal(second.decision, "deny");
  assert.equal(second.allowed, false);
  assert.match(second.reason, /已预留/);
});

test("首轮 FAIL + 执行者自证后不得再派 Verifier：实际启动次数为 1", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const failed = failThenSelfEvidence(reserved.nextState);
  const selfed = recordSelfEvidence(selfEvidence(), failed);
  const again = evaluateVerification(request({ requestKey: "req-2" }), selfed);

  assert.equal(again.decision, "deny");
  assert.match(again.reason, /自证/);
  assert.equal(again.startedCount, 1, "Verifier 实际启动次数必须为 1");
  assert.equal(again.nextState.verifications[KEY].startedCount, 1);
  assert.equal(again.nextState.verifications[KEY].selfEvidence.length, 1);
  assert.equal(again.nextState.verifications[KEY].selfEvidence[0].accepted, true);
});

test("首轮 PASS 后不得再派 Verifier", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const started = recordVerificationStarted({ verificationKey: KEY, requestKey: "req-1", taskId: "task-1" }, reserved.nextState);
  const passed = recordVerificationOutcome({ verificationKey: KEY, verdict: "pass", evidence: { outputRefs: ["out/ok.log"] } }, started);
  const again = evaluateVerification(request({ requestKey: "req-2" }), passed);
  assert.equal(again.decision, "deny");
  assert.equal(again.startedCount, 1);
});

test("普通补丁不重置名额：口径键不变，plan 内容修订也算同一轮", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const again = evaluateVerification(
    request({ requestKey: "req-2", completedPackages: [done("P1"), done("P2"), done("P3")] }),
    reserved.nextState,
  );
  assert.equal(again.decision, "deny");
  assert.equal(again.verificationKey, KEY);
});

test("验收口径实质变更：允许新一轮，并追溯到具体差异", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const failed = failThenSelfEvidence(reserved.nextState);
  const change = {
    fromCriteriaRevisionId: CRITERIA,
    toCriteriaRevisionId: "crit-2",
    oldCriteria: "node --test test/verification-policy.test.mjs",
    newCriteria: "node --test test/verification-policy.test.mjs && node scripts/lessons.mjs check",
    diffs: ["验收命令从只跑单测改为单测 + lessons check"],
    approvedBy: "overmind",
  };
  const next = evaluateVerification(
    request({ requestKey: "req-3", criteriaRevisionId: "crit-2", criteriaChange: change }),
    failed,
  );

  assert.equal(next.decision, "allow");
  assert.equal(next.action, "new-round");
  const newKey = verificationKeyOf({ projectKey: PROJECT, planId: PLAN, criteriaRevisionId: "crit-2" });
  assert.equal(next.verificationKey, newKey);
  assert.notEqual(newKey, KEY);

  const lineage = next.nextState.criteriaLineage[KEY];
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0].toVerificationKey, newKey);
  assert.deepEqual(lineage[0].diffs, change.diffs);
  assert.equal(lineage[0].approvedBy, "overmind");
  // 旧口径的名额不因口径变更而复活
  assert.equal(next.nextState.verifications[KEY].startedCount, 1);
});

test("口径变更必须带具体差异：没有差异不算实质变更", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const d = evaluateVerification(
    request({
      requestKey: "req-3",
      criteriaRevisionId: "crit-2",
      criteriaChange: { fromCriteriaRevisionId: CRITERIA, toCriteriaRevisionId: "crit-2", diffs: [] },
    }),
    reserved.nextState,
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /具体差异/);
});

test("口径变更：新旧口径相同不算实质变更", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const d = evaluateVerification(
    request({
      requestKey: "req-3",
      criteriaChange: { fromCriteriaRevisionId: CRITERIA, toCriteriaRevisionId: CRITERIA, diffs: ["改了个说法"] },
    }),
    reserved.nextState,
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /相同/);
});

test("口径变更：请求的口径键与声明的新口径不一致时拒绝", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const d = evaluateVerification(
    request({
      requestKey: "req-3",
      criteriaRevisionId: "crit-9",
      criteriaChange: { fromCriteriaRevisionId: CRITERIA, toCriteriaRevisionId: "crit-2", diffs: ["换了口径"] },
    }),
    reserved.nextState,
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /不一致/);
});

test("新口径下同样只验一次", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const change = {
    fromCriteriaRevisionId: CRITERIA,
    toCriteriaRevisionId: "crit-2",
    oldCriteria: "node --test test/verification-policy.test.mjs",
    newCriteria: "node --test test/verification-policy.test.mjs && node scripts/lessons.mjs check",
    diffs: ["验收命令改了"],
    approvedBy: "overmind",
  };
  const first = evaluateVerification(
    request({ requestKey: "req-3", criteriaRevisionId: "crit-2", criteriaChange: change }),
    reserved.nextState,
  );
  assert.equal(first.decision, "allow");
  const second = evaluateVerification(
    request({ requestKey: "req-4", criteriaRevisionId: "crit-2", criteriaChange: change }),
    first.nextState,
  );
  assert.equal(second.decision, "deny");
});

test("包没全部完成时不给整体验收（预期集合里有未完成的包）", () => {
  const d = evaluateVerification(
    request({ completedPackages: [done("P1")] }),
    { version: 1, verifications: {} },
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /包未全部完成/);
  assert.match(d.reason, /P2/);
});

test("自证必须覆盖首轮失败命令、退出码为 0、带提交号", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const failed = failThenSelfEvidence(reserved.nextState);

  const last = (s) => s.verifications[KEY].selfEvidence.at(-1);

  const wrongCmd = recordSelfEvidence(selfEvidence({ commands: ["echo hi"], exitCodes: [0] }), failed);
  assert.equal(last(wrongCmd).accepted, false);
  assert.match(last(wrongCmd).reason, /未覆盖首轮失败命令/);

  const badCode = recordSelfEvidence(selfEvidence({ exitCodes: [1] }), failed);
  assert.equal(last(badCode).accepted, false);
  assert.match(last(badCode).reason, /非零退出码/);

  const noCommit = recordSelfEvidence(selfEvidence({ commit: null }), failed);
  assert.equal(last(noCommit).accepted, false);
  assert.match(last(noCommit).reason, /提交号/);

  const ok = recordSelfEvidence(selfEvidence(), failed);
  assert.equal(last(ok).accepted, true);
});

test("状态迁移非法时报错：未启动不能记结果、未 FAIL 不能自证", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  assert.throws(() => recordVerificationOutcome({ verificationKey: KEY, verdict: "pass" }, reserved.nextState), /尚未启动/);
  assert.throws(() => recordSelfEvidence(selfEvidence(), reserved.nextState), /首轮 FAIL/);
  assert.throws(() => recordVerificationStarted({ verificationKey: KEY }, { version: 1, verifications: {} }), /不存在/);
});

test("事件形状齐整：reserved / started / result / self-evidence", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const started = recordVerificationStarted({ verificationKey: KEY, requestKey: "req-1", taskId: "task-1" }, reserved.nextState);
  const failed = recordVerificationOutcome(
    { verificationKey: KEY, taskId: "task-1", verdict: "fail", evidence: { commands: ["cmd"], exitCodes: [1], outputRefs: ["out/a.log"] } },
    started,
  );
  const selfed = recordSelfEvidence(selfEvidence(), failed);
  const kinds = selfed.verifications[KEY].history.map((h) => h.kind);
  assert.deepEqual(kinds, ["verification.reserved", "verification.started", "verification.result", "verification.self-evidence"]);
  for (const ev of selfed.verifications[KEY].history) {
    assert.equal(ev.verificationKey, KEY);
    assert.equal(ev.criteriaRevisionId, CRITERIA);
    assert.equal(ev.projectKey, PROJECT);
    assert.ok(Array.isArray(ev.evidenceRefs));
  }
});

test("重启：状态落盘后重新加载，名额与结论都还在", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-verify-restart-"));
  const file = join(dir, "verification-state.json");
  try {
    const reserved = decideAndPersistVerification({ stateFile: file, request: request() });
    assert.equal(reserved.decision, "allow");
    recordAndPersistVerification({
      stateFile: file,
      action: "started",
      payload: { verificationKey: KEY, requestKey: "req-1", taskId: "task-1" },
    });
    recordAndPersistVerification({
      stateFile: file,
      action: "result",
      payload: { verificationKey: KEY, taskId: "task-1", verdict: "fail", evidence: { commands: ["cmd"], exitCodes: [1], outputRefs: ["out/task-1.log"] } },
    });

    const reloaded = loadVerificationState(file);
    assert.equal(reloaded.verifications[KEY].status, "failed");
    assert.equal(reloaded.verifications[KEY].startedCount, 1);

    const again = decideAndPersistVerification({ stateFile: file, request: request({ requestKey: "req-2" }) });
    assert.equal(again.decision, "deny");
    assert.equal(again.startedCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("并发：两个进程同时抢同一个验收口径，只有一个拿到名额", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-verify-race-"));
  const file = join(dir, "verification-state.json");
  const helper = join(dir, "decide.mjs");
  writeFileSync(
    helper,
    `import { decideAndPersistVerification } from "${MODULE_URL}";\n` +
      `const d = decideAndPersistVerification({ stateFile: process.argv[2], request: JSON.parse(process.argv[3]) });\n` +
      `console.log(JSON.stringify({ decision: d.decision, action: d.action }));\n`,
    "utf8",
  );
  const req = (rk) => JSON.stringify(request({ requestKey: rk }));
  try {
    const results = await Promise.all([
      execFileAsync(process.execPath, [helper, file, req("req-a")]),
      execFileAsync(process.execPath, [helper, file, req("req-b")]),
    ]);
    const decisions = results.map((r) => JSON.parse(r.stdout.trim()).decision);
    assert.deepEqual(decisions.sort(), ["allow", "deny"]);
    const state = loadVerificationState(file);
    assert.equal(state.verifications[KEY].reservedCount, 1);
    assert.equal(state.verifications[KEY].startedCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Task prompt 标记能解析出口径键", () => {
  const parsed = parseVerificationMarker(
    'code-team-plan: P1\ncode-team-verification-key: {"projectKey":"d:/x","planId":"P1","criteriaRevisionId":"crit-1"}',
  );
  assert.equal(parsed.planId, "P1");
  assert.equal(parsed.criteriaRevisionId, "crit-1");
  assert.equal(parseVerificationMarker("没有标记"), null);
});

test("saveVerificationState 写出的状态能被重新读回", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-verify-save-"));
  const file = join(dir, "nested", "verification-state.json");
  try {
    const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
    saveVerificationState(file, reserved.nextState);
    const back = loadVerificationState(file);
    assert.equal(back.verifications[KEY].reservedCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("只改口径 ID（不给变更声明）拿不到新名额", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const failed = failThenSelfEvidence(reserved.nextState);
  const d = evaluateVerification(request({ requestKey: "req-2", criteriaRevisionId: "crit-2" }), failed);

  assert.equal(d.decision, "deny");
  assert.match(d.reason, /criteriaChange/);
  assert.equal(d.startedCount, 1, "Verifier 实际启动次数必须还是 1");
  assert.equal(Object.keys(d.nextState.verifications).length, 1, "不得凭空多出一条验收记录");
});

test("只换 planId 不重置名额：plan 不是口径，仍是同一轮", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const failed = failThenSelfEvidence(reserved.nextState);
  const d = evaluateVerification(request({ requestKey: "req-2", planId: "P2" }), failed);

  assert.equal(d.decision, "deny");
  assert.match(d.reason, /自证/);
  assert.equal(d.startedCount, 1);
  assert.equal(Object.keys(d.nextState.verifications).length, 1);
});

test("换 planId 也不能重开已预留的那一轮", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const d = evaluateVerification(request({ requestKey: "req-2", planId: "P2" }), reserved.nextState);
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /已预留/);
});

test("口径变更缺批准人：拒", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const d = evaluateVerification(
    request({
      requestKey: "req-3",
      criteriaRevisionId: "crit-2",
      criteriaChange: {
        fromCriteriaRevisionId: CRITERIA,
        toCriteriaRevisionId: "crit-2",
        oldCriteria: "旧口径",
        newCriteria: "新口径",
        diffs: ["换口径"],
      },
    }),
    reserved.nextState,
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /批准人/);
});

test("口径变更新旧口径文本相同：拒", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const d = evaluateVerification(
    request({
      requestKey: "req-3",
      criteriaRevisionId: "crit-2",
      criteriaChange: {
        fromCriteriaRevisionId: CRITERIA,
        toCriteriaRevisionId: "crit-2",
        oldCriteria: "同一段口径",
        newCriteria: "同一段口径",
        diffs: ["换口径"],
        approvedBy: "overmind",
      },
    }),
    reserved.nextState,
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /相同/);
});

test("口径变更引用的旧验收键不存在：拒", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const d = evaluateVerification(
    request({
      requestKey: "req-3",
      criteriaRevisionId: "crit-2",
      criteriaChange: {
        fromCriteriaRevisionId: "crit-0",
        toCriteriaRevisionId: "crit-2",
        oldCriteria: "旧口径",
        newCriteria: "新口径",
        diffs: ["换口径"],
        approvedBy: "overmind",
      },
    }),
    reserved.nextState,
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /旧验收键不存在/);
});

test("空证据引用：不得记成通过", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const started = recordVerificationStarted(
    { verificationKey: KEY, requestKey: "req-1", taskId: "task-1" },
    reserved.nextState,
  );
  assert.throws(
    () => recordVerificationOutcome({ verificationKey: KEY, taskId: "task-1", verdict: "pass", evidence: { outputRefs: [] } }, started),
    /证据引用为空/,
  );
  assert.throws(
    () => recordVerificationOutcome({ verificationKey: KEY, taskId: "task-1", verdict: "pass" }, started),
    /证据引用为空/,
  );
  assert.equal(started.verifications[KEY].status, "started", "无效结果不得落到状态机里");
});

test("整批完成按已发布计划的预期包集合判定", () => {
  setPublishedPackagesProvider(() => [{ packageId: "P1" }, { packageId: "P2" }]);
  try {
    const missing = evaluateVerification(
      request({ completedPackages: [done("P1")], expectedPackages: undefined }),
      { version: 1, verifications: {} },
    );
    assert.equal(missing.decision, "deny");
    assert.match(missing.reason, /包未全部完成/);
    assert.match(missing.reason, /P2/);

    const all = evaluateVerification(
      request({ expectedPackages: undefined }),
      { version: 1, verifications: {} },
    );
    assert.equal(all.decision, "allow");
    assert.equal(all.expectedPackagesKnown, true);
  } finally {
    setPublishedPackagesProvider(null);
  }
});

test("自证缺输出引用 / 首轮没记命令：都不算有效自证", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const failed = failThenSelfEvidence(reserved.nextState);

  const noRefs = recordSelfEvidence(selfEvidence({ outputRefs: [] }), failed);
  assert.equal(noRefs.verifications[KEY].selfEvidence.at(-1).accepted, false);
  assert.match(noRefs.verifications[KEY].selfEvidence.at(-1).reason, /输出引用/);

  const started = recordVerificationStarted(
    { verificationKey: KEY, requestKey: "req-1", taskId: "task-1" },
    reserved.nextState,
  );
  const failedNoCmd = recordVerificationOutcome(
    { verificationKey: KEY, taskId: "task-1", verdict: "fail", evidence: { outputRefs: ["out/task-1.log"] } },
    started,
  );
  const unrelated = recordSelfEvidence(selfEvidence({ commands: ["echo unrelated"] }), failedNoCmd);
  assert.equal(unrelated.verifications[KEY].selfEvidence.at(-1).accepted, false);
  assert.match(unrelated.verifications[KEY].selfEvidence.at(-1).reason, /首轮失败未记录命令/);
});

test("无效自证不得据此再开一轮", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const failed = failThenSelfEvidence(reserved.nextState);
  const bad = recordSelfEvidence(selfEvidence({ commands: ["echo unrelated"] }), failed);

  const same = evaluateVerification(request({ requestKey: "req-2" }), bad);
  assert.equal(same.decision, "deny");
  const newCriteria = evaluateVerification(request({ requestKey: "req-3", criteriaRevisionId: "crit-2" }), bad);
  assert.equal(newCriteria.decision, "deny");
  assert.equal(newCriteria.startedCount, 1);
});

// --- 复验缺陷①：完成 ≠ 预留；预期包集合未知不得放行 ---

test("缺陷①：只有预留的包不算完成，不能整批验收", () => {
  const reservedOnly = [
    { packageId: "P1", status: "reserved" },
    { packageId: "P2", status: "reserved" },
  ];
  const d = evaluateVerification(request({ completedPackages: reservedOnly }), { version: 1, verifications: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /包未全部完成/);
  assert.match(d.reason, /P1/);
  assert.match(d.reason, /P2/);
});

test("缺陷①：旧写法（纯包号字符串）不算完成证据", () => {
  const d = evaluateVerification(request({ completedPackages: ["P1", "P2"] }), { version: 1, verifications: {} });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /包未全部完成/);
});

test("缺陷①：运行中 / 失败的包不算完成", () => {
  for (const status of ["running", "started", "failed", "error"]) {
    const d = evaluateVerification(
      request({ completedPackages: [{ packageId: "P1", status: "completed", attemptId: "a1" }, { packageId: "P2", status }] }),
      { version: 1, verifications: {} },
    );
    assert.equal(d.decision, "deny", status + " 不得算完成");
    assert.match(d.reason, /包未全部完成/);
  }
});

test("缺陷①：预期包集合未知（没有发布清单）：拒签", () => {
  const d = evaluateVerification(
    request({ expectedPackages: undefined, planRevisionId: "没有发布过的版本" }),
    { version: 1, verifications: {} },
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /预期包集合未知/);
  assert.equal(d.expectedPackagesKnown, false);
});

test("缺陷①：只给数量不给集合：不得当作集合已知", () => {
  const d = evaluateVerification(
    request({ expectedPackages: undefined, expectedPackageCount: 2 }),
    { version: 1, verifications: {} },
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /预期包集合未知/);
});

test("缺陷①：缺发布清单与包未全部完成分开报", () => {
  const unknown = evaluateVerification(request({ expectedPackages: undefined }), { version: 1, verifications: {} });
  const missing = evaluateVerification(request({ completedPackages: [done("P1")] }), { version: 1, verifications: {} });
  assert.match(unknown.reason, /预期包集合未知/);
  assert.doesNotMatch(unknown.reason, /包未全部完成/);
  assert.match(missing.reason, /包未全部完成/);
  assert.doesNotMatch(missing.reason, /预期包集合未知/);
});

// --- 复验缺陷②：状态与自证不能被错误数据推进 ---

test("缺陷②：空状态对象 {} 不得当空状态放行", () => {
  const d = evaluateVerification(request(), {});
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /状态/);
});

test("缺陷②：状态缺字段 / 版本不认识：拒签", () => {
  const noVersion = evaluateVerification(request(), { verifications: {} });
  assert.equal(noVersion.decision, "deny");
  const badVersion = evaluateVerification(request(), { version: 99, verifications: {} });
  assert.equal(badVersion.decision, "deny");
  const badRecord = evaluateVerification(
    request(),
    { version: 1, verifications: { [KEY]: { status: "reserved" } } },
  );
  assert.equal(badRecord.decision, "deny");
});

test("缺陷②：状态文件不是合法 JSON：落盘入口拒签", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-verify-broken-"));
  const file = join(dir, "verification-state.json");
  try {
    writeFileSync(file, "{ 这不是 JSON", "utf8");
    const d = decideAndPersistVerification({ stateFile: file, request: request() });
    assert.equal(d.decision, "deny");
    assert.equal(d.allowed, false);
    assert.match(d.reason, /状态/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺陷②：状态落盘位置不可用（锁/目录异常）：拒签而不是抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-verify-lock-"));
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x", "utf8");
  try {
    const d = decideAndPersistVerification({ stateFile: join(blocker, "verification-state.json"), request: request() });
    assert.equal(d.decision, "deny");
    assert.match(d.reason, /状态不可用/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺陷②：旧验收键的口径版本与声明的 from 版本不一致：拒", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const change = {
    fromVerificationKey: KEY,
    fromCriteriaRevisionId: "crit-0",
    toCriteriaRevisionId: "crit-2",
    oldCriteria: "旧口径",
    newCriteria: "新口径",
    diffs: ["换口径"],
    approvedBy: "overmind",
  };
  const d = evaluateVerification(
    request({ requestKey: "req-3", criteriaRevisionId: "crit-2", criteriaChange: change }),
    reserved.nextState,
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /不一致/);
  assert.equal(Object.keys(d.nextState.verifications).length, 1, "不得凭空多出一条验收记录");
});

test("缺陷②：批准人是空白 / 占位：拒", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  for (const approvedBy of ["   ", "n/a", "none", "待定"]) {
    const d = evaluateVerification(
      request({
        requestKey: "req-3",
        criteriaRevisionId: "crit-2",
        criteriaChange: {
          fromCriteriaRevisionId: CRITERIA,
          toCriteriaRevisionId: "crit-2",
          oldCriteria: "旧口径",
          newCriteria: "新口径",
          diffs: ["换口径"],
          approvedBy,
        },
      }),
      reserved.nextState,
    );
    assert.equal(d.decision, "deny", JSON.stringify(approvedBy) + " 不得算批准人");
    assert.match(d.reason, /批准人/);
  }
});

test("缺陷②：差异是空白 / 占位：不算实质变更", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const d = evaluateVerification(
    request({
      requestKey: "req-3",
      criteriaRevisionId: "crit-2",
      criteriaChange: {
        fromCriteriaRevisionId: CRITERIA,
        toCriteriaRevisionId: "crit-2",
        oldCriteria: "旧口径",
        newCriteria: "新口径",
        diffs: ["  ", "无"],
        approvedBy: "overmind",
      },
    }),
    reserved.nextState,
  );
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /具体差异/);
});

test("缺陷②：自证 null 退出码 / 空白提交号：accepted:false 且不推进验收记录", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const failed = failThenSelfEvidence(reserved.nextState);

  const nullCode = recordSelfEvidence(selfEvidence({ exitCodes: [null] }), failed);
  assert.equal(nullCode.verifications[KEY].selfEvidence.at(-1).accepted, false);
  assert.match(nullCode.verifications[KEY].selfEvidence.at(-1).reason, /退出码/);
  assert.equal(nullCode.verifications[KEY].status, "failed", "无效自证不得推进验收记录");

  const blankCommit = recordSelfEvidence(selfEvidence({ commit: "   " }), failed);
  assert.equal(blankCommit.verifications[KEY].selfEvidence.at(-1).accepted, false);
  assert.match(blankCommit.verifications[KEY].selfEvidence.at(-1).reason, /提交号/);
  assert.equal(blankCommit.verifications[KEY].status, "failed");

  const again = evaluateVerification(request({ requestKey: "req-2" }), blankCommit);
  assert.equal(again.decision, "deny", "无效自证不得据此再开一轮");
  assert.equal(again.startedCount, 1);
});

test("缺陷②：验收结论的退出码为 null / 空白：不得记成通过", () => {
  const reserved = evaluateVerification(request(), { version: 1, verifications: {} });
  const started = recordVerificationStarted(
    { verificationKey: KEY, requestKey: "req-1", taskId: "task-1" },
    reserved.nextState,
  );
  assert.throws(
    () => recordVerificationOutcome(
      { verificationKey: KEY, taskId: "task-1", verdict: "pass", evidence: { commands: ["cmd"], exitCodes: [null], outputRefs: ["out/a.log"] } },
      started,
    ),
    /退出码非法/,
  );
  assert.throws(
    () => recordVerificationOutcome(
      { verificationKey: KEY, taskId: "task-1", verdict: "pass", evidence: { commands: ["cmd"], exitCodes: [1], outputRefs: ["out/a.log"] } },
      started,
    ),
    /非零退出码/,
  );
  assert.equal(started.verifications[KEY].status, "started", "无效结果不得落到状态机里");
});

test("缺陷②：请求缺口径键字段：拒签", () => {
  for (const field of ["projectKey", "planId", "criteriaRevisionId"]) {
    const req = request();
    delete req[field];
    const d = evaluateVerification(req, { version: 1, verifications: {} });
    assert.equal(d.decision, "deny", field + " 缺失必须拒签");
    assert.match(d.reason, /口径键/);
  }
});
