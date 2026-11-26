#!/usr/bin/env node
// 真实用量口径与单包成本闸的验收。
// 计量基准来自 2026-11-25 对 mcode-trajectory-studio 的实跑对账：
//   P9 首跑子会话  380 次调用 / 66,935,410 token（其中第一个 turn 231 次 / 23,109,952）
//   P9 续派子会话  433 次调用 / 40,636,353 token
// fixture 是这些记录的去标识副本，测试只读它，不连任何现场库。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TOKEN_LIMIT,
  TOOL_CALL_LIMIT,
  createMcpReader,
  evaluatePackageCost,
  readBindings,
  readLedgerEvents,
  readUsage,
  resolveStudioServerRoot,
} from "../scripts/trajectory-usage.mjs";
import {
  collectAttemptPackages,
  collectBindings,
  countWindowPackages,
  decideDispatchGate,
} from "../scripts/dispatch-guard.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "trajectory-usage");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 进程还在吗（不杀它，只问一声）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !pidAlive(pid);
}

function fixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

/** 把 fixture 当成子会话读出来；未知会话一律读失败（模拟「读不到」）。 */
function fixtureReader() {
  const sessions = {
    "sess-first-run": fixture("p9-first-run-session.json").records,
    "sess-continuation": fixture("p9-continuation-session.json").records,
  };
  return {
    async readSession({ childSessionId }) {
      if (!sessions[childSessionId]) {
        return { records: [], warnings: [], error: "session_not_found:" + childSessionId };
      }
      return { records: sessions[childSessionId], warnings: [] };
    },
  };
}

function readerOf(records, extra = {}) {
  return {
    async readSession() {
      return { records, warnings: [], ...extra };
    },
  };
}

function usageRecord({ at, tokens = 0, calls = 0, msgId = null, usage = null }) {
  return {
    msgId,
    turnId: "turn-1",
    role: "assistant",
    createdAtMs: at,
    toolCallCount: calls,
    usage: usage === null
      ? { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, totalTokens: tokens }
      : usage,
  };
}

test("真实首跑会话：逐条汇总对上 Studio 会话口径 380 次调用 / 66,935,410 token", async () => {
  const snapshot = await readUsage(
    { bindings: [{ packageId: "P9", childSessionId: "sess-first-run" }] },
    fixtureReader(),
  );
  const pkg = snapshot.packages.P9;
  assert.equal(pkg.usage.toolCalls, 380);
  assert.equal(pkg.usage.totalTokens, 66_935_410);
  assert.equal(pkg.coverage, "complete");
  assert.equal(evaluatePackageCost(snapshot, "P9"), "resplit");
});

test("真实首跑会话的第一个 turn：231 次调用 / 23,109,952 token", async () => {
  const snapshot = await readUsage(
    { bindings: [{ packageId: "P9", childSessionId: "sess-first-run", childTurnId: "turn-1" }] },
    fixtureReader(),
  );
  const pkg = snapshot.packages.P9;
  assert.equal(pkg.usage.toolCalls, 231);
  assert.equal(pkg.usage.totalTokens, 23_109_952);
  assert.equal(evaluatePackageCost(snapshot, "P9"), "split");
});

test("真实续派会话：433 次调用 / 40,636,353 token", async () => {
  const snapshot = await readUsage(
    { bindings: [{ packageId: "P9", childSessionId: "sess-continuation" }] },
    fixtureReader(),
  );
  const pkg = snapshot.packages.P9;
  assert.equal(pkg.usage.toolCalls, 433);
  assert.equal(pkg.usage.totalTokens, 40_636_353);
  assert.equal(evaluatePackageCost(snapshot, "P9"), "split");
});

test("逻辑包跨尝试汇总：首跑 + 续派 = 813 次调用 / 107,571,763 token", async () => {
  const snapshot = await readUsage(
    {
      bindings: [
        { packageId: "P9", attemptId: "a1", childSessionId: "sess-first-run" },
        { packageId: "P9", attemptId: "a2", childSessionId: "sess-continuation" },
      ],
    },
    fixtureReader(),
  );
  const pkg = snapshot.packages.P9;
  assert.equal(pkg.usage.toolCalls, 380 + 433);
  assert.equal(pkg.usage.totalTokens, 66_935_410 + 40_636_353);
  assert.equal(pkg.attempts.length, 2);
});

test("同一子会话被重复绑定（task_append 续派）只计一次", async () => {
  const snapshot = await readUsage(
    {
      bindings: [
        { packageId: "P9", attemptId: "a1", childSessionId: "sess-first-run" },
        { packageId: "P9", attemptId: "a2", childSessionId: "sess-first-run" },
      ],
    },
    fixtureReader(),
  );
  assert.equal(snapshot.packages.P9.usage.toolCalls, 380);
  assert.equal(snapshot.packages.P9.usage.totalTokens, 66_935_410);
});

test("阈值边界：恰好 200 次调用 / 恰好 60,000,000 token 都不触发", async () => {
  const snapshot = await readUsage(
    {
      bindings: [{ packageId: "B", childSessionId: "s" }],
    },
    readerOf([
      usageRecord({ at: 1, calls: 200, tokens: TOKEN_LIMIT }),
    ]),
  );
  assert.equal(snapshot.packages.B.usage.toolCalls, TOOL_CALL_LIMIT);
  assert.equal(snapshot.packages.B.usage.totalTokens, TOKEN_LIMIT);
  assert.equal(evaluatePackageCost(snapshot, "B"), "continue");
});

test("阈值边界：201 次调用 = 拆包", async () => {
  const snapshot = await readUsage(
    { bindings: [{ packageId: "B", childSessionId: "s" }] },
    readerOf([usageRecord({ at: 1, calls: 201, tokens: 10 })]),
  );
  assert.equal(evaluatePackageCost(snapshot, "B"), "split");
});

test("阈值边界：60,000,001 token = 重新拆包", async () => {
  const snapshot = await readUsage(
    { bindings: [{ packageId: "B", childSessionId: "s" }] },
    readerOf([usageRecord({ at: 1, calls: 1, tokens: TOKEN_LIMIT + 1 })]),
  );
  assert.equal(evaluatePackageCost(snapshot, "B"), "resplit");
});

test("两项同时越界时保留重拆结论", async () => {
  const snapshot = await readUsage(
    { bindings: [{ packageId: "B", childSessionId: "s" }] },
    readerOf([usageRecord({ at: 1, calls: 201, tokens: TOKEN_LIMIT + 1 })]),
  );
  assert.equal(evaluatePackageCost(snapshot, "B"), "resplit");
});

test("窗口归属：窗口外的记录只进累计，不进 5 小时窗口用量", async () => {
  const asOf = 1_000_000;
  const snapshot = await readUsage(
    {
      asOfMs: asOf,
      window: { fromMs: asOf - 1000, toMs: asOf },
      bindings: [{ packageId: "B", childSessionId: "s" }],
    },
    readerOf([
      usageRecord({ at: asOf - 500, calls: 1, tokens: 1000 }),
      usageRecord({ at: asOf - 5000, calls: 2, tokens: 2000 }),
    ]),
  );
  assert.equal(snapshot.packages.B.usage.totalTokens, 3000);
  assert.equal(snapshot.packages.B.usage.toolCalls, 3);
  assert.equal(snapshot.packages.B.windowUsage.totalTokens, 1000);
  assert.equal(snapshot.packages.B.windowUsage.toolCalls, 1);
});

test("读不到计量时是 unknown，不签发放行；已知下界已越阈值仍要求拆分", async () => {
  const missing = await readUsage(
    { bindings: [{ packageId: "B", childSessionId: "s" }] },
    readerOf([], { error: "session_not_found" }),
  );
  assert.equal(missing.packages.B.coverage, "unknown");
  assert.equal(evaluatePackageCost(missing, "B"), "unknown");

  const partial = await readUsage(
    { bindings: [{ packageId: "B", childSessionId: "s" }] },
    readerOf([{ msgId: "m-1", turnId: "turn-1", role: "assistant", createdAtMs: 1, toolCallCount: 0, usage: null }]),
  );
  assert.equal(partial.packages.B.coverage, "partial");
  assert.equal(evaluatePackageCost(partial, "B"), "unknown");

  const lowerBound = await readUsage(
    { bindings: [{ packageId: "B", childSessionId: "s" }] },
    readerOf(
      [usageRecord({ at: 1, calls: 201, tokens: 10 })],
      { warnings: ["records_unavailable"] },
    ),
  );
  assert.equal(lowerBound.packages.B.coverage, "partial");
  assert.equal(evaluatePackageCost(lowerBound, "B"), "split");
});

test("没有绑定就没有包，判定为 unknown", async () => {
  const snapshot = await readUsage({ bindings: [] }, fixtureReader());
  assert.equal(Object.keys(snapshot.packages).length, 0);
  assert.equal(evaluatePackageCost(snapshot, "P9"), "unknown");
});

test("窗口包数：kind call 与 kind dispatch 的 worker 派工记录取并集", () => {
  const asOf = Date.parse("2026-11-25T08:10:00Z");
  const at = (iso) => iso;
  const events = [
    { at: at("2026-11-25T07:52:34.414Z"), kind: "call", role: "worker", task: "A 自动闸门" },
    { at: at("2026-11-25T07:52:34.517Z"), kind: "call", role: "worker", task: "B 真实 usage" },
    { at: at("2026-11-25T08:05:04.734Z"), kind: "dispatch", role: "worker", task: "D brief 原样落盘" },
    { at: at("2026-11-25T08:05:04.843Z"), kind: "dispatch", role: "worker", task: "E 一次独立验收" },
  ];
  const { recent, dispatched } = countWindowPackages(events, { asOf });
  assert.equal(dispatched, 4);
  assert.equal(recent.length, 4);
  // 旧版只认 kind==="call"，这批会被少数 2 个包 —— 差异被用例锁住。
  const legacy = countWindowPackages(events.filter(e => e.kind === "call"), { asOf });
  assert.equal(legacy.dispatched, 2);
  // 两种拼法写同一个任务名时仍只算一个包。
  const same = countWindowPackages([
    { at: "2026-11-25T07:52:34.414Z", kind: "call", role: "worker", task: "P9" },
    { at: "2026-11-25T08:05:04.734Z", kind: "dispatch", role: "worker", task: "P9" },
  ], { asOf });
  assert.equal(same.dispatched, 1);
});

test("窗口包数：非执行侧角色与窗口外事件都不计入", () => {
  const asOf = Date.parse("2026-11-25T08:10:00Z");
  const { recent, dispatched } = countWindowPackages([
    { at: "2026-11-25T08:05:04.734Z", kind: "dispatch", role: "worker", task: "D" },
    { at: "2026-11-25T08:05:04.800Z", kind: "dispatch", role: "explore", task: "取证" },
    { at: "2026-11-25T08:05:04.900Z", kind: "codex-call", role: "overmind", task: "规划" },
    { at: "2026-11-25T00:00:00.000Z", kind: "dispatch", role: "worker", task: "窗口外" },
  ], { asOf });
  assert.equal(dispatched, 1);
  assert.equal(recent.length, 2);
});

test("账本绑定：带 childSessionId 的派工事件成为包绑定，缺包标识的记为未知", () => {
  const bindings = readBindings([
    { kind: "dispatch.started", packageId: "P9", attemptId: "a1", childSessionId: "sess-1", taskId: "bg_1" },
    { kind: "dispatch.started", packageId: "P9", attemptId: "a2", childSessionId: "sess-1", childTurnId: "turn-2" },
    { kind: "call", role: "worker", task: "P1 诊断" },
  ]);
  assert.equal(bindings.length, 2);
  assert.equal(bindings[0].packageId, "P9");
  assert.equal(bindings[0].childSessionId, "sess-1");
  assert.equal(bindings[1].childTurnId, "turn-2");
});


test("缺失记录与未知必须区分：指定不存在的 turn 是 unknown，不是 complete/continue", async () => {
  const snapshot = await readUsage(
    { bindings: [{ packageId: "P9", childSessionId: "sess-first-run", childTurnId: "turn-404" }] },
    fixtureReader(),
  );
  const pkg = snapshot.packages.P9;
  assert.equal(pkg.records, 0);
  assert.equal(pkg.coverage, "unknown");
  assert.equal(evaluatePackageCost(snapshot, "P9"), "unknown");
  assert.ok(pkg.warnings.some((w) => w.includes("target_turn_not_found")));
});

test("关键字段缺失的 usage 不能当 0 记账：覆盖降为 partial，结论 unknown", async () => {
  const snapshot = await readUsage(
    { bindings: [{ packageId: "B", childSessionId: "s" }] },
    readerOf([
      { msgId: "m-1", turnId: "turn-1", role: "assistant", createdAtMs: 1, toolCallCount: 1, usage: { inputTokens: 10 } },
    ]),
  );
  assert.equal(snapshot.packages.B.coverage, "partial");
  assert.equal(evaluatePackageCost(snapshot, "B"), "unknown");
});

test("绑定读取兼容宿主原生字段名：sub_session_id / sub_turn_id（含嵌套回执）", () => {
  const bindings = readBindings([
    { kind: "dispatch.started", packageId: "P9", attemptId: "a1", sub_session_id: "sess-host", sub_turn_id: "turn-9" },
    { kind: "dispatch.started", packageId: "P8", tool_response: { result: { sub_session_id: "sess-nested" } } },
    { kind: "dispatch.started", packageId: "P7", child_session_id: "sess-snake", child_turn_id: "turn-7" },
    { kind: "call", role: "worker", task: "没有子会话" },
  ]);
  assert.equal(bindings.length, 3);
  assert.equal(bindings[0].childSessionId, "sess-host");
  assert.equal(bindings[0].childTurnId, "turn-9");
  assert.equal(bindings[1].childSessionId, "sess-nested");
  assert.equal(bindings[2].childSessionId, "sess-snake");
  assert.equal(bindings[2].childTurnId, "turn-7");
});

test("历史尝试包从账本里收齐：worker 的 call/dispatch/dispatch-result 都算", () => {
  const attempts = collectAttemptPackages([
    { kind: "call", role: "worker", task: "P9 分页" },
    { kind: "dispatch", role: "worker", task: "P9 分页" },
    { kind: "dispatch-result", role: "worker", task: "P9 分页" },
    { kind: "dispatch", role: "worker", task: "P8 日志" },
    { kind: "dispatch", role: "explore", task: "取证" },
    { kind: "codex-call", role: "overmind", task: "规划" },
  ]);
  assert.deepEqual([...attempts.keys()].sort(), ["P8 日志", "P9 分页"]);
  assert.equal(attempts.get("P9 分页").count, 3);
});

test("放行/拒签判定：计量未知、缺绑定都拒签；第一次派工正常放行", () => {
  const attempts = new Map([["P9", { count: 2, lastAt: "2026-11-25T08:00:00Z" }]]);
  const unknownSnapshot = {
    packages: { P9: { coverage: "unknown", usage: { toolCalls: 0, totalTokens: 0 }, warnings: ["session_not_found"] } },
  };
  const completeSnapshot = {
    packages: { P9: { coverage: "complete", usage: { toolCalls: 10, totalTokens: 100 }, warnings: [] } },
  };

  // 没点名、没绑定，而账本里已有历史尝试 → 无法识别该判哪个包 → 拒签。
  const noIdentity = decideDispatchGate({ attempts });
  assert.equal(noIdentity.allowed, false);
  assert.equal(noIdentity.reasons.length, 1);

  // 账本里没有历史尝试 → 第一次派工 → 放行。
  const firstDispatch = decideDispatchGate({ attempts: new Map() });
  assert.equal(firstDispatch.allowed, true);
  assert.equal(firstDispatch.basis.length, 1);

  // 点名一个没有历史尝试的包 → 用量尚未产生 → 放行。
  const newPackage = decideDispatchGate({ requested: ["P-new"], attempts });
  assert.equal(newPackage.allowed, true);

  // 点名一个已有历史尝试的包但拿不到计量 → 拒签。
  const missingMetering = decideDispatchGate({ requested: ["P9"], attempts });
  assert.equal(missingMetering.allowed, false);
  assert.match(missingMetering.reasons[0], /拿不到计量/);

  // 计量读到了但覆盖不完整 → 拒签。
  const unknown = decideDispatchGate({ requested: ["P9"], attempts, snapshot: unknownSnapshot });
  assert.equal(unknown.allowed, false);
  assert.match(unknown.reasons[0], /用量未知/);

  // 计量完整且未越阈值 → 放行。
  const ok = decideDispatchGate({ requested: ["P9"], attempts, snapshot: completeSnapshot });
  assert.equal(ok.allowed, true);
  assert.match(ok.basis[0], /计量完整/);
});

test("同包两次尝试只绑定一次：该包计量不完整 → unknown，不是 continue", async () => {
  // 账本里同一个包两次尝试，第二次没拿到子会话绑定。
  const bindings = readBindings([
    { kind: "dispatch.started", packageId: "P9", attemptId: "a1", childSessionId: "sess-1" },
    { kind: "dispatch.started", packageId: "P9", attemptId: "a2" },
  ]);
  assert.equal(bindings.length, 2);
  assert.equal(bindings[0].childSessionId, "sess-1");
  assert.equal(bindings[1].childSessionId, null, "没绑定的尝试也必须出现在结果里");

  // 闸门收集绑定时也不能把它丢掉。
  const collected = collectBindings([], [
    { kind: "dispatch.started", packageId: "P9", attemptId: "a1", childSessionId: "sess-1" },
    { kind: "dispatch.started", packageId: "P9", attemptId: "a2" },
  ]);
  assert.equal(collected.length, 2);
  assert.equal(collected[1].childSessionId, null, "没绑定的尝试不能被闸门静默丢掉");

  const snapshot = await readUsage({ bindings }, readerOf([usageRecord({ at: 1, calls: 3, tokens: 100 })]));
  const pkg = snapshot.packages.P9;
  assert.equal(pkg.attempts.length, 2);
  assert.equal(pkg.attempts[1].bound, false);
  assert.equal(pkg.coverage, "unknown");
  assert.equal(evaluatePackageCost(snapshot, "P9"), "unknown");

  // 闸门层面：这份计量不能签发放行。
  const gate = decideDispatchGate({
    requested: ["P9"],
    attempts: new Map([["P9", { count: 2, lastAt: "2026-11-25T08:00:00Z" }]]),
    snapshot,
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.reasons[0], /用量未知/);
});

test("缺 toolCallCount 是缺值不是 0：覆盖 unknown，调用次数记为未知", async () => {
  const snapshot = await readUsage(
    { bindings: [{ packageId: "B", childSessionId: "s" }] },
    readerOf([
      {
        msgId: "m-1",
        turnId: "turn-1",
        role: "assistant",
        createdAtMs: 1,
        usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, totalTokens: 10 },
      },
    ]),
  );
  const pkg = snapshot.packages.B;
  assert.equal(pkg.coverage, "unknown");
  assert.equal(pkg.usage.toolCalls, null, "缺调用次数不能记成 0");
  assert.equal(evaluatePackageCost(snapshot, "B"), "unknown");
  assert.equal(snapshot.usage.toolCalls, null, "合计也不能把缺值当 0 加进去");
});

test("账本坏行不静默丢弃：绑定还在，但该包覆盖降为 unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-team-ledger-"));
  const file = join(dir, "events.jsonl");
  writeFileSync(file, [
    JSON.stringify({ kind: "dispatch.started", packageId: "P9", attemptId: "a1", childSessionId: "sess-1" }),
    "{ 这行不是合法 JSON",
    "",
  ].join("\n"), "utf8");

  const events = readLedgerEvents(file);
  assert.equal(events.filter((e) => e && e.corrupt === true).length, 1, "坏行必须被标记，不能丢掉");
  const bindings = readBindings(events);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].corrupt, true);

  const snapshot = await readUsage({ bindings }, readerOf([usageRecord({ at: 1, calls: 3, tokens: 100 })]));
  assert.equal(snapshot.packages.P9.coverage, "unknown");
  assert.equal(evaluatePackageCost(snapshot, "P9"), "unknown");
});

test("该包没有任何尝试（首次派工）：仍然放行", () => {
  const attempts = new Map([["P9", { count: 2, lastAt: "2026-11-25T08:00:00Z" }]]);
  const gate = decideDispatchGate({ requested: ["P-new"], attempts, snapshot: { packages: {} } });
  assert.equal(gate.allowed, true);
  assert.match(gate.basis[0], /第一次派工/);
});

test("MCP deadline：无响应 server 也要按期限返回错误，父进程自然退出且不留 server 进程", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-team-deadline-"));
  const fakeRoot = join(dir, "studio");
  mkdirSync(join(fakeRoot, "server"), { recursive: true });
  // 无响应 server：收下请求但永不回。
  writeFileSync(join(fakeRoot, "server", "main.mjs"), [
    'import { createInterface } from "node:readline";',
    'createInterface({ input: process.stdin }).on("line", () => {});',
    "",
  ].join("\n"), "utf8");

  const script = join(dir, "driver.mjs");
  writeFileSync(script, [
    'import { createMcpReader } from ' + JSON.stringify(pathToFileURL(join(ROOT, "scripts", "trajectory-usage.mjs")).href) + ';',
    "const reader = createMcpReader({ serverRoot: " + JSON.stringify(fakeRoot) + " });",
    "let pid = null;",
    "const timer = setInterval(() => { if (!pid && reader.pid) pid = reader.pid; }, 5);",
    "const t0 = Date.now();",
    'const res = await reader.readSession({ childSessionId: "sess-nope", deadlineMs: 100 });',
    "const elapsed = Date.now() - t0;",
    "clearInterval(timer);",
    'console.log(JSON.stringify({ pid, error: res.error || null, elapsed }));',
    "// 故意不 close()：父进程必须照样自然退出。",
    "",
  ].join("\n"), "utf8");

  const out = spawnSync(process.execPath, [script], { timeout: 60000, encoding: "utf8" });
  assert.equal(out.signal, null, "父进程被 MCP 子进程吊住了（signal=" + out.signal + "）");
  assert.equal(out.status, 0, "子脚本应自然退出：" + out.stderr);
  const info = JSON.parse(String(out.stdout).trim());
  assert.match(String(info.error), /mcp_deadline_exceeded/, "deadline 没生效，错误=" + info.error);
  assert.ok(info.elapsed < 5000, "deadline 没生效，耗时 " + info.elapsed + "ms");
  assert.ok(info.pid > 0, "应拿到 server 子进程 pid");
  assert.equal(await waitPidGone(info.pid, 5000), true, "server 进程 " + info.pid + " 没被带走");
});

test("MCP reader：调用方忘了 close 也不能吊住父进程，且不留孤儿 server 进程", async (t) => {
  if (!resolveStudioServerRoot()) {
    t.skip("本机没有 mcode-trajectory-studio，跳过");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "code-team-reader-"));
  const script = join(dir, "reader.mjs");
  writeFileSync(script, [
    `import { createMcpReader } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts", "trajectory-usage.mjs")).href)};`,
    "const reader = createMcpReader();",
    'const res = await reader.readSession({ childSessionId: "sess-does-not-exist-zzz" });',
    "console.log(JSON.stringify({ pid: reader.pid, error: res.error || null }));",
    "// 故意不 close()：父进程必须照样自然退出。",
    "",
  ].join("\n"), "utf8");

  const out = spawnSync(process.execPath, [script], { timeout: 60000, encoding: "utf8" });
  assert.equal(out.signal, null, "父进程被 MCP 子进程吊住了（signal=" + out.signal + "）");
  assert.equal(out.status, 0, "子脚本应自然退出：" + out.stderr);
  const info = JSON.parse(String(out.stdout).trim());
  assert.ok(info.pid > 0, "应拿到 server 子进程 pid");
  assert.equal(await waitPidGone(info.pid, 5000), true, "server 进程 " + info.pid + " 成了孤儿，没被带走");
});
