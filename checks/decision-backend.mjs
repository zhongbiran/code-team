#!/usr/bin/env node
// 检查：决策调用的后端派发是不是真的按配置走。
//
// 两条红线：
//   1. 角色配了 external-command，就不能还去启动 codex；
//   2. 一次尝试只能产生一条 call 事件（写两条，看板会把一次调用算成两次）。
//
// 怎么验：全部用本地替身。替身记录 argv、stdin 与启动次数，不碰任何外部服务。
// 所有配置、事件、账本都写在临时目录里，仓库的真实运行态一个字节都不碰。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "codex-team.mjs");
const REAL_EVENTS = join(ROOT, "config", "events.jsonl");

const DIR = mkdtempSync(join(tmpdir(), "code-team-decision-"));
const EVENTS = join(DIR, "events.jsonl");
const LEDGER = join(DIR, "usage-ledger.json");
const PROMPT_FILE = join(DIR, "prompt.txt");
const LOG = join(DIR, "launches.jsonl");
const FAKE_CODEX = join(DIR, "fake-codex.mjs");
const FAKE_CLI = join(DIR, "fake-cli.mjs");

// 替身代码x：记录 argv 与 stdin，吐出和真 codex 一样的 JSONL。
const FAKE_CODEX_SRC = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(1), stdin }) + "\\n");
const threadId = process.env.FAKE_THREAD_ID || "thread-fixture-1";
console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "替身输出：规划已完成。" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } }));
`;

// 替身外部命令：记录 argv 与 stdin，stdout 就是结果。
const FAKE_CLI_SRC = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(1), stdin }) + "\\n");
process.stdout.write("替身输出：规划已完成。\\n");
`;

writeFileSync(FAKE_CODEX, FAKE_CODEX_SRC, "utf8");
writeFileSync(FAKE_CLI, FAKE_CLI_SRC, "utf8");

// 带换行、引号与 shell 元字符的 prompt：原样到达 stdin 才算对。
const PROMPT_TEXT = [
  "需求：把决策入口换成可切换的本地命令。",
  "含引号 \"double\" 与单引号 'single'，还有 shell 元字符 && ; | `whoami` $(echo hacked) > out.txt",
  "第二行：中文与 emoji 🎯 都要原样过去。",
].join("\n");
writeFileSync(PROMPT_FILE, PROMPT_TEXT, "utf8");

const PROVIDER = {
  id: "fixture-provider",
  name: "Fixture Provider",
  base_url: "https://example.invalid",
  wire_api: "responses",
  requires_openai_auth: true,
  supports_websockets: false,
};

function buildConfig(backend) {
  const role = {
    kind: "decision",
    backend,
    model: "gpt-6.2-astra",
    effort: "medium",
    skills: [],
  };
  if (backend === "external-command") {
    role.executable = process.execPath;
    role.args = [FAKE_CLI, "--model", "{model}", "--effort", "{effort}"];
  }
  return {
    roles: { overmind: { ...role }, coder: { ...role } },
    provider: PROVIDER,
    alerts: {},
  };
}

function runPlan(backend, { extraArgs = [], threadId = "thread-fixture-1" } = {}) {
  const configPath = join(DIR, `team-${backend}-${extraArgs.length ? "r" : "n"}.json`);
  writeFileSync(configPath, JSON.stringify(buildConfig(backend), null, 2), "utf8");
  const res = spawnSync(
    process.execPath,
    [SCRIPT, "plan", "--prompt-file", PROMPT_FILE, "--role", "coder", ...extraArgs],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODE_TEAM_CONFIG: configPath,
        CODE_TEAM_EVENTS: EVENTS,
        CODE_TEAM_LEDGER: LEDGER,
        CODE_TEAM_CODEX_ENTRY: FAKE_CODEX,
        FAKE_LOG: LOG,
        FAKE_THREAD_ID: threadId,
      },
    }
  );
  return res;
}

function launches() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function codexLaunches() {
  return launches().filter((l) => l.argv[0] === FAKE_CODEX);
}

function cliLaunches() {
  return launches().filter((l) => l.argv[0] === FAKE_CLI);
}

function events() {
  if (!existsSync(EVENTS)) return [];
  return readFileSync(EVENTS, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log("OK   " + name);
    return;
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  -> " + detail : ""));
}

const realEventsBefore = existsSync(REAL_EVENTS) ? createHash("sha256").update(readFileSync(REAL_EVENTS)).digest("hex") : null;

// 1. 配了 external-command：启动的是外部命令，不是 codex。
const ext = runPlan("external-command");
check("external-command 退出码 0", ext.status === 0, `status=${ext.status} stderr=${(ext.stderr || "").slice(0, 200)}`);
check("external-command 启动外部命令 1 次", cliLaunches().length === 1, `实际 ${cliLaunches().length} 次`);
check("external-command 没启动 codex", codexLaunches().length === 0, `codex 被启动了 ${codexLaunches().length} 次`);
check("external-command stdout 是命令的完整输出", (ext.stdout || "").includes("替身输出：规划已完成。"), (ext.stdout || "").slice(0, 120));
if (cliLaunches().length === 1) {
  const call = cliLaunches()[0];
  check(
    "external-command 参数按元素原样传，占位符被替换",
    JSON.stringify(call.argv) === JSON.stringify([FAKE_CLI, "--model", "gpt-6.2-astra", "--effort", "medium"]),
    JSON.stringify(call.argv)
  );
  check("external-command prompt 原样到达 stdin", call.stdin === PROMPT_TEXT, JSON.stringify(call.stdin.slice(0, 120)));
}

// 2. 配了 codex-cli：启动的是 codex，prompt 走 stdin。
const cdx = runPlan("codex-cli");
check("codex-cli 退出码 0", cdx.status === 0, `status=${cdx.status} stderr=${(cdx.stderr || "").slice(0, 200)}`);
check("codex-cli 启动 codex 1 次", codexLaunches().length === 1, `实际 ${codexLaunches().length} 次`);
check("codex-cli 没启动外部命令", cliLaunches().length === 1, `外部命令被启动了 ${cliLaunches().length} 次`);
if (codexLaunches().length === 1) {
  const call = codexLaunches()[0];
  check("codex-cli prompt 从 stdin 送（命令行带 -）", call.argv.includes("-"), JSON.stringify(call.argv));
  check("codex-cli prompt 原样到达 stdin", call.stdin === PROMPT_TEXT, JSON.stringify(call.stdin.slice(0, 120)));
}

// 3. --print-prompt：不发请求、不记事件。
const before = launches().length;
const printed = runPlan("external-command", { extraArgs: ["--print-prompt"] });
check("--print-prompt 退出码 0", printed.status === 0, `status=${printed.status}`);
check("--print-prompt 没启动任何程序", launches().length === before, `多启动了 ${launches().length - before} 次`);
check("--print-prompt 打印了 prompt", (printed.stdout || "").includes("含引号"), (printed.stdout || "").slice(0, 80));

// 4. external-command 收到续问句柄：报 RESUME_UNSUPPORTED，一次都不启动。
const beforeResume = cliLaunches().length;
const extResume = runPlan("external-command", { extraArgs: ["--resume", "thread-fixture-1"] });
check("external-command 续问退出码 2", extResume.status === 2, `status=${extResume.status}`);
check("external-command 续问报 RESUME_UNSUPPORTED", (extResume.stderr || "").includes("RESUME_UNSUPPORTED"), (extResume.stderr || "").slice(0, 200));
check("external-command 续问启动次数为 0", cliLaunches().length === beforeResume, `多启动了 ${cliLaunches().length - beforeResume} 次`);

// 5. codex-cli 续问：线程对得上才记 resume。
const cdxResume = runPlan("codex-cli", { extraArgs: ["--resume", "thread-fixture-1"] });
check("codex-cli 续问退出码 0", cdxResume.status === 0, `status=${cdxResume.status} stderr=${(cdxResume.stderr || "").slice(0, 200)}`);
if (codexLaunches().length === 2) {
  const call = codexLaunches()[1];
  check("codex-cli 续问走的是 resume 分支", call.argv.includes("resume"), JSON.stringify(call.argv));
  check("codex-cli 续问带上了线程 ID", call.argv.includes("thread-fixture-1"), JSON.stringify(call.argv));
}

// 6. 续问时运行端报了别的线程 ID：不能算 resume。
const cdxOther = runPlan("codex-cli", {
  extraArgs: ["--resume", "thread-fixture-1"],
  threadId: "thread-other",
});
check("codex-cli 续问线程不符时仍退出 0", cdxOther.status === 0, `status=${cdxOther.status}`);

const all = events();
const resumeEvents = all.filter((e) => e.callMode === "resume");
const mismatchEvents = all.filter((e) => e.status === "failed" && e.errorCode === "RESUME_UNSUPPORTED");
check("线程对得上的续问记 callMode=resume", resumeEvents.length === 1, `实际 ${resumeEvents.length} 条`);
check("线程对不上的续问不记 resume", all.filter((e) => e.status === "succeeded" && e.callMode === null).length === 1, JSON.stringify(all.map((e) => [e.status, e.callMode])));
check("external-command 续问记 RESUME_UNSUPPORTED 且 callMode 为空", mismatchEvents.length === 1 && mismatchEvents[0].callMode === null, JSON.stringify(mismatchEvents));

// 7. 一次尝试只写一条事件。
const byInvocation = new Map();
for (const e of all) {
  const key = e.invocationId ?? "(无 invocationId)";
  byInvocation.set(key, (byInvocation.get(key) ?? 0) + 1);
}
const doubled = [...byInvocation.entries()].filter(([, n]) => n > 1);
check("同一尝试没有产生两条调用事件", doubled.length === 0, JSON.stringify(doubled));
check("每次尝试都有 invocationId", all.every((e) => typeof e.invocationId === "string" && e.invocationId.length > 0));

// 8. 事件如实反映后端与模型，且不含 prompt 与原始命令参数。
const extEvents = all.filter((e) => e.backend === "external-command" && e.status === "succeeded");
check("external-command 事件记了实际后端", extEvents.length === 1, `实际 ${extEvents.length} 条`);
if (extEvents.length === 1) {
  const e = extEvents[0];
  check("external-command 事件记了模型与请求模型", e.model === "gpt-6.2-astra" && e.requestedModel === "gpt-6.2-astra", JSON.stringify(e));
  check("external-command 事件记了档位", e.effort === "medium" && e.requestedEffort === "medium", JSON.stringify(e));
  check("external-command 事件记了 callMode=new", e.callMode === "new", JSON.stringify(e));
}
const codexEvents = all.filter((e) => e.backend === "codex-cli" && e.status === "succeeded");
check("codex-cli 事件记了用量", codexEvents.every((e) => e.usage && e.usage.input_tokens === 11), JSON.stringify(codexEvents.map((e) => e.usage)));

const eventsText = existsSync(EVENTS) ? readFileSync(EVENTS, "utf8") : "";
check("事件里没有 prompt 内容", !eventsText.includes("shell 元字符") && !eventsText.includes("whoami"), eventsText.slice(0, 200));
check("事件里没有原始命令参数", !eventsText.includes("--model") && !eventsText.includes(FAKE_CLI), eventsText.slice(0, 200));

// 9. 仓库真实事件流一个字节都没动。
const realEventsAfter = existsSync(REAL_EVENTS) ? createHash("sha256").update(readFileSync(REAL_EVENTS)).digest("hex") : null;
check("仓库的真实事件流没被改动", realEventsBefore === realEventsAfter);

// 10. 预检不启动任何外部程序。
const PREFLIGHT_HELPER = join(DIR, "preflight-probe.mjs");
writeFileSync(PREFLIGHT_HELPER, "import { pathToFileURL } from \"node:url\";\nconst mod = await import(pathToFileURL(process.argv[2]).href);\nconst cfg = JSON.parse(process.argv[3]);\nconst r = mod.preflight(\"coder\", cfg.roles.coder, { config: cfg, cwd: process.cwd(), eventsFile: process.argv[4] });\nconsole.log(JSON.stringify({ status: r.status, nextStep: r.nextStep }));\n", "utf8");
const beforePreflight = launches().length;
const preflight = spawnSync(
  process.execPath,
  [PREFLIGHT_HELPER, join(ROOT, "scripts", "decision-backend.mjs"), JSON.stringify(buildConfig("external-command")), EVENTS],
  { encoding: "utf8" }
);
check("预检可用且给出结论", (preflight.stdout || "").includes('"status"'), (preflight.stdout || "").slice(0, 200) + (preflight.stderr || "").slice(0, 200));
check("预检期间启动次数为 0", launches().length === beforePreflight, `多启动了 ${launches().length - beforePreflight} 次`);

// 11. 命令行记事件：路径能被环境变量改写，契约 2 的新字段要认。
//     这两条曾经都坏过：--kind 被忽略，CLI 还死盯着仓库里的真实事件流。
const CLI_EVENTS = join(DIR, "cli-events.jsonl");
const realEventsBeforeCli = existsSync(REAL_EVENTS) ? createHash("sha256").update(readFileSync(REAL_EVENTS)).digest("hex") : null;
const recordCli = (extraArgs) =>
  spawnSync(process.execPath, [join(ROOT, "scripts", "record-event.mjs"), "record", ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, CODE_TEAM_EVENTS: CLI_EVENTS },
  });
recordCli([
  "--kind", "dispatch", "--role", "worker", "--agent", "worker",
  "--invocation-id", "inv-cli-1", "--status", "started",
  "--requested-model", "m-1", "--requested-effort", "high",
]);
recordCli([
  "--kind", "call", "--role", "overmind", "--backend", "codex-cli",
  "--invocationId", "inv-cli-2", "--status", "failed", "--call-mode", "new",
  "--error-code", "NONZERO_EXIT", "--requested-model", "m-2", "--requested-effort", "medium",
]);
const cliEvents = existsSync(CLI_EVENTS)
  ? readFileSync(CLI_EVENTS, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];
check("CLI 记的事件落在 CODE_TEAM_EVENTS 指的临时文件", cliEvents.length === 2, `临时文件里有 ${cliEvents.length} 条`);
const realEventsAfterCli = existsSync(REAL_EVENTS) ? createHash("sha256").update(readFileSync(REAL_EVENTS)).digest("hex") : null;
check("CLI 没写真实事件流", realEventsBeforeCli === realEventsAfterCli);
if (cliEvents.length === 2) {
  check("--kind dispatch 真的产生 kind=dispatch", cliEvents[0].kind === "dispatch", JSON.stringify(cliEvents[0]));
  check(
    "CLI 认得契约 2 的新字段",
    cliEvents[0].invocationId === "inv-cli-1"
      && cliEvents[0].agent === "worker"
      && cliEvents[0].status === "started"
      && cliEvents[0].requestedModel === "m-1"
      && cliEvents[0].requestedEffort === "high",
    JSON.stringify(cliEvents[0])
  );
  check(
    "CLI 认得 --call-mode 与 --error-code",
    cliEvents[1].callMode === "new" && cliEvents[1].errorCode === "NONZERO_EXIT" && cliEvents[1].invocationId === "inv-cli-2",
    JSON.stringify(cliEvents[1])
  );
}
const cliList = spawnSync(process.execPath, [join(ROOT, "scripts", "record-event.mjs"), "list"], {
  encoding: "utf8",
  env: { ...process.env, CODE_TEAM_EVENTS: CLI_EVENTS },
});
check("CLI list 也读临时文件", (cliList.stdout || "").includes("inv-cli-1"), (cliList.stdout || "").slice(0, 120));

console.log("");
if (failures) {
  console.log(failures + " 条检查未通过");
  process.exit(1);
}
console.log("PASS decision-backend");
