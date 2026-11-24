#!/usr/bin/env node
// Code Team 首次会话自举：只读就绪预检。
//
// 宿主无关入口：runPreflight({ sessionId, cwd }) -> { sessionId, status, checks, nextStep }
// 形状复用契约 1 的 preflight；status 取 ready | blocked | unknown。
// 因为后端模块是动态载入的，runPreflight 是 async，调用方 await 它。
//
// 硬约束（架构决定 1）：预检期间不启动任何外部程序、不发任何模型请求。
// 所以这里只读文件。缺组件时只给一条可执行的下一步，修复由用户显式执行。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexReadiness } from "./codex-bootstrap.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "team.json");
// 与 scripts/codex-team.mjs 同义：事件流与规划输出 schema 的真实位置。
const EVENTS_FILE = join(ROOT, "config", "events.jsonl");
const SCHEMA_FILE = join(ROOT, "config", "plan-schema.json");
const BOOTSTRAP = join(ROOT, "scripts", "codex-bootstrap.mjs");
const DECISION_ROLES = ["overmind", "coder"];

function check(id, status, detail) {
  return { id, status, detail };
}

// 契约 1 只规定了外层 status；逐项检查用 ok / failed / unknown 三态，
// 这样"哪一项阻塞"能被单独说出来。别的包实现的后端返回别的词时按同一张表归一。
const OK_WORDS = new Set(["ok", "passed", "ready", "supported"]);
const FAILED_WORDS = new Set(["failed", "blocked", "error", "unsupported"]);
function normStatus(word) {
  if (OK_WORDS.has(word)) return "ok";
  if (FAILED_WORDS.has(word)) return "failed";
  return "unknown";
}

// 下一个可执行步骤：按候选顺序，取第一个真的失败了的检查对应的步骤。
function firstNextStep(checks, candidates) {
  for (const [id, step] of candidates) {
    if (checks.some((c) => c.id === id && c.status === "failed")) return step;
  }
  return null;
}

// Codex 侧环境：Codex 看不到本项目的验收命令与已知坑，规划就会瞎猜。
// 后端模块不查这一项，所以归 P1。
function codexEnvCheck(role) {
  const r = codexReadiness();
  return r.agentsFound
    ? check(role + ".codex.env", "ok", "Codex 侧 AGENTS.md 在位：" + r.agentsFile)
    : check(role + ".codex.env", "failed", "Codex 侧缺少 AGENTS.md（" + r.agentsFile + "）：Codex 看不到本项目的验收命令与已知坑");
}

function codexEnvStep(ctx) {
  return {
    text: "同步 Codex 侧环境（会写 Codex 的配置目录，由你显式执行）：node " + quote(BOOTSTRAP) + " " + quote(ctx.cwd) + " sync",
    command: { executable: "node", args: [BOOTSTRAP, ctx.cwd, "sync"] },
  };
}

// 后端模块缺席时的兜底：本地只判得出 Codex 入口在不在。
function localCodexChecks(role) {
  const r = codexReadiness();
  return r.codexEntryFound
    ? [check(role + ".codex.entry", "ok", "Codex 入口可用：" + r.codexEntry)]
    : [check(role + ".codex.entry", "failed", "找不到 Codex 可执行入口（预期 " + r.codexEntry + "）")];
}

// P2 的后端实现落地后走同一条契约；文件不在时只能报"无法本地判定"。
let backendModule;
async function loadDecisionBackend() {
  if (backendModule !== undefined) return backendModule;
  const file = join(ROOT, "scripts", "decision-backend.mjs");
  if (!existsSync(file)) {
    backendModule = null;
    return null;
  }
  try {
    const mod = await import(pathToFileURL(file).href);
    backendModule = typeof mod.preflight === "function" ? mod : null;
  } catch {
    backendModule = null;
  }
  return backendModule;
}

async function backendPreflight(role, rc, ctx) {
  const backend = typeof rc.backend === "string" && rc.backend.trim() ? rc.backend.trim() : "codex-cli";
  const mod = await loadDecisionBackend();
  if (mod) {
    // 后端知识只在 scripts/decision-backend.mjs 一份里，这里不重写。
    const res = await mod.preflight(role, rc, ctx);
    const checks = (res.checks ?? []).map((c) => check(c.id, normStatus(c.status), c.detail ?? ""));
    let nextStep = res.nextStep ?? null;
    if (backend === "codex-cli") {
      const env = codexEnvCheck(role);
      checks.push(env);
      if (env.status === "failed" && !nextStep) nextStep = codexEnvStep(ctx);
    }
    return { checks, nextStep, status: res.status ?? null };
  }
  if (backend === "codex-cli") {
    const checks = [...localCodexChecks(role), codexEnvCheck(role)];
    const nextStep = firstNextStep(checks, [
      [role + ".codex.entry", {
        text: "安装 Codex CLI：npm install -g @openai/codex",
        command: { executable: "npm", args: ["install", "-g", "@openai/codex"] },
      }],
      [role + ".codex.env", codexEnvStep(ctx)],
    ]);
    return { checks, nextStep, status: null };
  }
  if (backend === "external-command") {
    return {
      checks: [check(role + ".external-command", "unknown", "本地无法判定该后端是否可用（缺 scripts/decision-backend.mjs）")],
      nextStep: null,
      status: "unknown",
    };
  }
  return {
    checks: [check(role + ".backend", "failed", "后端 " + backend + " 不可用")],
    nextStep: {
      text: "把 " + role + " 的后端改成 codex-cli 或 external-command；不用 Overmind 时可改用内置 Agent Team，但本插件不会替你换掉它",
      command: null,
    },
    status: "blocked",
  };
}

// 宿主无关入口：只读预检。返回契约 1 的形状，不启动外部程序、不发模型请求。
export async function runPreflight({ sessionId = null, cwd = null } = {}) {
  const workdir = cwd || process.cwd();
  const checks = [];
  let nextStep = null;
  let blocked = false;
  let unknown = false;

  if (!existsSync(CONFIG)) {
    checks.push(check("config", "failed", "找不到角色配置：" + CONFIG));
    return {
      sessionId,
      status: "blocked",
      checks,
      nextStep: { text: "重新安装插件（node scripts/install-plugin.mjs），让 config/team.json 到位", command: null },
    };
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch (e) {
    checks.push(check("config", "failed", "角色配置不是合法 JSON：" + e.message));
    return {
      sessionId,
      status: "blocked",
      checks,
      nextStep: { text: "修好 config/team.json 的 JSON 语法", command: null },
    };
  }

  const roles = (cfg && cfg.roles) || {};
  for (const role of DECISION_ROLES) {
    const rc = roles[role];
    if (!rc) {
      checks.push(check(role + ".config", "failed", "配置里没有 " + role + " 这个决策角色"));
      blocked = true;
      if (!nextStep) nextStep = { text: "把 " + role + " 角色补回 config/team.json（可照仓库默认配置补）", command: null };
      continue;
    }
    // 契约 1 的键表：config / cwd / eventsFile / schemaFile。三个入口共用同一份上下文，别处不要另写一份。
    const res = await backendPreflight(role, rc, { config: cfg, cwd: workdir, eventsFile: EVENTS_FILE, schemaFile: SCHEMA_FILE });
    for (const c of res.checks) {
      checks.push(check(c.id.startsWith(role) ? c.id : role + "." + c.id, c.status, c.detail));
    }
    if (res.status === "blocked" || res.checks.some((c) => c.status === "failed")) {
      blocked = true;
      if (!nextStep && res.nextStep) nextStep = res.nextStep;
    } else if (res.status === "unknown" || res.checks.some((c) => c.status === "unknown")) {
      unknown = true;
    }
  }

  if (blocked && !nextStep) {
    nextStep = { text: "按上面失败的检查逐项处理后重开会话", command: null };
  }
  return {
    sessionId,
    status: blocked ? "blocked" : unknown ? "unknown" : "ready",
    checks,
    nextStep: blocked ? nextStep : null,
  };
}

function quote(s) {
  return /\s/.test(s) ? "\"" + s + "\"" : s;
}

function commandLine(cmd) {
  return [cmd.executable, ...(cmd.args ?? [])].map(quote).join(" ");
}

// 宿主要的是"下一步做什么"，不是一份体检报告：只讲被挡住的那几项。
function blockedText(result) {
  const lines = ["Code Team 自举预检未通过：本次会话缺少必要组件。"];
  for (const c of result.checks) {
    if (c.status === "failed") lines.push("- " + c.id + "：" + c.detail);
  }
  const step = result.nextStep;
  if (step) {
    lines.push("下一步（只做这一步）：" + step.text);
    if (step.command) lines.push("命令：" + commandLine(step.command));
  }
  return lines.join("\n");
}

async function readHookInput() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 1024 * 1024) break;
    }
  } catch {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const input = await readHookInput();
  const result = await runPreflight({
    sessionId: input.session_id ?? null,
    cwd: input.cwd ?? process.cwd(),
  });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === "blocked") {
    // 普通 stdout 会被宿主当作 additionalContext 注入；ready 时不输出，保持安静。
    console.log(blockedText(result));
  }
  process.exit(0);
}
