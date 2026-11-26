#!/usr/bin/env node
// 派工闸门（宿主 hook）的回归。
//
// 覆盖：hook 注册、编译闸、文件归属互斥、非 .NET 适用范围、普通角色路由、
// 同请求重放、闸门开关、BOM、模块缺失降级，以及 B/C/D/E 四个模块的真实接线。
//
// 2026-11-26 第二轮独立验收（8 条缺陷）里本包负责 4 条，回归写在文件末尾：
//   ① 续派证据按 taskId + attemptId + 项目 + 计划关联（请求 A 不得吃 B 的失败）
//   ② Code Team 首派强制引用 + 按工具正文键注入（task→prompt / task_append→content）
//   ③ 加载失败 / 坏输入 / 事件信封 / 超时都不得放行
//   ④ 原并发按批次实际启动区间恢复 + 基线提交看得见已提交变更 + git 失败拒签
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "scripts", "dispatch-hook.mjs");

let seq = 0;
function tmpDir(tag) {
  const d = join(tmpdir(), "code-team-dispatch-test", tag + "-" + process.pid + "-" + seq++);
  mkdirSync(d, { recursive: true });
  return d;
}

function dotnetProject() {
  const d = tmpDir("dotnet");
  writeFileSync(join(d, "App.sln"), "", "utf8");
  return d;
}
function plainProject() {
  return tmpDir("plain");
}

// 真 git 仓库：续派取证要基线提交与「已提交但工作树干净」的落盘证据。
function gitRepo(tag) {
  const dir = tmpDir(tag);
  const run = (args) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("git " + args.join(" ") + " 失败: " + (r.stderr || r.stdout));
    return r.stdout;
  };
  run(["init"]);
  run(["config", "user.email", "t@t.local"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "init\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return {
    dir,
    commit(message) {
      writeFileSync(join(dir, "b.txt"), message + "\n", "utf8");
      run(["add", "-A"]);
      run(["commit", "-m", message]);
    },
  };
}

function hookInput({ prompt, agent = "worker", cwd, tool = "task", toolUseId, sessionId = "mvs_parent", turnId = "turn-1" }) {
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    turn_id: turnId,
    cwd,
    tool_name: tool,
    tool_use_id: toolUseId || "toolu_" + Math.random().toString(36).slice(2),
    tool_input: { agent_name: agent, description: "包", prompt },
  };
}

const GOOD_OWNED = "## 文件归属（只改这些）\n- `src/only-a.cs`\n";
const SHARED_OWNED = "## 文件归属（只改这些）\n- `src/shared.cs`\n";
const OTHER_OWNED = "## 文件归属（只改这些）\n- `src/other.cs`\n";

// brief 正文（Overmind 发布的原文）：按归属文件生成。
function briefTextFor(ownedFile) {
  return "# brief 正文\n## 验收\nnpm test 通过\n## 文件归属（只改这些）\n- `" + ownedFile + "`\n";
}

// D 的替身：按引用返回「已验证原文」，并按 ctx 校验版本与包。
function dStub(textFor = briefTextFor("src/only-a.cs"), projectKey = "proj-test") {
  return {
    readVerifiedBrief: (ref, ctx) => {
      if (ctx && ctx.packageId && ctx.packageId !== ref.packageId) return { ok: false, error: "引用属于另一个包" };
      if (ctx && ctx.planRevisionId && ctx.planRevisionId !== ref.planRevisionId) {
        return { ok: false, error: "引用属于另一个计划版本" };
      }
      const text = typeof textFor === "function" ? textFor(ref.packageId) : textFor;
      return {
        ok: true,
        text,
        planRevisionId: ref.planRevisionId,
        packageId: ref.packageId,
        projectKey,
      };
    },
    listPublishedPackages: () => [],
  };
}

// Code Team 首派正文：必须带 plan / package / 产物引用三样。
function codeTeamPrompt(plan, pkg, body) {
  const ref = JSON.stringify({
    planRevisionId: plan,
    packageId: pkg,
    artifactId: pkg + ".md",
    sha256: "0".repeat(64),
    byteLength: 64,
  });
  return (
    "code-team-plan: " + plan + "\n" +
    "code-team-package: " + pkg + "\n" +
    "code-team-brief-ref: " + ref + "\n" +
    (body === undefined ? briefTextFor("src/" + pkg + ".cs") : body)
  );
}

function appendEventTo(dir, rec) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "dispatch-events.jsonl"), JSON.stringify(rec) + "\n", "utf8");
}

function readEvents(dir) {
  const f = join(dir, "dispatch-events.jsonl");
  try {
    return readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function hook() {
  return import("../scripts/dispatch-hook.mjs");
}

test("hook 已注册到宿主：PreToolUse 覆盖 task/task_append，PostToolUse 与 SubagentStop 也登记", async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, ".minimax-plugin", "plugin.json"), "utf8"));
  assert.ok(Array.isArray(manifest.hooks), "manifest 缺 hooks 数组");
  assert.ok(manifest.hooks.includes("hooks/hooks.json"), "manifest 没登记 hooks/hooks.json");
  const doc = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  const pre = doc.hooks.PreToolUse || [];
  assert.ok(pre.length, "hooks.json 没有 PreToolUse");
  assert.ok(pre.some((g) => g.matcher.split("|").includes("task")), "PreToolUse 没匹配 task");
  assert.ok(pre.some((g) => g.matcher.split("|").includes("task_append")), "PreToolUse 没匹配 task_append");
  assert.ok((doc.hooks.PostToolUse || []).some((g) => g.matcher.split("|").includes("task")), "PostToolUse 没匹配 task");
  assert.ok((doc.hooks.SubagentStop || []).some((g) => g.matcher.split("|").includes("verifier")), "SubagentStop 没匹配 verifier");
  const cmd = pre[0].hooks[0].command;
  assert.ok(cmd.includes("dispatch-hook.mjs"), "hook 命令没指向 dispatch-hook.mjs");
  assert.ok(cmd.includes("${PLUGIN_ROOT}"), "hook 命令没走 ${PLUGIN_ROOT}（cwd 是活动工作区，不是插件目录）");
  // 宿主规范：超时 1–10 秒。15 秒会被宿主按「超时放行」处理。
  for (const group of Object.values(doc.hooks)) {
    for (const g of group) {
      const t = g.hooks[0].timeout;
      assert.ok(Number.isFinite(t) && t >= 1 && t <= 10, "hook 超时必须在 1–10 秒，实际 " + t);
    }
  }
});

test("闸 1 编译闸：.NET 项目里只写 -ChecksOnly 的 brief 被拒", async () => {
  const { handleDispatchHook } = await hook();
  const reply = await handleDispatchHook(
    hookInput({ cwd: dotnetProject(), prompt: "## 验收\npwsh -File Scripts\\verify.ps1 -ChecksOnly 通过\n" + GOOD_OWNED }),
    { stateDir: tmpDir("compile") },
  );
  assert.equal(reply.decision, "deny");
  assert.ok(reply.findings.some((f) => f.code === "compile-gate-missing"));
});

test("闸 1 适用范围：非 .NET 项目不受编译闸约束", async () => {
  const { handleDispatchHook } = await hook();
  const reply = await handleDispatchHook(
    hookInput({ cwd: plainProject(), prompt: "## 验收\nnpm test 通过\n" + GOOD_OWNED }),
    { stateDir: tmpDir("scope") },
  );
  assert.equal(reply.decision, "allow");
  assert.equal(reply.findings.length, 0);
});

test("闸 2 文件归属：brief-like 但没有归属段 → 拒", async () => {
  const { handleDispatchHook } = await hook();
  const reply = await handleDispatchHook(
    hookInput({ cwd: plainProject(), prompt: "## 验收\nnpm test 通过\n" }),
    { stateDir: tmpDir("noown") },
  );
  assert.equal(reply.decision, "deny");
  assert.ok(reply.findings.some((f) => f.code === "ownership-missing"));
});

test("闸 2 文件归属：与本轮已放行的包重叠 → 拒，不重叠 → 放行", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("overlap");
  const project = plainProject();
  const first = await handleDispatchHook(
    hookInput({ cwd: project, prompt: codeTeamPrompt("plan-1", "pkg-a", briefTextFor("src/shared.cs")) }),
    { stateDir: state, modules: { D: dStub(briefTextFor("src/shared.cs")) } },
  );
  assert.equal(first.decision, "allow");
  const overlap = await handleDispatchHook(
    hookInput({ cwd: project, prompt: codeTeamPrompt("plan-1", "pkg-b", briefTextFor("src/shared.cs")) }),
    { stateDir: state, modules: { D: dStub(briefTextFor("src/shared.cs")) } },
  );
  assert.equal(overlap.decision, "deny");
  assert.ok(overlap.findings.some((f) => f.code === "ownership-overlap"));
  const disjoint = await handleDispatchHook(
    hookInput({ cwd: project, prompt: codeTeamPrompt("plan-1", "pkg-c", briefTextFor("src/other.cs")) }),
    { stateDir: state, modules: { D: dStub(briefTextFor("src/other.cs")) } },
  );
  assert.equal(disjoint.decision, "allow");
});

test("普通角色路由：非 worker 角色与未知角色都放行", async () => {
  const { handleDispatchHook } = await hook();
  const bad = "## 验收\npwsh -File Scripts\\verify.ps1 -ChecksOnly 通过\n";
  for (const agent of ["explore", "verifier", "some-other-agent"]) {
    const reply = await handleDispatchHook(hookInput({ cwd: dotnetProject(), prompt: bad, agent }), { stateDir: tmpDir("roles") });
    assert.equal(reply.decision, "allow", agent + " 不该被派工闸门拦");
  }
});

test("同请求重放：同一 requestKey 判定一致，且不重复写事件", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("replay");
  const input = hookInput({ cwd: dotnetProject(), prompt: "## 验收\npwsh -File Scripts\\verify.ps1 -ChecksOnly 通过\n" + GOOD_OWNED });
  const first = await handleDispatchHook(input, { stateDir: state });
  assert.equal(first.decision, "deny");
  const countAfterFirst = readEvents(state).length;
  const second = await handleDispatchHook(input, { stateDir: state });
  assert.equal(second.decision, "deny");
  assert.equal(second.replayed, true);
  assert.equal(readEvents(state).length, countAfterFirst, "重放不应再写事件");
});

test("闸门开关：CODE_TEAM_GATE=off 时全部放行", async () => {
  const { handleDispatchHook } = await hook();
  const prev = process.env.CODE_TEAM_GATE;
  process.env.CODE_TEAM_GATE = "off";
  try {
    const reply = await handleDispatchHook(
      hookInput({ cwd: dotnetProject(), prompt: "## 验收\npwsh -File Scripts\\verify.ps1 -ChecksOnly 通过\n" }),
      { stateDir: tmpDir("off") },
    );
    assert.equal(reply.decision, "allow");
  } finally {
    if (prev === undefined) delete process.env.CODE_TEAM_GATE;
    else process.env.CODE_TEAM_GATE = prev;
  }
});

test("宿主入口：违规 payload → exit 2 + stderr 原因；合规 payload → exit 0 且 stdout 静默", () => {
  const state = tmpDir("cli");
  const env = { ...process.env, PLUGIN_DATA: state };
  const bad = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(hookInput({ cwd: dotnetProject(), prompt: "## 验收\npwsh -File Scripts\\verify.ps1 -ChecksOnly 通过\n" })),
    env, encoding: "utf8",
  });
  assert.equal(bad.status, 2, "违规派工必须 exit 2 阻断");
  assert.ok(bad.stderr.trim().length > 0, "阻断必须写 stderr 原因");
  assert.equal(bad.stdout, "", "阻断时不该往 stdout 写东西");
  const good = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(hookInput({ cwd: plainProject(), prompt: "## 验收\nnpm test 通过\n" + GOOD_OWNED })),
    env, encoding: "utf8",
  });
  assert.equal(good.status, 0, "合规派工必须 exit 0 放行");
  assert.equal(good.stdout, "", "放行必须静默");
});

test("带 BOM 的 stdin 仍然判违规并 exit 2（PowerShell 管道会带 BOM）", () => {
  const state = tmpDir("bom");
  const env = { ...process.env, PLUGIN_DATA: state };
  const payload = JSON.stringify(
    hookInput({ cwd: dotnetProject(), prompt: "## 验收\npwsh -File Scripts\\verify.ps1 -ChecksOnly 通过\n" }),
  );
  const res = spawnSync(process.execPath, [HOOK], { input: "\uFEFF" + payload, env, encoding: "utf8" });
  assert.equal(res.status, 2, "带 BOM 的 payload 仍必须被拦");
  assert.ok(res.stderr.includes("编译闸") || res.stderr.includes("ChecksOnly"), "应写出拒绝原因：" + res.stderr);
});

test("模块缺失按模块降级：相关闸降级要拦并写明「该闸未生效」，不相关闸缺失只放行", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("degraded");
  // D 不可用 + 本轮只转交引用 → D 这一闸与本次派工相关 → 拦，并写明该闸未生效
  const refPrompt =
    'code-team-package: pkg-x\ncode-team-plan: rev-9\ncode-team-brief-ref: {"planRevisionId":"rev-9","packageId":"pkg-x","artifactId":"a.md","sha256":"' +
    "0".repeat(64) +
    '"}';
  const blocked = await handleDispatchHook(
    hookInput({ cwd: plainProject(), prompt: refPrompt }),
    { stateDir: state, modules: { D: null } },
  );
  assert.equal(blocked.decision, "deny");
  assert.ok(blocked.reason.includes("该闸未生效：D 模块缺失"), "拒绝原因里要写明哪个闸没生效：" + blocked.reason);
  // 不相关的闸缺失（B 只在本包有历史尝试时才算；C 只管续派；E 只管验收）→ 放行
  const ok = await handleDispatchHook(
    hookInput({ cwd: plainProject(), prompt: "## 验收\nnpm test\n" + GOOD_OWNED }),
    { stateDir: state, modules: { B: null, C: null, D: null, E: null } },
  );
  assert.equal(ok.decision, "allow");
});

test("B：单包成本越界 → 拒；用量未知 → 拒（计量未知不是没问题）", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("b-cost");
  const input = hookInput({ cwd: plainProject(), prompt: codeTeamPrompt("plan-b", "pkg-b") });
  // 先造一条 dispatch.started，B 才有得判
  appendEventTo(state, { event: "dispatch.started", packageId: "pkg-b", childSessionId: "sess-1", projectKey: resolve(plainProject()).toLowerCase() });
  const bmod = (cost) => ({
    readLedgerEvents: () => [],
    readBindings: () => [{ packageId: "pkg-b", childSessionId: "sess-1" }],
    createMcpReader: () => ({ readSession: async () => ({ records: [] }), close: async () => {} }),
    readUsage: async () => ({ packages: { "pkg-b": { usage: { toolCalls: 300, totalTokens: 10 }, coverage: "complete" } } }),
    evaluatePackageCost: () => cost,
  });
  const split = await handleDispatchHook(input, { stateDir: state, modules: { B: bmod("split"), D: dStub() } });
  assert.equal(split.decision, "deny");
  assert.ok(split.findings.some((f) => f.code === "package-cost-split"));
  const unknown = await handleDispatchHook(
    hookInput({ cwd: input.cwd, prompt: input.tool_input.prompt }),
    { stateDir: state, modules: { B: bmod("unknown"), D: dStub() } },
  );
  assert.equal(unknown.decision, "deny", "用量未知必须拒签，不能放行");
  assert.ok(unknown.findings.some((f) => f.code === "metering-unknown"), JSON.stringify(unknown.findings));
});

test("C：续派目标认不出来 → 拒签（不兜底放行）", async () => {
  const { handleDispatchHook } = await hook();
  const prompt =
    "code-team-package: pkg-c\n" +
    'code-team-retry: {"failedBatchId":"b1","previousConcurrency":3,"concurrency":1,"failure":{"protocolCode":42212,"text":"(2056)"}}' +
    "\n" +
    'code-team-continuation: {"persistedWork":"写了 A.cs","remainingWork":"还差 B.cs"}' +
    "\n续派";
  const reply = await handleDispatchHook(
    hookInput({ cwd: plainProject(), tool: "task_append", prompt }),
    { stateDir: tmpDir("c-state") },
  );
  assert.equal(reply.decision, "deny");
  assert.ok(
    reply.findings.some((f) => f.code === "continuation-unresolved"),
    "认不出归属必须拒签：" + JSON.stringify(reply.findings),
  );
});

test("D：只转交产物引用 → 已验证原文装进 prompt（updatedInput），引用被篡改 → 拒", async () => {
  const artifactRoot = tmpDir("artifacts");
  const prevRoot = process.env.CODE_TEAM_ARTIFACT_ROOT;
  const prevLedger = process.env.CODE_TEAM_EVENTS_LEDGER;
  process.env.CODE_TEAM_ARTIFACT_ROOT = artifactRoot;
  process.env.CODE_TEAM_EVENTS_LEDGER = join(tmpDir("d-ledger"), "events.jsonl");
  try {
    const dmod = await import("../scripts/codex-team.mjs");
    const body = "# brief 正文\n## 验收\nnpm test\n## 文件归属\n- `src/x.cs`\n";
    const refs = dmod.publishOvermindBriefs({
      planRevisionId: "rev-1",
      projectKey: "proj",
      threadId: "th-1",
      result: { packages: ["pkg-d"], briefs: [{ packageId: "pkg-d", body }] },
      artifactRoot,
    });
    assert.equal(refs.length, 1);
    const { handleDispatchHook } = await hook();
    const prompt = "code-team-package: pkg-d\ncode-team-plan: rev-1\n" + dmod.formatBriefRef(refs[0]);
    const reply = await handleDispatchHook(hookInput({ cwd: plainProject(), prompt }), { stateDir: tmpDir("d-state") });
    assert.equal(reply.decision, "allow");
    assert.ok(reply.updatedInput, "应给出 updatedInput");
    assert.equal(reply.updatedInput.prompt, body, "装进去的必须是已验证原文");
    assert.equal(
      createHash("sha256").update(Buffer.from(reply.updatedInput.prompt, "utf8")).digest("hex"),
      refs[0].sha256,
      "装进去的正文 sha256 必须与产物一致",
    );
    const badRef = { ...refs[0], sha256: "0".repeat(64) };
    const bad = await handleDispatchHook(
      hookInput({ cwd: plainProject(), prompt: "code-team-package: pkg-d\ncode-team-plan: rev-1\n" + dmod.formatBriefRef(badRef) }),
      { stateDir: tmpDir("d-state2") },
    );
    assert.equal(bad.decision, "deny");
    assert.ok(bad.reason.includes("产物引用校验失败"), bad.reason);
  } finally {
    if (prevRoot === undefined) delete process.env.CODE_TEAM_ARTIFACT_ROOT;
    else process.env.CODE_TEAM_ARTIFACT_ROOT = prevRoot;
    if (prevLedger === undefined) delete process.env.CODE_TEAM_EVENTS_LEDGER;
    else process.env.CODE_TEAM_EVENTS_LEDGER = prevLedger;
  }
});

test("E：同一验收口径第二次派工被拒（状态落盘生效）", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("e-state");
  const project = plainProject();
  const prompt =
    'code-team-plan: plan-e\ncode-team-verification-key: {"planId":"plan-e","criteriaRevisionId":"crit-1"}\n' +
    "验收九包";
  const deps = await verificationFixture(state, project, "plan-e", "pkg-e");
  const first = await handleDispatchHook(hookInput({ cwd: project, agent: "verifier", prompt }), deps);
  assert.equal(first.decision, "allow", first.reason);
  assert.ok(first.verificationKey, "应给出验收键");
  const second = await handleDispatchHook(hookInput({ cwd: project, agent: "verifier", prompt }), deps);
  assert.equal(second.decision, "deny");
  assert.ok(second.findings.some((f) => f.code === "verification-denied"), second.reason);
});

test("PostToolUse：回执带 taskId/childSessionId → 写 dispatch.started", async () => {
  const { handleDispatchHook, handlePostToolUse } = await hook();
  const state = tmpDir("post");
  const input = hookInput({ cwd: plainProject(), prompt: "## 验收\nnpm test\n" + GOOD_OWNED });
  const reply = await handleDispatchHook(input, { stateDir: state });
  assert.equal(reply.decision, "allow");
  const post = await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: input.session_id,
      turn_id: input.turn_id,
      tool_use_id: input.tool_use_id,
      tool_name: "task",
      tool_response: { taskId: "task-9", childSessionId: "mvs_child_9" },
    },
    { stateDir: state },
  );
  assert.equal(post.decision, "allow");
  const started = readEvents(state).filter((e) => e.event === "dispatch.started").pop();
  assert.ok(started, "应写 dispatch.started");
  assert.equal(started.taskId, "task-9");
  assert.equal(started.childSessionId, "mvs_child_9");
});

test("SubagentStop：带验收结论标记 → 验收结果落盘（真实 E 模块）", async () => {
  const { handleDispatchHook, handlePostToolUse, handleSubagentStop } = await hook();
  const state = tmpDir("stop");
  const project = plainProject();
  const prompt =
    'code-team-plan: plan-v\ncode-team-verification-key: {"planId":"plan-v","criteriaRevisionId":"crit-9"}\n' +
    "验收";
  const deps = await verificationFixture(state, project, "plan-v", "pkg-v");
  const input = hookInput({ cwd: project, agent: "verifier", prompt });
  await handleDispatchHook(input, deps);
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: input.session_id,
      turn_id: input.turn_id,
      tool_use_id: input.tool_use_id,
      tool_name: "task",
      tool_response: { taskId: "task-v", childSessionId: "mvs_child_v" },
    },
    { stateDir: state },
  );
  const stop = await handleSubagentStop(
    {
      hook_event_name: "SubagentStop",
      agent_id: "mvs_child_v",
      agent_type: "verifier",
      stop_hook_active: false,
      last_assistant_message:
        'code-team-verification-verdict: pass\ncode-team-verification-evidence: {"outputRefs":["out/verify.log"]}\n其它内容',
    },
    { stateDir: state },
  );
  assert.equal(stop.decision, "allow");
  const vstate = JSON.parse(readFileSync(join(state, "verification-state.json"), "utf8"));
  const rec = Object.values(vstate.verifications)[0];
  assert.equal(rec.status, "passed");
});

test("编译闸与归属检查在真实事故样本上会红", () => {
  const samples = join(ROOT, "briefs");
  const tmp = tmpDir("samples");
  for (const name of ["p5-accident.md.bak", "p5-cont-accident.md.bak", "p9-accident.md.bak"]) {
    writeFileSync(join(tmp, name.replace(/\.bak$/, ".md")), readFileSync(join(samples, name), "utf8"), "utf8");
  }
  const res = spawnSync(process.execPath, [join(ROOT, "checks", "brief-requires-compile-gate.mjs"), "--briefs", tmp], { encoding: "utf8" });
  assert.equal(res.status, 1, "事故样本必须触发编译闸红灯");
  const own = spawnSync(process.execPath, [join(ROOT, "checks", "brief-file-ownership-disjoint.mjs"), "--briefs", tmp], { encoding: "utf8" });
  assert.equal(own.status, 1, "事故样本必须触发归属互斥红灯");
  assert.ok(/simulationengine\.cs/i.test(own.stderr || ""), "应报出重叠的具体文件");
});

test("D 读取产物引用抛异常 → 拒（相关闸失效不放行），不产生未捕获异常", async () => {
  const { handleDispatchHook } = await hook();
  const dmod = {
    readVerifiedBrief: () => {
      throw new Error("ARTIFACTS_DIR is not defined");
    },
  };
  const prompt =
    'code-team-package: pkg-d\ncode-team-plan: rev-1\ncode-team-brief-ref: {"planRevisionId":"rev-1","packageId":"pkg-d","artifactId":"a.md","sha256":"' +
    "0".repeat(64) +
    '"}';
  const reply = await handleDispatchHook(hookInput({ cwd: plainProject(), prompt }), {
    stateDir: tmpDir("d-throw"),
    modules: { D: dmod },
  });
  assert.equal(reply.decision, "deny", "D 闸抛异常必须拦下来");
  assert.ok(reply.reason.includes("该闸未生效：D"), reply.reason);
  assert.ok(reply.findings.some((f) => f.code === "module-degraded"), JSON.stringify(reply.findings));
});

test("B 读取用量抛异常 → 拒（相关闸失效不放行）", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("b-throw");
  appendEventTo(state, {
    event: "dispatch.started",
    packageId: "pkg-b",
    childSessionId: "sess-1",
    projectKey: resolve(plainProject()).toLowerCase(),
  });
  const bmod = {
    readLedgerEvents: () => [],
    readBindings: () => {
      throw new Error("账本读不了");
    },
  };
  const reply = await handleDispatchHook(
    hookInput({ cwd: plainProject(), prompt: codeTeamPrompt("plan-b", "pkg-b") }),
    { stateDir: state, modules: { B: bmod, D: dStub() } },
  );
  assert.equal(reply.decision, "deny", "B 闸抛异常必须拦下来");
  assert.ok(reply.reason.includes("该闸未生效：B"), reply.reason);
});

test("顶层兜底：闸内异常被接住 → 拒（宁可误拒不可误放）", async () => {
  const { handleDispatchHook } = await hook();
  const reply = await handleDispatchHook(
    hookInput({ cwd: plainProject(), prompt: "## 验收\nnpm test\n" + GOOD_OWNED }),
    {
      stateDir: tmpDir("top"),
      checkCompileGate: () => {
        throw new Error("检查脚本炸了");
      },
    },
  );
  assert.equal(reply.decision, "deny");
  assert.ok(reply.reason.includes("该闸未生效：hook 内部异常"), reply.reason);
});

test("hook 进程在任何输入下都只以 0 或 2 退出（不产生其它异常码）", () => {
  const state = tmpDir("codes");
  const env = { ...process.env, PLUGIN_DATA: state };
  const project = dotnetProject();
  const cases = [
    { name: "违规", payload: JSON.stringify(hookInput({ cwd: project, prompt: "## 验收\npwsh -File Scripts\\verify.ps1 -ChecksOnly 通过\n" })) },
    { name: "合规", payload: JSON.stringify(hookInput({ cwd: plainProject(), prompt: "## 验收\nnpm test\n" + GOOD_OWNED })) },
    { name: "带 BOM 的违规", payload: "\uFEFF" + JSON.stringify(hookInput({ cwd: project, prompt: "## 验收\npwsh -File Scripts\\verify.ps1 -ChecksOnly 通过\n" })) },
    { name: "坏输入", payload: "not json" },
    { name: "空输入", payload: "" },
    {
      name: "带产物引用（D 路径）",
      payload: JSON.stringify(
        hookInput({
          cwd: plainProject(),
          prompt:
            'code-team-package: pkg-d\ncode-team-plan: rev-1\ncode-team-brief-ref: {"planRevisionId":"rev-1","packageId":"pkg-d","artifactId":"a.md","sha256":"' +
            "0".repeat(64) +
            '"}',
        }),
      ),
    },
  ];
  for (const c of cases) {
    const res = spawnSync(process.execPath, [HOOK], { input: c.payload, env, encoding: "utf8" });
    assert.ok(res.status === 0 || res.status === 2, c.name + " 的退出码必须是 0 或 2，实际 " + res.status + "；stderr=" + res.stderr);
  }
});

/* ================= 2026-11-25 独立验收 5 条缺陷的回归 ================= */

test("缺陷① 回执字段：宿主给的是 sub_session_id / sub_turn_id → 认出来，且 status:started 不写 settled", async () => {
  const { handleDispatchHook, handlePostToolUse } = await hook();
  const state = tmpDir("receipt");
  const project = plainProject();
  const input = hookInput({ cwd: project, prompt: codeTeamPrompt("plan-r", "pkg-r") });
  assert.equal((await handleDispatchHook(input, { stateDir: state, modules: { D: dStub() } })).decision, "allow");
  const post = await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: input.session_id,
      turn_id: input.turn_id,
      tool_use_id: input.tool_use_id,
      tool_name: "task",
      // 宿主真实回执形状：sub_session_id / sub_turn_id + status:started
      tool_response: { task_id: "task-77", sub_session_id: "mvs_sub_77", sub_turn_id: "turn-77", status: "started" },
    },
    { stateDir: state },
  );
  assert.equal(post.decision, "allow");
  const started = readEvents(state).filter((e) => e.event === "dispatch.started").pop();
  assert.ok(started, "应写 dispatch.started");
  assert.equal(started.taskId, "task-77", "task_id 必须被认出来");
  assert.equal(started.childSessionId, "mvs_sub_77", "sub_session_id 必须被认出来");
  assert.equal(started.childTurnId, "turn-77", "sub_turn_id 必须被认出来");
  assert.equal(
    readEvents(state).filter((e) => e.event === "dispatch.settled").length,
    0,
    "status=started 不是终结，不能写 dispatch.settled",
  );
  assert.ok(started.attemptId, "attempt 标识不能被覆盖成 null");
});

test("缺陷② 真实 task_append 形状 {task_id, content}：靠账本还原角色/包号，续派闸被触达", async () => {
  const { handleDispatchHook, handlePostToolUse } = await hook();
  const state = tmpDir("append-real");
  const project = plainProject();
  // 先真的派一次 worker（走完整链路，账本里才有可信元数据）
  const first = hookInput({ cwd: project, prompt: codeTeamPrompt("plan-a", "pkg-a") });
  assert.equal((await handleDispatchHook(first, { stateDir: state, modules: { D: dStub() } })).decision, "allow");
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: first.session_id,
      turn_id: first.turn_id,
      tool_use_id: first.tool_use_id,
      tool_name: "task",
      tool_response: { task_id: "task-a1", sub_session_id: "mvs_sub_a1", status: "started" },
    },
    { stateDir: state },
  );
  // 宿主真实 task_append：没有 agent_name、没有 prompt
  const reply = await handleDispatchHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "mvs_parent",
      turn_id: "turn-2",
      cwd: project,
      tool_name: "task_append",
      tool_use_id: "toolu_append",
      tool_input: { task_id: "task-a1", content: "code-team-package: pkg-a\n继续做剩下的" },
    },
    { stateDir: state },
  );
  assert.equal(reply.decision, "deny", "真实 task_append 不能绕过续派闸");
  assert.ok(
    reply.findings.some((f) => ["continuation-unresolved", "continuation-no-failure-evidence", "retry-denied"].includes(f.code)),
    JSON.stringify(reply.findings),
  );
  assert.ok(!reply.reason.includes("非 Code Team 角色"), "不能再用「非 Code Team 角色」把真实续派放掉");
});

test("缺陷③ 计量缺失：已有尝试但无绑定 → 拒；绑定在但记录为 0 条 → 拒", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("metering");
  const project = plainProject();
  appendEventTo(state, { event: "dispatch.started", packageId: "pkg-m", childSessionId: "sess-m" });
  const noBinding = {
    readLedgerEvents: () => [],
    readBindings: () => [],
    createMcpReader: () => ({ readSession: async () => ({ records: [] }), close: async () => {} }),
    readUsage: async () => ({ packages: {} }),
    evaluatePackageCost: () => "continue",
  };
  const r1 = await handleDispatchHook(
    hookInput({ cwd: project, prompt: codeTeamPrompt("plan-m", "pkg-m") }),
    { stateDir: state, modules: { B: noBinding, D: dStub() } },
  );
  assert.equal(r1.decision, "deny", "有尝试却无绑定必须拒签");
  assert.ok(r1.findings.some((f) => f.code === "metering-missing-binding"), JSON.stringify(r1.findings));

  const zeroRecords = {
    readLedgerEvents: () => [],
    readBindings: () => [{ packageId: "pkg-m", childSessionId: "sess-m", childTurnId: "turn-not-exist" }],
    createMcpReader: () => ({ readSession: async () => ({ records: [] }), close: async () => {} }),
    readUsage: async () => ({
      packages: { "pkg-m": { usage: { toolCalls: 0, totalTokens: 0 }, coverage: "complete", records: 0 } },
    }),
    evaluatePackageCost: () => "continue",
  };
  const r2 = await handleDispatchHook(
    hookInput({ cwd: project, prompt: codeTeamPrompt("plan-m", "pkg-m") }),
    { stateDir: state, modules: { B: zeroRecords, D: dStub() } },
  );
  assert.equal(r2.decision, "deny", "0 条记录不是「没问题」，必须拒签");
  assert.ok(r2.findings.some((f) => f.code === "metering-missing"), JSON.stringify(r2.findings));
});

test("缺陷④ 进程级：坏 JSON / 空对象 → exit 2 拒签，不再静默放行", () => {
  const state = tmpDir("badinput");
  const env = { ...process.env, PLUGIN_DATA: state };
  for (const [name, payload] of [["坏 JSON", "not json"], ["空对象", "{}"], ["空输入", ""]]) {
    const res = spawnSync(process.execPath, [HOOK], { input: payload, env, encoding: "utf8" });
    assert.equal(res.status, 2, name + " 必须 exit 2 拒签，实际 " + res.status);
    assert.ok(res.stderr.trim().length > 0, name + " 必须写明拒签原因");
  }
});

test("缺陷④ 状态级：状态文件损坏 → 拒签，不当空状态用", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("corrupt");
  writeFileSync(join(state, "dispatch-events.jsonl"), "{这行不是 JSON}\n", "utf8");
  const reply = await handleDispatchHook(
    hookInput({ cwd: plainProject(), prompt: codeTeamPrompt("plan-x", "pkg-x") }),
    { stateDir: state },
  );
  assert.equal(reply.decision, "deny", "状态坏了必须拒签");
  assert.ok(reply.findings.some((f) => f.code === "state-unreadable"), JSON.stringify(reply.findings));
});

test("缺陷④ 重放恢复 updatedInput：同 requestKey 重放能拿回已验证正文", async () => {
  const { handleDispatchHook } = await hook();
  const artifactRoot = tmpDir("replay-artifacts");
  const prevRoot = process.env.CODE_TEAM_ARTIFACT_ROOT;
  const prevLedger = process.env.CODE_TEAM_EVENTS_LEDGER;
  process.env.CODE_TEAM_ARTIFACT_ROOT = artifactRoot;
  process.env.CODE_TEAM_EVENTS_LEDGER = join(tmpDir("replay-ledger"), "events.jsonl");
  try {
    const dmod = await import("../scripts/codex-team.mjs");
    const body = "# brief 正文\n## 验收\nnpm test\n## 文件归属\n- `src/replay.cs`\n";
    const refs = dmod.publishOvermindBriefs({
      planRevisionId: "rev-r",
      projectKey: "proj",
      threadId: "th-r",
      result: { packages: ["pkg-r"], briefs: [{ packageId: "pkg-r", body }] },
      artifactRoot,
    });
    const { handleDispatchHook: run } = await hook();
    const state = tmpDir("replay-state");
    const input = hookInput({
      cwd: plainProject(),
      prompt: "code-team-package: pkg-r\ncode-team-plan: rev-r\n" + dmod.formatBriefRef(refs[0]),
    });
    const first = await run(input, { stateDir: state });
    assert.equal(first.decision, "allow");
    assert.equal(first.updatedInput.prompt, body);
    const second = await run(input, { stateDir: state });
    assert.equal(second.decision, "allow");
    assert.ok(second.updatedInput, "重放必须恢复 updatedInput");
    assert.equal(second.updatedInput.prompt, body, "重放恢复的必须是已验证原文");
  } finally {
    if (prevRoot === undefined) delete process.env.CODE_TEAM_ARTIFACT_ROOT;
    else process.env.CODE_TEAM_ARTIFACT_ROOT = prevRoot;
    if (prevLedger === undefined) delete process.env.CODE_TEAM_EVENTS_LEDGER;
    else process.env.CODE_TEAM_EVENTS_LEDGER = prevLedger;
  }
});

test("缺陷⑤ 归属互斥只比同一 plan；跨 plan 不算冲突，缺标记的 Code Team 派工被拒", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("plan-scope");
  const project = plainProject();
  const a = await handleDispatchHook(
    hookInput({ cwd: project, prompt: codeTeamPrompt("plan-1", "pkg-a", briefTextFor("src/shared.cs")) }),
    { stateDir: state, modules: { D: dStub(briefTextFor("src/shared.cs")) } },
  );
  assert.equal(a.decision, "allow");
  // 另一个 plan 的同文件 → 不是同批 → 放行
  const other = await handleDispatchHook(
    hookInput({ cwd: project, prompt: codeTeamPrompt("plan-2", "pkg-b", briefTextFor("src/shared.cs")) }),
    { stateDir: state, modules: { D: dStub(briefTextFor("src/shared.cs")) } },
  );
  assert.equal(other.decision, "allow", "跨 plan 不应判为归属冲突");
  // 同一 plan 的同文件 → 冲突 → 拒
  const same = await handleDispatchHook(
    hookInput({ cwd: project, prompt: codeTeamPrompt("plan-1", "pkg-c", briefTextFor("src/shared.cs")) }),
    { stateDir: state, modules: { D: dStub(briefTextFor("src/shared.cs")) } },
  );
  assert.equal(same.decision, "deny");
  assert.ok(same.findings.some((f) => f.code === "ownership-overlap"), JSON.stringify(same.findings));
});

test("缺陷⑤ Code Team 派工缺 plan / package 标记 → 拒；普通 worker 派工不受影响", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("markers");
  const project = plainProject();
  // Code Team 特征的 brief（Overmind 格式）但没带 plan / package 标记
  const noMarkers = await handleDispatchHook(
    hookInput({
      cwd: project,
      prompt: "Stakes: high\nHypothesis: 闸门会拦\nDone = (tangible check): node --test\n## 文件归属\n- `src/x.cs`\n",
    }),
    { stateDir: state },
  );
  assert.equal(noMarkers.decision, "deny", "Code Team 派工缺标记必须拒");
  assert.ok(noMarkers.findings.some((f) => f.code === "code-team-marker-missing"), JSON.stringify(noMarkers.findings));
  // 普通（非 Code Team）worker 派工：没有 Code Team 特征 → 不因缺标记被拒
  const plain = await handleDispatchHook(
    hookInput({ cwd: project, prompt: "把 README 里的一段话改短一点\n" }),
    { stateDir: state },
  );
  assert.equal(plain.decision, "allow", "普通 worker 派工不能被误伤");
});

test("C 新契约：证据全部来自账本（提示词不给批次/并发/工作树），真实 C 模块被触达", async () => {
  const { handleDispatchHook, handlePostToolUse } = await hook();
  const state = tmpDir("c-ledger");
  const project = plainProject();
  // 1) 同批次派两个包：原并发 = 2。
  //    只派一个包时原并发就是 1，C 会先走「原并发已是 1 → 交回 Overmind 重拆」，
  //    根本到不了证据链 —— 那是 C 的口径，不是缺口。
  const first = hookInput({ cwd: project, prompt: codeTeamPrompt("plan-c", "pkg-c") });
  assert.equal(
    (await handleDispatchHook(first, { stateDir: state, modules: { D: dStub() } })).decision,
    "allow",
  );
  const sibling = hookInput({ cwd: project, prompt: codeTeamPrompt("plan-c", "pkg-c2") });
  assert.equal(
    (await handleDispatchHook(sibling, { stateDir: state, modules: { D: dStub(briefTextFor("src/pkg-c2.cs")) } })).decision,
    "allow",
  );
  // 2) PostToolUse 记下这次 attempt（带 childSessionId / childTurnId）
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: first.session_id,
      turn_id: first.turn_id,
      tool_use_id: first.tool_use_id,
      tool_name: "task",
      tool_response: {
        task_id: "task-c1",
        sub_session_id: "sess-c1",
        sub_turn_id: "turn-c1",
        status: "failed",
        error: { code: 42212, message: "(2056) 额度用尽" },
      },
    },
    { stateDir: state },
  );
  const settled = readEvents(state).filter((e) => e.event === "dispatch.settled").pop();
  assert.ok(settled, "应写 dispatch.settled");
  assert.equal(settled.failure.protocolCode, 42212, "失败机器码必须记进账本");
  assert.ok(settled.failure.observedAtMs, "失败时刻必须记进账本");
  assert.equal(settled.failure.taskId, "task-c1");
  assert.equal(settled.failure.childTurnId, "turn-c1");
  assert.equal(settled.worktreePath, resolve(project), "原 Worker 工作树要记进账本");
  assert.ok(settled.attemptId, "attempt 标识不能是 null");

  // 3) 真实 task_append：只给 {task_id, content}，提示词里没有任何证据
  const reply = await handleDispatchHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "mvs_parent",
      turn_id: "turn-2",
      cwd: project,
      tool_name: "task_append",
      tool_use_id: "toolu_c_append",
      tool_input: {
        task_id: "task-c1",
        content:
          "code-team-continuation: {\"persistedWork\":\"写了 A.cs\",\"remainingWork\":\"还差 B.cs\"}\n" +
          "撞墙了，重开一次",
      },
    },
    { stateDir: state },
  );
  // C 必须真的被触达（不是被「非 Code Team 角色」短路）
  assert.ok(
    reply.findings.some((f) => f.code === "retry-denied"),
    "C 的判定必须被触达（retry-denied），实际：" + JSON.stringify(reply.findings),
  );
  assert.ok(!reply.reason.includes("非 Code Team 角色"), "不能再被「非 Code Team 角色」短路");
  // 账本还原的证据要进到判定里：
  // 能走到「失败批次证据不足」= failureKind 已被判成 quota（机器码/时刻/attempt 都来自账本），
  // 且原并发来自账本（≥2），不是提示词。
  const reason = reply.findings.find((f) => f.code === "retry-denied").message;
  assert.ok(reason.includes("失败批次证据不足"), "必须走到 C 的证据链分支：" + reason);
  assert.ok(!reason.includes("原并发已是 1"), "原并发必须来自账本且 ≥2：" + reason);
  const gaps = (reason.match(/缺 ([^）]+)/) || [])[1];
  assert.ok(gaps, "拒绝原因要列出证据缺口：" + reason);
  // 缺口只剩「工作树取证」（临时目录不是 git 仓库，取不到提交证据）；
  // 机器码/失败时刻/attempt/原并发/批次/工作树路径都必须已从账本还原。
  assert.deepEqual(
    gaps.split("、"),
    ["工作树取证"],
    "除工作树取证外不应再有缺口（其余字段都要来自账本）：" + reason,
  );
});

test("C 新契约：账本里没有失败证据时，续派一律拒签（不能靠提示词补证据）", async () => {
  const { handleDispatchHook, handlePostToolUse } = await hook();
  const state = tmpDir("c-noev");
  const project = plainProject();
  const first = hookInput({ cwd: project, prompt: codeTeamPrompt("plan-n", "pkg-n") });
  assert.equal((await handleDispatchHook(first, { stateDir: state, modules: { D: dStub() } })).decision, "allow");
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: first.session_id,
      turn_id: first.turn_id,
      tool_use_id: first.tool_use_id,
      tool_name: "task",
      tool_response: { task_id: "task-n1", sub_session_id: "sess-n1", status: "started" },
    },
    { stateDir: state },
  );
  // 提示词里塞满证据：批次 / 并发 / 工作树 —— 都不算证据
  const reply = await handleDispatchHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "mvs_parent",
      turn_id: "turn-2",
      cwd: project,
      tool_name: "task_append",
      tool_use_id: "toolu_n_append",
      tool_input: {
        task_id: "task-n1",
        content:
          'code-team-retry: {"failedBatchId":"b1","previousConcurrency":3,"concurrency":1,"failure":{"protocolCode":42212,"text":"(2056)"}}\n' +
          'code-team-continuation: {"persistedWork":"写了 A.cs","remainingWork":"还差 B.cs"}\n' +
          "重开",
      },
    },
    { stateDir: state },
  );
  assert.equal(reply.decision, "deny", "没有账本失败证据必须拒签");
  assert.ok(reply.findings.some((f) => f.code === "retry-denied"), JSON.stringify(reply.findings));
});

test("E 新契约：验收结论缺证据引用 → 不落盘（空引用 = 无效结果）", async () => {
  const { handleDispatchHook, handlePostToolUse, handleSubagentStop } = await hook();
  const state = tmpDir("e-noev");
  const project = plainProject();
  const prompt =
    'code-team-plan: plan-n\ncode-team-verification-key: {"planId":"plan-n","criteriaRevisionId":"crit-n"}\n' +
    "验收";
  const deps = await verificationFixture(state, project, "plan-n", "pkg-n");
  const input = hookInput({ cwd: project, agent: "verifier", prompt });
  await handleDispatchHook(input, deps);
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: input.session_id,
      turn_id: input.turn_id,
      tool_use_id: input.tool_use_id,
      tool_name: "task",
      tool_response: { taskId: "task-n", childSessionId: "mvs_child_n" },
    },
    { stateDir: state },
  );
  const stop = await handleSubagentStop(
    {
      hook_event_name: "SubagentStop",
      agent_id: "mvs_child_n",
      agent_type: "verifier",
      stop_hook_active: false,
      last_assistant_message: "code-team-verification-verdict: pass\n没有证据引用",
    },
    { stateDir: state },
  );
  assert.equal(stop.decision, "allow");
  const vstate = JSON.parse(readFileSync(join(state, "verification-state.json"), "utf8"));
  const rec = Object.values(vstate.verifications)[0];
  assert.notEqual(rec.status, "passed", "空证据引用不得记成通过");
  assert.equal(rec.verdict, null, "空证据引用不得记结论");
});

test("E 新契约：FAIL 结论缺命令与退出码 → 不落盘（否则自证永远判无效）", async () => {
  const { handleDispatchHook, handlePostToolUse, handleSubagentStop } = await hook();
  const state = tmpDir("e-nocmd");
  const project = plainProject();
  const prompt =
    'code-team-plan: plan-f\ncode-team-verification-key: {"planId":"plan-f","criteriaRevisionId":"crit-f"}\n' +
    "验收";
  const deps = await verificationFixture(state, project, "plan-f", "pkg-f");
  const input = hookInput({ cwd: project, agent: "verifier", prompt });
  await handleDispatchHook(input, deps);
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: input.session_id,
      turn_id: input.turn_id,
      tool_use_id: input.tool_use_id,
      tool_name: "task",
      tool_response: { taskId: "task-f", childSessionId: "mvs_child_f" },
    },
    { stateDir: state },
  );
  await handleSubagentStop(
    {
      hook_event_name: "SubagentStop",
      agent_id: "mvs_child_f",
      agent_type: "verifier",
      stop_hook_active: false,
      last_assistant_message:
        'code-team-verification-verdict: fail\ncode-team-verification-evidence: {"outputRefs":["out/f.log"]}',
    },
    { stateDir: state },
  );
  const vstate = JSON.parse(readFileSync(join(state, "verification-state.json"), "utf8"));
  const rec = Object.values(vstate.verifications)[0];
  assert.notEqual(rec.status, "failed", "缺失败命令不得记成 FAIL（否则自证永远判无效）");
});

test("B 新口径：该包尚无任何尝试（第一次派工）→ 正常放行，不做计量判", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("b-first");
  const bmod = {
    readLedgerEvents: () => [],
    readBindings: () => [],
    createMcpReader: () => ({ readSession: async () => ({ records: [] }), close: async () => {} }),
    readUsage: async () => ({ packages: {} }),
    evaluatePackageCost: () => "unknown",
  };
  const reply = await handleDispatchHook(
    hookInput({ cwd: plainProject(), prompt: codeTeamPrompt("plan-f", "pkg-f") }),
    { stateDir: state, modules: { B: bmod, D: dStub() } },
  );
  assert.equal(reply.decision, "allow", "第一次派工没有历史尝试，不属于计量未知");
  assert.equal(reply.findings.length, 0, JSON.stringify(reply.findings));
});

/* ============ 2026-11-26 第二轮独立验收：① 续派证据串错任务 ============ */

test("① 请求 A 不能消费 B 的 42212：证据按 taskId + attemptId 关联", async () => {
  const { handleDispatchHook, handlePostToolUse } = await hook();
  const state = tmpDir("cross-task");
  const project = plainProject();
  // A、B 同包号、不同 task_id：旧口径按包号选失败记录 → A 会吃掉 B 的 42212。
  const a = hookInput({ cwd: project, prompt: codeTeamPrompt("plan-x", "pkg-x", briefTextFor("src/a.cs")) });
  assert.equal((await handleDispatchHook(a, { stateDir: state, modules: { D: dStub(briefTextFor("src/a.cs")) } })).decision, "allow");
  const b = hookInput({ cwd: project, prompt: codeTeamPrompt("plan-x", "pkg-x", briefTextFor("src/b.cs")) });
  assert.equal((await handleDispatchHook(b, { stateDir: state, modules: { D: dStub(briefTextFor("src/b.cs")) } })).decision, "allow");
  // 同批再派一个别的包：原并发 = 2（否则 C 会先走「原并发已是 1 → 重拆」）
  const z = hookInput({ cwd: project, prompt: codeTeamPrompt("plan-x", "pkg-z", briefTextFor("src/z.cs")) });
  assert.equal((await handleDispatchHook(z, { stateDir: state, modules: { D: dStub(briefTextFor("src/z.cs")) } })).decision, "allow");
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: a.session_id,
      turn_id: a.turn_id,
      tool_use_id: a.tool_use_id,
      tool_name: "task",
      tool_response: { task_id: "task-A", sub_session_id: "sess-A", status: "started" },
    },
    { stateDir: state },
  );
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: b.session_id,
      turn_id: b.turn_id,
      tool_use_id: b.tool_use_id,
      tool_name: "task",
      tool_response: {
        task_id: "task-B",
        sub_session_id: "sess-B",
        sub_turn_id: "turn-B",
        status: "failed",
        error: { code: 42212, message: "(2056) 额度用尽" },
      },
    },
    { stateDir: state },
  );
  // 请求 A：A 自己没有失败记录 → 不能借用 B 的 42212。
  const replyA = await handleDispatchHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "mvs_parent",
      turn_id: "turn-2",
      cwd: project,
      tool_name: "task_append",
      tool_use_id: "toolu_a",
      tool_input: {
        task_id: "task-A",
        content:
          'code-team-continuation: {"persistedWork":"写了 A.cs","remainingWork":"还差 B.cs"}\n' +
          "重开",
      },
    },
    { stateDir: state },
  );
  assert.equal(replyA.decision, "deny", "A 不得消费 B 的失败证据");
  assert.ok(
    replyA.findings.some((f) => f.code === "continuation-no-failure-evidence"),
    "A 没有自己的失败记录，必须明确指出：" + JSON.stringify(replyA.findings),
  );
  const reasonA = replyA.findings.find((f) => f.code === "retry-denied").message;
  assert.ok(
    reasonA.includes("失败证据不足（unknown）"),
    "A 不得拿到 B 的 42212 机器码（应判 unknown 而不是额度事故）：" + reasonA,
  );
  // 请求 B：B 自己的失败证据可用 → 走 C 的证据链（不是「认不出归属」）。
  const replyB = await handleDispatchHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "mvs_parent",
      turn_id: "turn-3",
      cwd: project,
      tool_name: "task_append",
      tool_use_id: "toolu_b",
      tool_input: {
        task_id: "task-B",
        content:
          'code-team-continuation: {"persistedWork":"写了 B.cs","remainingWork":"还差 C.cs"}\n' +
          "重开",
      },
    },
    { stateDir: state },
  );
  assert.equal(replyB.decision, "deny", "缺工作树取证仍然拒签");
  const reasonB = replyB.findings.find((f) => f.code === "retry-denied").message;
  assert.ok(reasonB.includes("失败批次证据不足"), "B 应拿到自己的失败证据：" + reasonB);
  assert.ok(!reasonB.includes("失败机器码 protocolCode"), "B 的机器码应已从账本还原：" + reasonB);
  assert.ok(!reasonB.includes("unknown"), "B 有自己的 42212，不该判成证据不足：" + reasonB);
});

test("① 已知非 Code Team 的续派仍能通过（不误伤普通任务）", async () => {
  const { handleDispatchHook, handlePostToolUse } = await hook();
  const state = tmpDir("foreign");
  const project = plainProject();
  const plain = hookInput({ cwd: project, prompt: "看一下 README 的用法", agent: "explore" });
  assert.equal((await handleDispatchHook(plain, { stateDir: state })).decision, "allow");
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: plain.session_id,
      turn_id: plain.turn_id,
      tool_use_id: plain.tool_use_id,
      tool_name: "task",
      tool_response: { task_id: "task-foreign", sub_session_id: "sess-foreign", status: "started" },
    },
    { stateDir: state },
  );
  const reply = await handleDispatchHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "mvs_parent",
      turn_id: "turn-2",
      cwd: project,
      tool_name: "task_append",
      tool_use_id: "toolu_foreign",
      tool_input: { task_id: "task-foreign", content: "再看看 README" },
    },
    { stateDir: state },
  );
  assert.equal(reply.decision, "allow", "已知非 Code Team 的续派必须放行");
  assert.equal(reply.findings.length, 0, JSON.stringify(reply.findings));
});

/* ============ 2026-11-26 第二轮独立验收：② 正文约束可被绕过 ============ */

test("② Code Team 首派没有产物引用 → 拒签（手写 brief 不许绕过 Overmind 原文）", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("handwritten");
  const project = plainProject();
  const handwritten =
    "code-team-plan: plan-h\ncode-team-package: pkg-h\n" +
    "Stakes: high\nHypothesis: 手写也能过\nDone = (tangible check): node --test\n" +
    briefTextFor("src/h.cs");
  const reply = await handleDispatchHook(hookInput({ cwd: project, prompt: handwritten }), { stateDir: state });
  assert.equal(reply.decision, "deny", "手写 brief 必须拒签");
  assert.ok(
    reply.findings.some((f) => f.code === "brief-ref-missing"),
    "拒绝原因必须点名缺引用：" + JSON.stringify(reply.findings),
  );
});

test("② 引用必须绑定同一项目、同一计划版本、同一包", async () => {
  const { handleDispatchHook } = await hook();
  const state = tmpDir("binding");
  const projectA = plainProject();
  const projectB = plainProject();
  const stub = dStub();
  // 同一包号、同一计划版本，但在另一个项目里用 → 拒。
  const first = await handleDispatchHook(
    hookInput({ cwd: projectA, prompt: codeTeamPrompt("plan-b", "pkg-b") }),
    { stateDir: state, modules: { D: stub } },
  );
  assert.equal(first.decision, "allow", first.reason);
  const cross = await handleDispatchHook(
    hookInput({ cwd: projectB, prompt: codeTeamPrompt("plan-b", "pkg-b") }),
    { stateDir: state, modules: { D: stub } },
  );
  assert.equal(cross.decision, "deny", "同一计划版本不得跨项目使用");
  assert.ok(
    cross.findings.some((f) => f.code === "brief-ref-binding"),
    "拒绝原因要写明绑定不符：" + JSON.stringify(cross.findings),
  );
  // 引用指向另一个包 → 拒。
  const wrongPkg = await handleDispatchHook(
    hookInput({ cwd: projectA, prompt: codeTeamPrompt("plan-b", "pkg-other") }),
    { stateDir: state, modules: { D: stub } },
  );
  assert.equal(wrongPkg.decision, "deny", "引用必须与包号一致");
});

test("② 续派注入走 content 键，不加 prompt；正文逐字节等于已验证原文", async () => {
  const fx = await continuationFixture("inject");
  const content =
    codeTeamPrompt(fx.plan, fx.pkg1, fx.body1) +
    '\ncode-team-continuation: {"persistedWork":"写了 A.cs","remainingWork":"还差 B.cs"}\n' +
    'code-team-retry: {"concurrency":1}\n';
  const reply = await fx.handleDispatchHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "mvs_parent",
      turn_id: "turn-2",
      cwd: fx.repo.dir,
      tool_name: "task_append",
      tool_use_id: "toolu_inject",
      tool_input: { task_id: fx.taskId, content },
    },
    fx.deps,
  );
  assert.equal(reply.decision, "allow", reply.reason);
  assert.ok(reply.updatedInput, "续派也要装入已验证正文");
  assert.equal(reply.updatedInput.content, fx.body1, "续派正文必须逐字节装进 content");
  assert.ok(!("prompt" in reply.updatedInput), "续派契约里没有 prompt 键，不许自己加");
});

/* ============ 2026-11-26 第二轮独立验收：③ 程序异常之外仍有放行 ============ */

test("③ 静态依赖缺失 → 拒签（不能让宿主按崩溃放行）", () => {
  const state = tmpDir("no-deps");
  const env = { ...process.env, PLUGIN_DATA: state };
  // 复制一份插件，但不带 checks/ —— 静态导入缺失会让插件起不来。
  const broken = tmpDir("broken-plugin");
  mkdirSync(join(broken, "scripts"), { recursive: true });
  mkdirSync(join(broken, "config"), { recursive: true });
  copyFileSync(HOOK, join(broken, "scripts", "dispatch-hook.mjs"));
  copyFileSync(join(ROOT, "config", "team.json"), join(broken, "config", "team.json"));
  const payload = JSON.stringify(
    hookInput({ cwd: plainProject(), prompt: codeTeamPrompt("plan-nd", "pkg-nd") }),
  );
  const res = spawnSync(process.execPath, [join(broken, "scripts", "dispatch-hook.mjs")], {
    input: payload,
    env,
    encoding: "utf8",
  });
  assert.equal(res.status, 2, "静态依赖缺失必须退 2 拒签，实际 " + res.status + "；stderr=" + res.stderr);
  assert.ok(res.stderr.includes("编译闸"), "要写明哪个闸没生效：" + res.stderr);
});

test("③ 入口捕获加载失败 → 退 2（不是崩溃码）", () => {
  const broken = tmpDir("broken-module");
  writeFileSync(join(broken, "broken.mjs"), "this is not ( valid js", "utf8");
  const launcher =
    'node -e "const{pathToFileURL}=require(\'url\');import(pathToFileURL(process.argv[1]).href).catch(e=>{process.stderr.write(\'dispatch-hook: 加载失败 \'+(e&&e.message)+\'\\n\');process.exit(2)})" "' +
    join(broken, "broken.mjs") +
    '"';
  const res = spawnSync(launcher, { shell: true, encoding: "utf8" });
  assert.equal(res.status, 2, "加载失败必须退 2，实际 " + res.status);
  assert.ok(res.stderr.includes("加载失败"), "要写明加载失败：" + res.stderr);
});

test("③ 坏 JSON 里带 SubagentStop 字样 → 退 2（不再因为字样放行）", () => {
  const state = tmpDir("badjson-stop");
  const env = { ...process.env, PLUGIN_DATA: state };
  const res = spawnSync(process.execPath, [HOOK], {
    input: '{"last_assistant_message":"SubagentStop 已结束"',
    env,
    encoding: "utf8",
  });
  assert.equal(res.status, 2, "坏 JSON 必须退 2，实际 " + res.status);
  assert.ok(res.stderr.trim().length > 0, "要写明拒签原因");
});

test("③ 事件信封不对 → 退 2（缺 tool_name / 事件名不认识）", () => {
  const state = tmpDir("envelope");
  const env = { ...process.env, PLUGIN_DATA: state };
  const cases = [
    { name: "缺 tool_name", payload: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_input: { prompt: "x" } }) },
    { name: "事件名不认识", payload: JSON.stringify({ hook_event_name: "Whatever", session_id: "s", tool_name: "task", tool_input: { prompt: "x" } }) },
  ];
  for (const c of cases) {
    const res = spawnSync(process.execPath, [HOOK], { input: c.payload, env, encoding: "utf8" });
    assert.equal(res.status, 2, c.name + " 必须退 2，实际 " + res.status);
  }
});

/* ============ 2026-11-26 第二轮独立验收：④ 原并发与落盘深度仍靠推断 ============ */

test("④ 原并发按批次实际启动区间恢复（超过 60 秒的并行批次也算）", async () => {
  const { handleDispatchHook, handlePostToolUse } = await hook();
  const state = tmpDir("batch-window");
  const repo = gitRepo("batch");
  const t0 = 1_700_000_000_000;
  let clock = t0;
  const deps = { stateDir: state, modules: { D: dStub() }, nowMs: () => clock };
  const plan = "plan-batch";
  // 三个包在同一批次里陆续派出（模拟超过 60 秒的并行批次）
  const first = hookInput({ cwd: repo.dir, prompt: codeTeamPrompt(plan, "pkg-b1") });
  assert.equal((await handleDispatchHook(first, { ...deps, modules: { D: dStub(briefTextFor("src/pkg-b1.cs")) } })).decision, "allow");
  clock = t0 + 10_000;
  const second = hookInput({ cwd: repo.dir, prompt: codeTeamPrompt(plan, "pkg-b2") });
  assert.equal((await handleDispatchHook(second, { ...deps, modules: { D: dStub(briefTextFor("src/pkg-b2.cs")) } })).decision, "allow");
  clock = t0 + 20_000;
  const third = hookInput({ cwd: repo.dir, prompt: codeTeamPrompt(plan, "pkg-b3") });
  assert.equal((await handleDispatchHook(third, { ...deps, modules: { D: dStub(briefTextFor("src/pkg-b3.cs")) } })).decision, "allow");
  // 第一个包在 100 秒后撞墙（远超过 60 秒窗口）
  clock = t0 + 100_000;
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: first.session_id,
      turn_id: first.turn_id,
      tool_use_id: first.tool_use_id,
      tool_name: "task",
      tool_response: {
        task_id: "task-b1",
        sub_session_id: "sess-b1",
        sub_turn_id: "turn-b1",
        status: "failed",
        error: { code: 42212, message: "(2056) 额度用尽" },
      },
    },
    deps,
  );
  repo.commit("worker 交付");
  clock = t0 + 101_000;
  // 请求并发 = 3 → 必须按原并发 3 判「不得恢复原规模」（若按 60 秒窗口估成 1，会放行）
  const reply = await handleDispatchHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "mvs_parent",
      turn_id: "turn-2",
      cwd: repo.dir,
      tool_name: "task_append",
      tool_use_id: "toolu_batch",
      tool_input: {
        task_id: "task-b1",
        content:
          'code-team-retry: {"concurrency":3}\n' +
          'code-team-continuation: {"persistedWork":"写了 A.cs","remainingWork":"还差 B.cs"}\n' +
          "重开",
      },
    },
    deps,
  );
  assert.equal(reply.decision, "deny", "恢复原并发必须拒签");
  const reason = (reply.findings.find((f) => f.code === "retry-denied") || {}).message || "";
  assert.ok(reason.includes("原并发 3"), "原并发必须来自批次实际启动区间（期望 3）：" + reason);
});

test("④ 干净树上的已提交变更判为「有落盘」；git 取证失败 → 拒签", async () => {
  const fx = await continuationFixture("wt");
  // 续派书没写已落盘什么，但工作树显示有落盘 → 拒（证明落盘深度看得见已提交变更）
  const reply = await fx.handleDispatchHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "mvs_parent",
      turn_id: "turn-2",
      cwd: fx.repo.dir,
      tool_name: "task_append",
      tool_use_id: "toolu_wt",
      tool_input: {
        task_id: fx.taskId,
        content:
          codeTeamPrompt(fx.plan, fx.pkg1, fx.body1) +
          '\ncode-team-continuation: {"persistedWork":"","remainingWork":"还差 B.cs"}\n',
      },
    },
    fx.deps,
  );
  assert.equal(reply.decision, "deny");
  const reason = (reply.findings.find((f) => f.code === "retry-denied") || {}).message || "";
  assert.ok(
    reason.includes("工作树显示已有落盘"),
    "干净树上的已提交变更必须判为有落盘：" + reason,
  );
  assert.ok(
    !reply.findings.some((f) => f.code === "worktree-git-failed"),
    "真仓库取证不该失败：" + JSON.stringify(reply.findings),
  );

  // 非 git 目录 → git 子命令失败 → 拒签，不折成「无变更」
  const { handleDispatchHook, handlePostToolUse } = await hook();
  const state2 = tmpDir("worktree-nogit");
  const project = plainProject();
  const deps2 = { stateDir: state2 };
  const first2 = hookInput({ cwd: project, prompt: codeTeamPrompt("plan-wt", "pkg-w2") });
  assert.equal((await handleDispatchHook(first2, { ...deps2, modules: { D: dStub(briefTextFor("src/pkg-w2.cs")) } })).decision, "allow");
  const second2 = hookInput({ cwd: project, prompt: codeTeamPrompt("plan-wt", "pkg-w3") });
  assert.equal((await handleDispatchHook(second2, { ...deps2, modules: { D: dStub(briefTextFor("src/pkg-w3.cs")) } })).decision, "allow");
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: first2.session_id,
      turn_id: first2.turn_id,
      tool_use_id: first2.tool_use_id,
      tool_name: "task",
      tool_response: {
        task_id: "task-w2",
        sub_session_id: "sess-w2",
        sub_turn_id: "turn-w2",
        status: "failed",
        error: { code: 42212, message: "(2056) 额度用尽" },
      },
    },
    deps2,
  );
  const reply2 = await handleDispatchHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "mvs_parent",
      turn_id: "turn-2",
      cwd: project,
      tool_name: "task_append",
      tool_use_id: "toolu_nogit",
      tool_input: {
        task_id: "task-w2",
        content:
          'code-team-continuation: {"persistedWork":"写了 A.cs","remainingWork":"还差 B.cs"}\n' +
          "重开",
      },
    },
    deps2,
  );
  assert.equal(reply2.decision, "deny", "git 取证失败必须拒签");
  assert.ok(
    reply2.findings.some((f) => f.code === "worktree-git-failed"),
    "要写明 git 取证失败：" + JSON.stringify(reply2.findings),
  );
});

/* ============ 续派夹具：同批 2 包 + git 仓库 + 额度撞墙 + Worker 已提交 ============ */

// 造一条能放行的续派链路。放行是必须的 —— 注入正文只在放行时才装进 updatedInput。
async function continuationFixture(tag) {
  const { handleDispatchHook, handlePostToolUse } = await hook();
  const state = tmpDir("cont-" + tag);
  const repo = gitRepo("cont-" + tag);
  const plan = "plan-" + tag;
  const pkg1 = "pkg-" + tag + "1";
  const pkg2 = "pkg-" + tag + "2";
  const body1 = briefTextFor("src/" + pkg1 + ".cs");
  const body2 = briefTextFor("src/" + pkg2 + ".cs");
  const first = hookInput({ cwd: repo.dir, prompt: codeTeamPrompt(plan, pkg1, body1) });
  assert.equal((await handleDispatchHook(first, { stateDir: state, modules: { D: dStub(body1) } })).decision, "allow");
  const second = hookInput({ cwd: repo.dir, prompt: codeTeamPrompt(plan, pkg2, body2) });
  assert.equal((await handleDispatchHook(second, { stateDir: state, modules: { D: dStub(body2) } })).decision, "allow");
  const taskId = "task-" + tag + "1";
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: first.session_id,
      turn_id: first.turn_id,
      tool_use_id: first.tool_use_id,
      tool_name: "task",
      tool_response: {
        task_id: taskId,
        sub_session_id: "sess-" + tag,
        sub_turn_id: "turn-" + tag,
        status: "failed",
        error: { code: 42212, message: "(2056) 额度用尽" },
      },
    },
    { stateDir: state },
  );
  // Worker 已经提交 → 工作树干净，但基线之后有提交 = 有落盘
  repo.commit("worker 交付");
  // B 闸：续派时本包已有历史尝试 → 计量必须可读（否则按「用量未知」拒签）。
  const bmod = {
    readLedgerEvents: () => [],
    readBindings: () => [{ packageId: pkg1, childSessionId: "sess-" + tag }],
    createMcpReader: () => ({ readSession: async () => ({ records: [] }), close: async () => {} }),
    readUsage: async () => ({
      packages: { [pkg1]: { usage: { toolCalls: 3, totalTokens: 100 }, coverage: "complete", records: 1 } },
    }),
    evaluatePackageCost: () => "continue",
  };
  return {
    handleDispatchHook,
    state,
    repo,
    plan,
    pkg1,
    body1,
    taskId,
    deps: { stateDir: state, modules: { D: dStub(body1), B: bmod } },
  };
}

/* ============ 验收夹具：先发布 brief + 造终结成功事件 ============ */

// E 的新口径：预期包集合来自 D 的已发布清单，完成证据必须是终结成功的对象。
// 所以验收用例的夹具必须先发布 brief，再造一条终结成功事件。
async function verificationFixture(state, project, planId, packageId) {
  const artifactRoot = tmpDir("verify-artifacts-" + planId);
  const prevRoot = process.env.CODE_TEAM_ARTIFACT_ROOT;
  const prevLedger = process.env.CODE_TEAM_EVENTS_LEDGER;
  process.env.CODE_TEAM_ARTIFACT_ROOT = artifactRoot;
  process.env.CODE_TEAM_EVENTS_LEDGER = join(tmpDir("verify-ledger-" + planId), "events.jsonl");
  const dmod = await import("../scripts/codex-team.mjs");
  dmod.publishOvermindBriefs({
    planRevisionId: planId,
    projectKey: "proj",
    threadId: "th-" + planId,
    result: { packages: [packageId], briefs: [{ packageId, body: briefTextFor("src/" + packageId + ".cs") }] },
    artifactRoot,
  });
  appendEventTo(state, {
    event: "dispatch.settled",
    projectKey: resolve(project).toLowerCase(),
    planId,
    packageId,
    attemptId: "att-" + packageId,
    outcome: "completed",
    observedAtMs: Date.now(),
  });
  return {
    stateDir: state,
    restore() {
      if (prevRoot === undefined) delete process.env.CODE_TEAM_ARTIFACT_ROOT;
      else process.env.CODE_TEAM_ARTIFACT_ROOT = prevRoot;
      if (prevLedger === undefined) delete process.env.CODE_TEAM_EVENTS_LEDGER;
      else process.env.CODE_TEAM_EVENTS_LEDGER = prevLedger;
    },
  };
}
