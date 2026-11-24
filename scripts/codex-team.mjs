#!/usr/bin/env node
// Code Team 的 Codex 调用封装。
// 存在的理由：本机 WebSocket 到 ChatGPT 不通，裸跑 codex exec 会先空转 5 次重连
// （约 120 秒）才降级 HTTPS。这里用自定义 provider 直接走 HTTPS，并统一模型/档位/只读沙箱。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { recordEvent, readEvents } from "./record-event.mjs";
import { DEFAULT_EFFORT, DEFAULT_MODELS, invoke, sanitize, targetKey } from "./decision-backend.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 这几个路径可以用环境变量指走别处：测试与验收必须用隔离目录，不许碰真实运行态。
const CONFIG = process.env.CODE_TEAM_CONFIG || join(ROOT, "config", "team.json");
const EVENTS_FILE = process.env.CODE_TEAM_EVENTS || join(ROOT, "config", "events.jsonl");
const LEDGER = process.env.CODE_TEAM_LEDGER || join(ROOT, "config", "usage-ledger.json");
const SCHEMA = process.env.CODE_TEAM_SCHEMA || join(ROOT, "config", "plan-schema.json");

const ROLES = ["overmind", "coder"];

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG, "utf8"));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readLedger() {
  if (!existsSync(LEDGER)) return { calls: [] };
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch {
    return { calls: [] };
  }
}

function appendUsage(entry) {
  const ledger = readLedger();
  ledger.calls.push(entry);
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

// 预算从事件流算——它是唯一真相源。
// 旧版另有一份 usage-ledger.json，两份账本迟早会打架。
function showBudget() {
  const now = Date.now();
  const windowMs = 5 * 60 * 60 * 1000;
  const all = readEvents(EVENTS_FILE).filter((e) => e.kind === "codex-call" || e.kind === "call");
  const recent = all.filter((e) => now - new Date(e.at).getTime() < windowMs);
  const utc = new Date(now);
  const today = all.filter((e) => {
    const d = new Date(e.at);
    return d.getUTCFullYear() === utc.getUTCFullYear() &&
      d.getUTCMonth() === utc.getUTCMonth() &&
      d.getUTCDate() === utc.getUTCDate();
  });

  const stat = (list, title) => {
    const sum = (k) => list.reduce((n, e) => n + (e.usage?.[k] ?? 0), 0);
    const elapsed = list.reduce((n, e) => n + (e.elapsedSec ?? 0), 0);
    console.log(title);
    console.log("  调用次数: " + list.length);
    console.log("  input tokens: " + sum("input_tokens"));
    console.log("  cached tokens: " + sum("cached_input_tokens"));
    console.log("  output tokens: " + sum("output_tokens"));
    console.log("  reasoning tokens: " + sum("reasoning_output_tokens"));
    console.log("  总耗时: " + elapsed.toFixed(1) + "s");
    if (list.length) {
      const byRole = {};
      for (const c of list) byRole[c.role ?? "(未记录)"] = (byRole[c.role ?? "(未记录)"] ?? 0) + 1;
      console.log("  按角色: " + JSON.stringify(byRole));
    }
    console.log("");
  };

  stat(recent, "最近 5 小时窗口（额度约束看这个）");
  stat(today, "今天累计（UTC 日）");
  console.log("  事件流: " + EVENTS_FILE);
}

// Overmind 的输出契约：它必须产出决策、拆包和每个包的 brief —— 主会话不参与这些判断。
// 主会话只负责：把需求原样转交、拿到结果、按拆包派工、转发用户的追加问题。
const OVERMIND_CONTRACT = [
  "",
  "除了回答问题，你必须额外产出以下结构化内容：",
  "",
  "## 决策记录",
  "你在这次规划里替人做的每一个决定，逐条列出：决定、理由、放弃了哪些方案、代价是什么。",
  "",
  "## 拆包",
  "按\"文件归属不重叠\"拆成可并行的包，每包一个明确交付物。",
  "",
  "## 每个包的 brief",
  "每个包按下面格式给出 brief。这份 brief 会原样发给执行者，不要省略字段：",
  "",
  "    Stakes: low | high",
  "    Hypothesis: <你对这个包的预判>",
  "    Goal / users / out of scope: ...",
  "    Done = (tangible check): <一条能跑命令 + 期望输出>",
  "    Role: worker | explore | verifier  （这包交给谁执行）",
  "    Mode: think with me | do it for me",
  "    When done: show commands run and their output first, then the summary,",
  "    then the decisions and assumptions you made.",
  "",
  "注意 Done 栏只给\"一条命令 + 期望输出\"，不要穷举该测什么——测什么由执行者判断。",
  "",
  "Role 栏必须写明这包交给谁（worker / explore / verifier）：派工会按它取该角色该用的 skill，",
  "写错会让执行者用错方法（比如让只读的 explore 去改代码）。",
  "",
  "## 需要 Coder 的部分",
  "如果要动代码方向（接口设计、实现取舍、核心问题定位），在这里指明哪几包需要 Coder 介入。",
  ""
].join("\n");

// 该角色该用的 skill 清单。写成"命中才用"而不是"全用"——
// 点名的目的是消歧（同名旧版与官方版并存时模型会选错），不是强行走完整流程。
function skillSection(skills) {
  return [
    "",
    "## 本次可用 skill",
    "任务匹配时，先加载对应 skill 再动手（命中才用，不要全用）：",
    ...skills.map((s) => "- " + s),
    ""
  ].join("\n");
}

function runPlan(args) {
  const role = args.role;
  if (!ROLES.includes(role)) {
    console.error("--role 必须是 " + ROLES.join(" 或 "));
    process.exit(2);
  }
  if (!args["prompt-file"]) {
    console.error("缺少 --prompt-file <需求文件>");
    process.exit(2);
  }
  const promptPath = resolve(String(args["prompt-file"]));
  if (!existsSync(promptPath)) {
    console.error("需求文件不存在: " + promptPath);
    process.exit(2);
  }

  const cfg = loadConfig();
  // 配置两种形态都认：新的 { roles: { overmind: {...} } }，旧的 { overmind: {...} }。
  // 认旧形态是为了让改配置前装好的插件不会因为结构升级直接崩掉。
  const roleCfg = cfg.roles?.[role] ?? cfg[role];
  if (!roleCfg) {
    console.error(`team.json 里没有角色 "${role}" 的配置`);
    process.exit(2);
  }
  // 调用方式由角色的 backend 决定：codex-cli 或用户配置的本地外部命令。
  const backend = roleCfg.backend ?? "codex-cli";
  const model = args.model ?? roleCfg.model ?? (backend === "codex-cli" ? DEFAULT_MODELS[role] ?? null : null);
  const effort = args.effort ?? roleCfg.effort ?? (backend === "codex-cli" ? DEFAULT_EFFORT : null);
  let prompt = readFileSync(promptPath, "utf8");
  // 契约是流程骨架（决策/拆包/brief/是否要 Coder），不受 --plain 影响。
  // --plain 只控制"要不要结构化 JSON 输出"，不控制"要不要给下游用的骨架"。
  if (role === "overmind") prompt = prompt + "\n" + OVERMIND_CONTRACT;
  // 点名该角色该用的 skill。实测：Codex 侧同名 skill 的旧中文版与官方版并存时，
  // 模型倾向选旧的，不点名就会一直用旧流程。
  const skills = Array.isArray(roleCfg.skills) ? roleCfg.skills : [];
  if (skills.length) prompt = prompt + "\n" + skillSection(skills);

  // --print-prompt：只打印拼好的 prompt，不发请求、不记事件。
  // 用来零成本验证"注入的内容对不对"，不用真烧一次额度。
  if (args["print-prompt"]) {
    console.log(prompt);
    process.exit(0);
  }

  const localContext = {
    config: cfg,
    cwd: args.cwd ? resolve(String(args.cwd)) : process.cwd(),
    eventsFile: EVENTS_FILE,
    schemaFile: SCHEMA,
    codexEntry: process.env.CODE_TEAM_CODEX_ENTRY || null,
    modelsFile: process.env.CODE_TEAM_MODELS || null,
  };
  const invocationId = randomUUID();
  // 续问句柄：线程 ID 由用户给，后端自己核对它是不是本地确认过的线程。
  const continuation = args.resume
    ? {
        backend,
        role,
        threadId: String(args.resume),
        targetKey: targetKey(role, { ...roleCfg, model, effort }, localContext),
      }
    : null;

  const result = invoke(
    {
      invocationId,
      role,
      roleConfig: { ...roleCfg, model, effort },
      prompt,
      cwd: localContext.cwd,
      continuation,
      project: args.project ?? null,
      session: args.session ?? null,
      task: args.task ?? null,
      plain: Boolean(args.plain),
    },
    localContext
  );

  // 一次尝试只写一条事件。写两条的话看板会把一次调用算成两次。
  const threadId = result.continuation?.threadId ?? null;
  const event = {
    at: new Date().toISOString(),
    kind: "call",
    role,
    backend: result.backend,
    // 模型与档位优先填运行端报告的实际值；外部命令没报告就填 null，
    // 请求值另记在 requestedModel/requestedEffort。
    model: result.reportedModel ?? (result.backend === "codex-cli" ? model : null),
    effort: result.reportedEffort ?? (result.backend === "codex-cli" ? effort : null),
    project: args.project ?? null,
    session: args.session ?? threadId ?? null,
    task: args.task ?? null,
    skill: args.skill ?? "code-team",
    plugin: args.plugin ?? "code-team",
    elapsedSec: result.elapsedSec ?? null,
    usage: result.usage ?? null,
    ok: result.ok,
    note: threadId ? "thread:" + threadId : null,
    invocationId,
    agent: null,
    requestedModel: model ?? null,
    requestedEffort: effort ?? null,
    callMode: result.callMode ?? null,
    status: result.ok ? "succeeded" : "failed",
    errorCode: result.error?.code ?? null,
    errorMessage: result.error ? sanitize(result.error.message) : null,
    threadId,
    continuation: result.continuation ?? null,
  };
  if (event.usage) {
    appendUsage({ at: event.at, role, model: event.model, effort: event.effort, elapsedSec: event.elapsedSec, threadId, usage: event.usage });
  }
  recordEvent(event, EVENTS_FILE);

  console.log(result.text || "(无输出)");
  console.error("\n--- 决策调用元信息 ---");
  console.error("role=" + role + " backend=" + result.backend + " model=" + event.model + " effort=" + event.effort + " elapsed=" + event.elapsedSec + "s");
  if (threadId) console.error("thread_id=" + threadId);
  if (result.usage) console.error("usage=" + JSON.stringify(result.usage));
  if (!result.ok) {
    console.error("调用失败: " + result.error.code + " " + result.error.message);
    // 配置与用法类错误给 2（跟其它参数错误一致），运行失败沿用后端的退出码。
    const usageErrors = ["INVALID_CONFIG", "PREFLIGHT_BLOCKED", "RESUME_UNSUPPORTED", "RESUME_MISMATCH"];
    process.exit(usageErrors.includes(result.error.code) ? 2 : result.exitCode ?? 1);
  }
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (cmd === "budget") {
  showBudget();
} else if (cmd === "plan") {
  runPlan(args);
} else {
  console.log("用法:");
  console.log("  codex-team.mjs plan --prompt-file <file> --role overmind|coder [--effort medium|high] [--model <slug>] [--resume <thread_id>] [--cwd <dir>] [--plain] [--project <名称>] [--task <名称>] [--skill <名称>] [--plugin <名称>]");
  console.log("  codex-team.mjs budget");
  process.exit(cmd ? 2 : 0);
}
