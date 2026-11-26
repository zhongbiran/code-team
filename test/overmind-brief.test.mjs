#!/usr/bin/env node
// D 包回归：Overmind brief 原样落盘 + 产物引用可核对。
//
// 不真调 Codex：用替身 codex（APPDATA 重定向）走 scripts/codex-team.mjs 的 plan 路径，
// 覆盖：正文逐字节落盘、sha256 核对、篡改/错包/旧版本被拒、半批不发布、
// 失败响应不发布、resume 产生新版本、--plain 兼容、模型仍是只读沙箱。
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "codex-team.mjs");

let seq = 0;
function tmpDir(tag) {
  const d = join(tmpdir(), "code-team-brief-test", tag + "-" + process.pid + "-" + seq++);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

// 替身 codex：APPDATA 重定向到临时目录，封装按约定路径找它（不会碰真 Codex）
const STUB = `
const fs = require("fs");
fs.writeFileSync(process.env.STUB_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(process.env.STUB_STDOUT, "utf8"));
process.exit(Number(process.env.STUB_EXIT || 0));
`;

function makeStub(home) {
  const bin = join(home, "npm", "node_modules", "@openai", "codex", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex.js"), STUB, "utf8");
}

// 造一份 codex --json 的事件流：线程号 + 最后一条 agent_message
function eventStream({ threadId = "th-1", text }) {
  return [
    JSON.stringify({ type: "thread.started", thread_id: threadId }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
  ].join("\n");
}

// 一份合法的 Overmind 结构化响应（含 briefs 原文与预期包集合 packages）
// packages 默认按 briefs 推导；整批约束的用例要显式给不同的预期集合。
function planResult(briefs, packages = briefs.map((b) => b.packageId)) {
  return {
    summary: "样例",
    steps: [{ title: "拆包", detail: "细节", owner: "Worker D", acceptance: "node --test" }],
    risks: [],
    openQuestions: [],
    packages,
    briefs,
  };
}

const BRIEF_BODY = [
  "Stakes: high",
  "Hypothesis: 中文正文要逐字节落盘。",
  "",
  "## 文件归属（只改这些）",
  "- `scripts/codex-team.mjs`",
  "",
  "```bash",
  "node --test test/overmind-brief.test.mjs",
  "```",
  "",
].join("\n");

// 跑一次真实 CLI（替身 codex），返回 { status, stdout, stderr, env, home, artifacts }
// artifactRootEnv=false → 不注入 CODE_TEAM_ARTIFACT_ROOT（模拟宿主只给 PLUGIN_DATA 的真实形态）
function runPlan({ result, exitCode = 0, threadId = "th-1", extraArgs = [], plain = false, artifacts, pluginData, artifactRootEnv = true, home: reuseHome }) {
  const home = reuseHome || tmpDir("home");
  const art = artifacts || join(home, "artifacts");
  mkdirSync(art, { recursive: true });
  makeStub(home);
  const stdoutFile = join(home, "stdout.jsonl");
  const argvLog = join(home, "argv.json");
  const text = typeof result === "string" ? result : JSON.stringify(result);
  writeFileSync(stdoutFile, eventStream({ threadId, text }), "utf8");
  const promptFile = join(home, "req.md");
  writeFileSync(promptFile, "用户原话", "utf8");

  const env = {
    ...process.env,
    APPDATA: home,
    STUB_STDOUT: stdoutFile,
    STUB_ARGV_LOG: argvLog,
    STUB_EXIT: String(exitCode),
    // 两套隔离变量都指到同一个临时账本：二期变量优先，本轮旧别名保留。
    CODE_TEAM_EVENTS: join(home, "events.jsonl"),
    CODE_TEAM_EVENTS_LEDGER: join(home, "events.jsonl"),
    CODE_TEAM_USAGE_LEDGER: join(home, "usage-ledger.json"),
    ...(artifactRootEnv ? { CODE_TEAM_ARTIFACT_ROOT: art } : {}),
    ...(pluginData ? { PLUGIN_DATA: pluginData } : {}),
  };
  const args = [CLI, "plan", "--prompt-file", promptFile, "--role", "overmind"];
  if (plain) args.push("--plain");
  const res = spawnSync(process.execPath, [...args, ...extraArgs], { env, encoding: "utf8" });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    artifacts: art,
    home,
    argv: existsSync(argvLog) ? JSON.parse(readFileSync(argvLog, "utf8")) : [],
  };
}

// 造一个「缺 schema 文件」的插件副本：scripts/ + config/team.json，故意不带 plan-schema.json。
// CLI 的 schema 路径由脚本位置推导（ROOT/config/plan-schema.json），所以换目录就等于换 schema。
// 副本用完即弃，不碰仓库里的真实 schema。
function runPlanWithoutSchema() {
  const home = tmpDir("home-noschema");
  const clone = join(home, "plugin-clone");
  mkdirSync(clone, { recursive: true });
  cpSync(join(ROOT, "scripts"), join(clone, "scripts"), { recursive: true });
  mkdirSync(join(clone, "config"), { recursive: true });
  writeFileSync(join(clone, "config", "team.json"), readFileSync(join(ROOT, "config", "team.json"), "utf8"));
  makeStub(home);
  const argvLog = join(home, "argv.json");
  const stdoutFile = join(home, "stdout.jsonl");
  writeFileSync(stdoutFile, "", "utf8");
  const promptFile = join(home, "req.md");
  writeFileSync(promptFile, "用户原话", "utf8");
  const art = join(home, "artifacts");
  mkdirSync(art, { recursive: true });
  const env = {
    ...process.env,
    APPDATA: home,
    STUB_STDOUT: stdoutFile,
    STUB_ARGV_LOG: argvLog,
    CODE_TEAM_ARTIFACT_ROOT: art,
    CODE_TEAM_EVENTS_LEDGER: join(home, "events.jsonl"),
    CODE_TEAM_USAGE_LEDGER: join(home, "usage-ledger.json"),
  };
  const res = spawnSync(
    process.execPath,
    [join(clone, "scripts", "codex-team.mjs"), "plan", "--prompt-file", promptFile, "--role", "overmind"],
    { env, encoding: "utf8" },
  );
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    artifacts: art,
    // 替身 codex 被拉起时会写 argv 日志；没写 = 子进程启动数为 0
    codexStarted: existsSync(argvLog),
  };
}

function refsFrom(stderr) {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith("brief_refs="));
  return line ? JSON.parse(line.slice("brief_refs=".length)) : null;
}

function revisionFrom(stderr) {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith("brief_plan_revision="));
  return line ? line.slice("brief_plan_revision=".length) : null;
}

const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

nodeTest("结构化响应：brief 正文逐字节落盘，引用带 sha256 与字节数", async () => {
  const { readVerifiedBrief } = await import("../scripts/codex-team.mjs");
  const run = runPlan({ result: planResult([{ packageId: "pkg-d", body: BRIEF_BODY }]) });
  assert.equal(run.status, 0, run.stderr);
  const refs = refsFrom(run.stderr);
  assert.ok(refs && refs.length === 1, "stderr 应给出 brief_refs");
  assert.equal(refs[0].packageId, "pkg-d");
  assert.equal(refs[0].sha256, sha(BRIEF_BODY));
  assert.equal(refs[0].byteLength, Buffer.byteLength(BRIEF_BODY, "utf8"));

  // 产物文件在盘上，且与原文逐字节相同
  const revDir = join(run.artifacts, "briefs", refs[0].planRevisionId);
  const file = join(revDir, refs[0].artifactId);
  assert.ok(existsSync(file), "产物文件应落盘");
  assert.equal(readFileSync(file, "utf8"), BRIEF_BODY);

  // Worker 实收正文（经引用核对）与 Overmind 原文逐字节相同
  const verified = readVerifiedBrief(refs[0], { artifactRoot: run.artifacts });
  assert.equal(verified.ok, true, verified.error);
  assert.equal(Buffer.from(verified.text, "utf8").toString("hex"), Buffer.from(BRIEF_BODY, "utf8").toString("hex"));
  assert.equal(verified.sha256, sha(BRIEF_BODY));
});

nodeTest("现有 CLI 语义不变：stdout 仍是 Overmind 正文，退出码 0", () => {
  const run = runPlan({ result: planResult([{ packageId: "pkg-d", body: BRIEF_BODY }]) });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), JSON.stringify(planResult([{ packageId: "pkg-d", body: BRIEF_BODY }])));
});

nodeTest("模型仍是只读沙箱：封装传下去的沙箱参数没被改", () => {
  const run = runPlan({ result: planResult([{ packageId: "pkg-d", body: BRIEF_BODY }]) });
  assert.ok(run.argv.includes("--sandbox"), "应传 --sandbox");
  assert.equal(run.argv[run.argv.indexOf("--sandbox") + 1], "read-only", "沙箱必须是 read-only");
});

nodeTest("篡改产物：引用核对失败，不返回正文", async () => {
  const { readVerifiedBrief } = await import("../scripts/codex-team.mjs");
  const run = runPlan({ result: planResult([{ packageId: "pkg-d", body: BRIEF_BODY }]) });
  const refs = refsFrom(run.stderr);
  const file = join(run.artifacts, "briefs", refs[0].planRevisionId, refs[0].artifactId);
  writeFileSync(file, BRIEF_BODY + "偷偷加一行", "utf8");
  const verified = readVerifiedBrief(refs[0], { artifactRoot: run.artifacts });
  assert.equal(verified.ok, false);
  assert.equal(verified.text, undefined);
});

nodeTest("错包 / 错计划版本：引用核对失败", async () => {
  const { readVerifiedBrief } = await import("../scripts/codex-team.mjs");
  const run = runPlan({ result: planResult([{ packageId: "pkg-d", body: BRIEF_BODY }]) });
  const refs = refsFrom(run.stderr);
  assert.equal(readVerifiedBrief(refs[0], { artifactRoot: run.artifacts, packageId: "pkg-x" }).ok, false);
  assert.equal(readVerifiedBrief(refs[0], { artifactRoot: run.artifacts, planRevisionId: "别的一版" }).ok, false);
});

nodeTest("半批不合格：整批不发布，不产出可派工引用", () => {
  const run = runPlan({
    result: planResult([
      { packageId: "pkg-a", body: BRIEF_BODY },
      { packageId: "pkg-b", body: "" },
    ]),
  });
  assert.equal(run.status, 0, "发布失败不改变 plan 的退出码");
  assert.equal(refsFrom(run.stderr), null, "半批不能给出引用");
  assert.ok(run.stderr.includes("brief 产物未发布"), "应说明未发布");
  const briefsDir = join(run.artifacts, "briefs");
  assert.ok(!existsSync(briefsDir) || readdirSync(briefsDir).filter((n) => !n.startsWith(".")).length === 0,
    "不应留下已发布的批次目录");
});

nodeTest("包标识重复：整批不发布", () => {
  const run = runPlan({
    result: planResult([
      { packageId: "pkg-a", body: BRIEF_BODY },
      { packageId: "pkg-a", body: BRIEF_BODY + "另一份" },
    ]),
  });
  assert.equal(refsFrom(run.stderr), null);
  assert.ok(run.stderr.includes("重复"), "应说明 packageId 重复");
});

nodeTest("schema 校验不过：不发布", () => {
  const bad = planResult([{ packageId: "pkg-a", body: BRIEF_BODY }]);
  bad.summary = 123;
  const run = runPlan({ result: bad });
  assert.equal(refsFrom(run.stderr), null);
  assert.ok(run.stderr.includes("schema 校验"), "应说明未通过 schema 校验");
});

nodeTest("失败响应：保留退出码，不发布任何产物", () => {
  const run = runPlan({ result: planResult([{ packageId: "pkg-a", body: BRIEF_BODY }]), exitCode: 3 });
  assert.equal(run.status, 3, "失败响应的退出码要照旧");
  assert.equal(refsFrom(run.stderr), null, "失败响应不能给出引用");
  const briefsDir = join(run.artifacts, "briefs");
  assert.ok(!existsSync(briefsDir) || readdirSync(briefsDir).filter((n) => !n.startsWith(".")).length === 0,
    "失败响应不该有产物目录");
});

nodeTest("--plain 路径：只出文本，不发布产物", () => {
  const run = runPlan({ result: "这不是 JSON", plain: true });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), "这不是 JSON");
  assert.equal(refsFrom(run.stderr), null);
  const briefsDir = join(run.artifacts, "briefs");
  assert.ok(!existsSync(briefsDir) || readdirSync(briefsDir).filter((n) => !n.startsWith(".")).length === 0);
});

nodeTest("默认产物根：不传 artifactRoot 时 readVerifiedBrief 返回 {ok:false} 而不抛", async () => {
  const { readVerifiedBrief } = await import("../scripts/codex-team.mjs");
  // 宿主 hook 的真实调用形态：只传 planRevisionId/packageId，不传 artifactRoot
  const wrong = {
    planRevisionId: "no-such-rev",
    packageId: "no-such-pkg",
    artifactId: "no-such-pkg.md",
    sha256: "0".repeat(64),
  };
  const r = readVerifiedBrief(wrong, { planRevisionId: "no-such-rev", packageId: "no-such-pkg" });
  assert.equal(r.ok, false, "错 ref 必须判失败");
  assert.equal(typeof r.error, "string");
  assert.equal(r.text, undefined, "判失败时不得返回正文");

  // 连 ref 都不给也不得抛
  const none = readVerifiedBrief(null);
  assert.equal(none.ok, false);
  assert.equal(none.text, undefined);

  // 缺字段的 ref 同样只判失败
  const partial = readVerifiedBrief({ planRevisionId: "x" });
  assert.equal(partial.ok, false);
  assert.equal(partial.text, undefined);
});

nodeTest("默认产物根：不传 root 也能发布，产物落在 resolveArtifactRoot() 指的目录", async () => {
  const { publishOvermindBriefs, readVerifiedBrief, resolveArtifactRoot } = await import("../scripts/codex-team.mjs");
  // 不传 artifactRoot → 走默认根（宿主可写数据目录；推不出来才退回插件内 artifacts/）
  const rev = "test-default-root-" + process.pid + "-" + seq++;
  const root = resolveArtifactRoot();
  const refs = publishOvermindBriefs({
    planRevisionId: rev,
    projectKey: "test",
    threadId: "th-default",
    result: planResult([{ packageId: "pkg-d", body: BRIEF_BODY }]),
  });
  assert.equal(refs.length, 1);
  const revDir = join(root, "briefs", rev);
  const file = join(revDir, refs[0].artifactId);
  assert.ok(existsSync(file), "产物应落在默认根 " + root);
  assert.equal(readFileSync(file, "utf8"), BRIEF_BODY);
  // 默认根下也能读回同一份正文
  const v = readVerifiedBrief(refs[0]);
  assert.equal(v.ok, true, v.error);
  assert.equal(v.text, BRIEF_BODY);
  // 清理这次测试自己建的目录，不留垃圾
  rmSync(revDir, { recursive: true, force: true });
});

nodeTest("strict schema 规则：properties 有 key 但 required 缺它 → 被拒", async () => {
  const { assertOpenAiStrictSchema } = await import("../scripts/codex-team.mjs");
  const bad = {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: { summary: { type: "string" }, briefs: { type: "array" } },
  };
  assert.throws(
    () => assertOpenAiStrictSchema(bad),
    (err) => /briefs 不在 required 里/.test(err.message),
    "缺 required 的 key 必须被拒"
  );
  // 嵌套层级同样成立
  const badNested = {
    type: "object",
    additionalProperties: false,
    required: ["steps"],
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: { title: { type: "string" }, detail: { type: "string" } },
        },
      },
    },
  };
  assert.throws(() => assertOpenAiStrictSchema(badNested), /detail 不在 required 里/);
  // required 里有 properties 里没有的 key → 也非法
  const extra = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "ghost"],
    properties: { summary: { type: "string" } },
  };
  assert.throws(() => assertOpenAiStrictSchema(extra), /ghost/);
});

nodeTest("strict schema 规则：两个真实 schema 都通过", async () => {
  const { assertOpenAiStrictSchema } = await import("../scripts/codex-team.mjs");
  for (const name of ["plan-schema.json", "coder-schema.json"]) {
    const schema = JSON.parse(readFileSync(join(ROOT, "config", name), "utf8"));
    assert.equal(assertOpenAiStrictSchema(schema, name), true, name + " 应通过 strict 规则");
  }
  // coder-schema 不含 briefs（那是 Overmind 的产物）
  const coder = JSON.parse(readFileSync(join(ROOT, "config", "coder-schema.json"), "utf8"));
  assert.equal(coder.properties.briefs, undefined, "coder schema 不该有 briefs");
  // plan-schema 的 briefs 必须在 required 里（这正是上次把 API 打挂的坑）
  const plan = JSON.parse(readFileSync(join(ROOT, "config", "plan-schema.json"), "utf8"));
  assert.ok(plan.required.includes("briefs"), "plan schema 的 required 必须含 briefs");
  // 每个 properties 的 key 都得在 required 里
  for (const key of Object.keys(plan.properties)) {
    assert.ok(plan.required.includes(key), "plan schema required 缺 " + key);
  }
});

nodeTest("resume：产生新版本，旧版本被作废（不得误投旧稿）", async () => {
  const { readVerifiedBrief } = await import("../scripts/codex-team.mjs");
  const art = join(tmpDir("art"), "artifacts");
  mkdirSync(art, { recursive: true });
  const first = runPlan({ result: planResult([{ packageId: "pkg-d", body: BRIEF_BODY }]), artifacts: art });
  const refs1 = refsFrom(first.stderr);
  const rev1 = revisionFrom(first.stderr);
  assert.ok(rev1, "第一次应给出计划版本号");

  const second = runPlan({
    result: planResult([{ packageId: "pkg-d", body: BRIEF_BODY + "\n第二版补充\n" }]),
    artifacts: art,
    // 续问必须落在第一次那条已确认线程的账本上：后端要在这里核对线程身份。
    home: first.home,
    extraArgs: ["--resume", "th-1"],
  });
  const refs2 = refsFrom(second.stderr);
  const rev2 = revisionFrom(second.stderr);
  assert.ok(refs2, "resume 后应给出新的引用");
  assert.notEqual(rev2, rev1, "resume 必须产生新版本");
  assert.notEqual(refs2[0].sha256, refs1[0].sha256);

  const v2 = readVerifiedBrief(refs2[0], { artifactRoot: art });
  assert.equal(v2.ok, true, v2.error);
  assert.ok(v2.text.includes("第二版补充"));

  const v1 = readVerifiedBrief(refs1[0], { artifactRoot: art });
  assert.equal(v1.ok, false, "旧版本应被作废，不能再派工");
  assert.ok(v1.error.includes("取代"), v1.error);
});

// ---------- 整批约束：预期包集合 ↔ 实际 briefs 全量比对 ----------

nodeTest("整批约束：计划要求两包、只交一包 → 整批不发布，不产出可派工引用", () => {
  const run = runPlan({
    result: planResult([{ packageId: "pkg-a", body: BRIEF_BODY }], ["pkg-a", "pkg-b"]),
  });
  assert.equal(run.status, 0, "发布失败不改变 plan 的退出码");
  assert.equal(refsFrom(run.stderr), null, "漏交一个包不能给出引用");
  assert.ok(run.stderr.includes("pkg-b"), "应说明缺哪个包：" + run.stderr);
  const briefsDir = join(run.artifacts, "briefs");
  assert.ok(!existsSync(briefsDir) || readdirSync(briefsDir).filter((n) => !n.startsWith(".")).length === 0,
    "不应留下已发布的批次目录");
});

nodeTest("整批约束：多出一个计划里没有的包 → 整批不发布", () => {
  const run = runPlan({
    result: planResult(
      [{ packageId: "pkg-a", body: BRIEF_BODY }, { packageId: "pkg-x", body: BRIEF_BODY }],
      ["pkg-a"],
    ),
  });
  assert.equal(refsFrom(run.stderr), null, "多出的包不能给出引用");
  assert.ok(run.stderr.includes("pkg-x"), "应说明多出的包：" + run.stderr);
});

nodeTest("整批约束：预期包集合为空或有重复 → 整批不发布", () => {
  const empty = runPlan({ result: planResult([{ packageId: "pkg-a", body: BRIEF_BODY }], []) });
  assert.equal(refsFrom(empty.stderr), null, "预期集合为空不能给出引用");
  const dup = runPlan({ result: planResult([{ packageId: "pkg-a", body: BRIEF_BODY }], ["pkg-a", "pkg-a"]) });
  assert.equal(refsFrom(dup.stderr), null, "预期集合重复不能给出引用");
});

// ---------- 产物根：发布端与宿主读取端同一个根 ----------

nodeTest("产物根解析：显式参数 > CODE_TEAM_ARTIFACT_ROOT > PLUGIN_DATA", async () => {
  const { resolveArtifactRoot } = await import("../scripts/codex-team.mjs");
  const prevOverride = process.env.CODE_TEAM_ARTIFACT_ROOT;
  const prevData = process.env.PLUGIN_DATA;
  try {
    const explicit = tmpDir("explicit");
    const override = tmpDir("override");
    const data = tmpDir("plugin-data");
    delete process.env.CODE_TEAM_ARTIFACT_ROOT;
    delete process.env.PLUGIN_DATA;
    assert.equal(resolveArtifactRoot({ explicit }), resolve(explicit), "显式参数优先");
    process.env.CODE_TEAM_ARTIFACT_ROOT = override;
    assert.equal(resolveArtifactRoot(), resolve(override), "环境覆盖次之");
    assert.equal(resolveArtifactRoot({ explicit }), resolve(explicit), "显式参数仍压过环境");
    process.env.PLUGIN_DATA = data;
    assert.equal(resolveArtifactRoot(), resolve(override), "环境覆盖仍压过宿主可写目录");
    delete process.env.CODE_TEAM_ARTIFACT_ROOT;
    assert.equal(resolveArtifactRoot(), join(resolve(data), "artifacts"), "宿主可写目录在环境覆盖之后");
  } finally {
    if (prevOverride === undefined) delete process.env.CODE_TEAM_ARTIFACT_ROOT;
    else process.env.CODE_TEAM_ARTIFACT_ROOT = prevOverride;
    if (prevData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = prevData;
  }
});

nodeTest("发布端与宿主读取端默认根一致：CLI 推导的根 == hook 端 PLUGIN_DATA 指向的根", async () => {
  const { resolveArtifactRoot } = await import("../scripts/codex-team.mjs");
  const prevOverride = process.env.CODE_TEAM_ARTIFACT_ROOT;
  const prevData = process.env.PLUGIN_DATA;
  try {
    delete process.env.CODE_TEAM_ARTIFACT_ROOT;
    delete process.env.PLUGIN_DATA;
    // CLI 进程：宿主不注入 PLUGIN_DATA（只有 hook 进程有）
    const publisherRoot = resolveArtifactRoot();
    // hook 进程：宿主注入 PLUGIN_DATA = <dataDir>/v2/plugin-data/hooks/<插件名>
    const hostData = join(resolve(ROOT, "..", ".."), "v2", "plugin-data", "hooks", "code-team");
    process.env.PLUGIN_DATA = hostData;
    const hookRoot = resolveArtifactRoot();
    // 插件装在运行时 <dataDir>/plugins/<name> 下时两端必须落到同一个根；
    // 装在别处时 CLI 端推不出宿主数据目录，只能退回插件内 artifacts/（需要宿主配合注入 PLUGIN_DATA）。
    const layoutOk = basename(dirname(ROOT)) === "plugins" && existsSync(join(resolve(ROOT, "..", ".."), "v2"));
    if (layoutOk) {
      assert.equal(publisherRoot, hookRoot, "两端默认根必须相同，否则引用读不出来");
      assert.equal(publisherRoot, join(hostData, "artifacts"));
    } else {
      assert.equal(publisherRoot, join(ROOT, "artifacts"));
    }
  } finally {
    if (prevOverride === undefined) delete process.env.CODE_TEAM_ARTIFACT_ROOT;
    else process.env.CODE_TEAM_ARTIFACT_ROOT = prevOverride;
    if (prevData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = prevData;
  }
});

nodeTest("发布端与读取端共用宿主可写目录：CLI 写进 PLUGIN_DATA，hook 侧按同一根读回原文", async () => {
  const { readVerifiedBrief } = await import("../scripts/codex-team.mjs");
  const data = tmpDir("plugin-data");
  // 只注入 PLUGIN_DATA（不注入 CODE_TEAM_ARTIFACT_ROOT）：宿主 hook 的真实形态
  const run = runPlan({
    result: planResult([{ packageId: "pkg-d", body: BRIEF_BODY }]),
    pluginData: data,
    artifactRootEnv: false,
  });
  assert.equal(run.status, 0, run.stderr);
  const refs = refsFrom(run.stderr);
  assert.ok(refs && refs.length === 1, "stderr 应给出 brief_refs：" + run.stderr);
  const prevData = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = data;
  try {
    const v = readVerifiedBrief(refs[0]);
    assert.equal(v.ok, true, v.error);
    assert.equal(v.text, BRIEF_BODY);
    // 产物确实落在宿主可写目录下
    assert.ok(existsSync(join(data, "artifacts", "briefs", refs[0].planRevisionId, refs[0].artifactId)),
      "产物应落在 PLUGIN_DATA/artifacts 下");
  } finally {
    if (prevData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = prevData;
  }
});

// ---------- 已发布包的查询（给派工方用） ----------

nodeTest("listPublishedPackages：给出该版本已发布的包标识；没发布或被作废 → 空数组", async () => {
  const { publishOvermindBriefs, listPublishedPackages } = await import("../scripts/codex-team.mjs");
  const art = tmpDir("art");
  const rev1 = "list-" + process.pid + "-" + seq++;
  publishOvermindBriefs({
    planRevisionId: rev1,
    projectKey: "test",
    threadId: "th-list",
    result: planResult([
      { packageId: "pkg-a", body: BRIEF_BODY },
      { packageId: "pkg-b", body: BRIEF_BODY },
    ]),
    artifactRoot: art,
  });
  assert.deepEqual(listPublishedPackages({ planRevisionId: rev1, artifactRoot: art }).sort(), ["pkg-a", "pkg-b"]);
  assert.deepEqual(listPublishedPackages({ planRevisionId: "没有这一版", artifactRoot: art }), []);

  // 同线程的新版本作废旧版本 → 旧版本不再可派工
  const rev2 = "list-" + process.pid + "-" + seq++;
  publishOvermindBriefs({
    planRevisionId: rev2,
    projectKey: "test",
    threadId: "th-list",
    result: planResult([{ packageId: "pkg-a", body: BRIEF_BODY }]),
    artifactRoot: art,
  });
  assert.deepEqual(listPublishedPackages({ planRevisionId: rev1, artifactRoot: art }), [], "被作废的版本不给出包");
  assert.deepEqual(listPublishedPackages({ planRevisionId: rev2, artifactRoot: art }), ["pkg-a"]);
});

nodeTest("strict schema 规则：object 节点缺 additionalProperties:false → 被拒", async () => {
  const { assertOpenAiStrictSchema } = await import("../scripts/codex-team.mjs");
  // 根节点缺 additionalProperties:false
  const bad = {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  };
  assert.throws(
    () => assertOpenAiStrictSchema(bad),
    (err) => /additionalProperties/.test(err.message),
    "缺 additionalProperties:false 必须被拒"
  );
  // 嵌套层级同样成立
  const badNested = {
    type: "object",
    additionalProperties: false,
    required: ["steps"],
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string" } },
        },
      },
    },
  };
  assert.throws(() => assertOpenAiStrictSchema(badNested), /additionalProperties/);
  // additionalProperties 写成 true 也不行（strict 只认 false）
  const notFalse = {
    type: "object",
    additionalProperties: true,
    required: ["summary"],
    properties: { summary: { type: "string" } },
  };
  assert.throws(() => assertOpenAiStrictSchema(notFalse), /additionalProperties/);
});

nodeTest("schema 文件缺失：exit 2，不发起 Codex 调用，不产出任何引用", () => {
  const run = runPlanWithoutSchema();
  assert.equal(run.status, 2, "schema 缺失必须以 exit 2 中止：" + run.stderr);
  assert.ok(run.stderr.includes("schema"), "应说明是 schema 的问题：" + run.stderr);
  assert.equal(run.codexStarted, false, "Codex 子进程启动数必须为 0");
  assert.equal(refsFrom(run.stderr), null, "不得产出可派工引用");
  const briefsDir = join(run.artifacts, "briefs");
  assert.ok(!existsSync(briefsDir) || readdirSync(briefsDir).length === 0, "不得留下产物目录");
});

nodeTest("发布契约：缺 packages / 空 packages / 漏包 / 多包 / 重复包 → 不进入写入路径，0 引用", async () => {
  const { publishOvermindBriefs } = await import("../scripts/codex-team.mjs");
  const art = tmpDir("contract");
  const base = { summary: "样例", steps: [], risks: [], openQuestions: [] };
  const cases = [
    { name: "缺 packages", result: { ...base, briefs: [{ packageId: "pkg-a", body: BRIEF_BODY }] } },
    { name: "空 packages", result: { ...base, packages: [], briefs: [{ packageId: "pkg-a", body: BRIEF_BODY }] } },
    { name: "漏包", result: { ...base, packages: ["pkg-a", "pkg-b"], briefs: [{ packageId: "pkg-a", body: BRIEF_BODY }] } },
    { name: "多包", result: { ...base, packages: ["pkg-a"], briefs: [{ packageId: "pkg-a", body: BRIEF_BODY }, { packageId: "pkg-x", body: BRIEF_BODY }] } },
    { name: "预期集合重复", result: { ...base, packages: ["pkg-a", "pkg-a"], briefs: [{ packageId: "pkg-a", body: BRIEF_BODY }] } },
    { name: "briefs 重复", result: { ...base, packages: ["pkg-a"], briefs: [{ packageId: "pkg-a", body: BRIEF_BODY }, { packageId: "pkg-a", body: BRIEF_BODY + "另一份" }] } },
  ];
  for (const c of cases) {
    let refs = null;
    let threw = false;
    try {
      refs = publishOvermindBriefs({
        planRevisionId: "contract-" + c.name,
        projectKey: "test",
        threadId: "th-contract",
        result: c.result,
        artifactRoot: art,
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true, c.name + " 必须被拒");
    assert.equal(refs, null, c.name + " 不得产出引用");
  }
  // 一个批次目录都不许留下
  const briefsDir = join(art, "briefs");
  assert.ok(!existsSync(briefsDir) || readdirSync(briefsDir).length === 0, "不得写入任何批次目录");
});

nodeTest("发布契约：CLI 收到缺 packages / 空 packages 的响应 → 0 引用，不写盘", () => {
  const base = { summary: "样例", steps: [], risks: [], openQuestions: [] };
  const missing = runPlan({ result: { ...base, briefs: [{ packageId: "pkg-a", body: BRIEF_BODY }] } });
  assert.equal(refsFrom(missing.stderr), null, "缺 packages 不能给出引用");
  assert.ok(missing.stderr.includes("brief 产物未发布"), "应说明未发布：" + missing.stderr);

  const empty = runPlan({ result: { ...base, packages: [], briefs: [{ packageId: "pkg-a", body: BRIEF_BODY }] } });
  assert.equal(refsFrom(empty.stderr), null, "空 packages 不能给出引用");
  assert.ok(empty.stderr.includes("brief 产物未发布"), "应说明未发布：" + empty.stderr);

  for (const run of [missing, empty]) {
    const briefsDir = join(run.artifacts, "briefs");
    assert.ok(!existsSync(briefsDir) || readdirSync(briefsDir).length === 0, "不得留下产物目录");
  }
});

// ---------- 两套隔离变量：二期变量优先，本轮旧别名兜底 ----------

nodeTest("两套隔离变量都在：CODE_TEAM_EVENTS 优先，CODE_TEAM_EVENTS_LEDGER 兜底", () => {
  const home = tmpDir("iso");
  const art = join(home, "artifacts");
  mkdirSync(art, { recursive: true });
  makeStub(home);
  const stdoutFile = join(home, "stdout.jsonl");
  writeFileSync(stdoutFile, eventStream({ threadId: "th-iso", text: "不是 JSON" }), "utf8");
  const promptFile = join(home, "req.md");
  writeFileSync(promptFile, "用户原话", "utf8");

  const phase2File = join(home, "phase2-events.jsonl");
  const legacyFile = join(home, "legacy-events.jsonl");
  const base = {
    ...process.env,
    APPDATA: home,
    STUB_STDOUT: stdoutFile,
    STUB_ARGV_LOG: join(home, "argv.json"),
    CODE_TEAM_ARTIFACT_ROOT: art,
    CODE_TEAM_USAGE_LEDGER: join(home, "usage-ledger.json"),
  };
  delete base.CODE_TEAM_EVENTS;
  delete base.CODE_TEAM_EVENTS_LEDGER;
  const plan = (env) =>
    spawnSync(process.execPath, [CLI, "plan", "--prompt-file", promptFile, "--role", "overmind"], {
      encoding: "utf8",
      env,
    });

  // 只给本轮旧别名：事件落在旧别名指的文件
  const legacy = plan({ ...base, CODE_TEAM_EVENTS_LEDGER: legacyFile });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.ok(existsSync(legacyFile), "旧别名指的文件应收到事件");

  // 两套都给：二期变量优先
  const both = plan({ ...base, CODE_TEAM_EVENTS: phase2File, CODE_TEAM_EVENTS_LEDGER: legacyFile });
  assert.equal(both.status, 0, both.stderr);
  assert.ok(existsSync(phase2File), "二期变量指的文件应收到事件");
  const lines = readFileSync(phase2File, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, "二期账本里应只有这次调用的一条事件");
  const row = JSON.parse(lines[0]);
  assert.equal(row.kind, "call");
  assert.equal(row.threadId, "th-iso");
});
