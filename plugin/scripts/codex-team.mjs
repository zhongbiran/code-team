#!/usr/bin/env node
// Code Team 的 Codex 调用封装。
// 存在的理由：本机 WebSocket 到 ChatGPT 不通，裸跑 codex exec 会先空转 5 次重连
// （约 120 秒）才降级 HTTPS。这里用自定义 provider 直接走 HTTPS，并统一模型/档位/只读沙箱。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { recordEvent, readEvents } from "./record-event.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "team.json");
const EVENTS_FILE = join(ROOT, "config", "events.jsonl");
const LEDGER = join(ROOT, "config", "usage-ledger.json");
const SCHEMA = join(ROOT, "config", "plan-schema.json");

const ROLES = ["overmind", "coder"];

// 定位 codex 的 JS 入口（node_modules/@openai/codex/bin/codex.js）。
// 优先从 PATH 上的 codex.cmd 反推，找不到就退回默认的全局安装路径。
function resolveCodexEntry() {
  const candidates = [];
  const npmRoot = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
    : null;
  if (npmRoot) candidates.push(npmRoot);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  console.error("找不到 codex 可执行入口（预期 node_modules/@openai/codex/bin/codex.js）");
  process.exit(2);
}

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG, "utf8"));
}

// 用自定义 provider 覆盖内置 openai（内置 provider 不允许被覆盖，只能另起一个 id）。
// supports_websockets=false 是关键：它让 codex 跳过 WebSocket 直连，不再空转 120 秒。
function providerArgs(cfg) {
  const p = cfg.provider;
  return [
    "-c", `model_provider="${p.id}"`,
    "-c", `model_providers.${p.id}.name="${p.name}"`,
    "-c", `model_providers.${p.id}.base_url="${p.base_url}"`,
    "-c", `model_providers.${p.id}.wire_api="${p.wire_api}"`,
    "-c", `model_providers.${p.id}.requires_openai_auth=true`,
    "-c", `model_providers.${p.id}.supports_websockets=false`,
  ];
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
  const all = readEvents().filter((e) => e.kind === "codex-call" || e.kind === "call");
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
  "    Done = (tangible check): <一条能跑的命令 + 期望输出>",
  "    Mode: think with me | do it for me",
  "    When done: show commands run and their output first, then the summary,",
  "    then the decisions and assumptions you made.",
  "",
  "注意 Done 栏只给\"一条命令 + 期望输出\"，不要穷举该测什么——测什么由执行者判断。",
  "",
  "## 需要 Coder 的部分",
  "如果要动代码方向（接口设计、实现取舍、核心问题定位），在这里指明哪几包需要 Coder 介入。",
  ""
].join("\n");

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
  const roleCfg = cfg[role];
  const model = args.model ?? roleCfg.model;
  const effort = args.effort ?? roleCfg.effort;
  let prompt = readFileSync(promptPath, "utf8");
  // 契约是流程骨架（决策/拆包/brief/是否要 Coder），不受 --plain 影响。
  // --plain 只控制"要不要结构化 JSON 输出"，不控制"要不要给下游用的骨架"。
  if (role === "overmind") prompt = prompt + "\n" + OVERMIND_CONTRACT;

  // codex 的全局选项必须排在子命令之前，exec 的选项排在其后。
  const globalArgs = [...providerArgs(cfg), "-m", model, "-c", `model_reasoning_effort="${effort}"`];
  // exec 与 exec resume 的选项集不同：
  // resume 不接受 --sandbox / -C（沿用原线程设置），但接受 --skip-git-repo-check / --output-schema。
  const execArgs = ["--skip-git-repo-check", "--json"];
  if (!args.resume) {
    execArgs.unshift("--sandbox", "read-only");
    if (args.cwd) execArgs.push("-C", String(args.cwd));
  }
  if (!args.plain && existsSync(SCHEMA)) execArgs.push("--output-schema", SCHEMA);

  const cmd = [];
  if (args.resume) cmd.push("exec", "resume", ...globalArgs, ...execArgs, String(args.resume));
  else cmd.push("exec", ...globalArgs, ...execArgs);

  const started = Date.now();
  // 直接跑 codex 的 JS 入口，不经 shell：避开 Windows .cmd 包装，也就没有 shell 注入面和弃用警告。
  const codexJs = resolveCodexEntry();
  const res = spawnSync(process.execPath, [codexJs, ...cmd], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  let usage = null;
  let threadId = null;
  let lastMessage = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === "thread.started") threadId = evt.thread_id;
    if (evt.type === "turn.completed") usage = evt.usage;
    if (evt.type === "item.completed" && evt.item?.type === "agent_message") lastMessage = evt.item.text;
  }

  if (res.error) {
    console.error("codex 调用失败: " + res.error.message);
    process.exit(1);
  }
  const event = {
    at: new Date().toISOString(),
    kind: "codex-call",
    role,
    backend: "codex-cli",
    model,
    effort,
    project: args.project ?? null,
    session: args.session ?? threadId ?? null,
    task: args.task ?? null,
    skill: args.skill ?? "code-team",
    plugin: args.plugin ?? "code-team",
    elapsedSec: Number(elapsed),
    usage,
    ok: res.status === 0,
    note: threadId ? "thread:" + threadId : null,
  };
  if (usage) appendUsage({ at: event.at, role, model, effort, elapsedSec: event.elapsedSec, threadId, usage });
  // 通用事件流：后端无关，换后端统计不用改。
  recordEvent(event);

  console.log(lastMessage || stdout || "(无输出)");
  console.error("\n--- codex 调用元信息 ---");
  console.error("role=" + role + " model=" + model + " effort=" + effort + " elapsed=" + elapsed + "s");
  if (threadId) console.error("thread_id=" + threadId);
  if (usage) console.error("usage=" + JSON.stringify(usage));
  if (res.status !== 0) {
    console.error(stderr.slice(0, 2000));
    process.exit(res.status ?? 1);
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
