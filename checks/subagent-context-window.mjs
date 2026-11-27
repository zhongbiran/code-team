#!/usr/bin/env node
// 检查：派工参数不得把子会话上下文顶到 512k 以上。
//
// 原因（2026-11-27 探针实测）：
//   Task 里显式传 model → 运行时忽略 agent 自己声明的 x-mavis.contextWindow（worker/verifier 声明 512000），
//   改用宿主模型目录里 contextWindowOptions 的最大值（M3.1-Flash 给到 1000000，标 higher_usage）。
//   探针 A（不传 model）→ 子会话 512000；探针 B（传 model）→ 子会话 1000000。
//   上下文越大，每次模型调用重发的累积上下文越多，cacheRead 主导的账单线性放大。
//
// 规则（两条都判）：
//   1) 派工参数里的 model 若与 agent 自身声明相同 → 不该下传（下传 = 白白覆盖 agent 的窗口声明）。
//   2) 派工参数里的 model 若在宿主模型目录里的最大上下文 > 512000 → 不该下传。
//   角色没钉 model（不产生 model 参数）→ 放行。
//
// 用法：node checks/subagent-context-window.mjs [--max-window 512000]
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MAX = 512000;

/** 宿主数据目录：环境变量 > 插件所在的数据目录（两级上）> 用户主目录下的 .minimax */
export function hostDataDir() {
  const candidates = [
    process.env.MINIMAX_HOME,
    resolve(ROOT, "..", ".."),
    join(homedir(), ".minimax"),
  ].filter(Boolean);
  for (const base of candidates) {
    if (existsSync(join(base, "config.yaml"))) return base;
  }
  return null;
}

/** 从宿主模型目录文本里取某个 model 的最大上下文选项（取不到返回 null） */
export function modelMaxContext(hostConfigText, modelId) {
  if (!hostConfigText || !modelId) return null;
  const lines = hostConfigText.split(/\r?\n/);
  let indent = -1;
  let options = [];
  let limitContext = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const curIndent = raw.length - raw.trimStart().length;
    if (indent >= 0) {
      if (trimmed.endsWith(":") && curIndent <= indent) break; // 下一个同级键 → 块结束
      if (trimmed === "contextWindowOptions:") {
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j].trim();
          if (!t.startsWith("-")) break;
          const n = Number(t.slice(1).trim());
          if (Number.isFinite(n)) options.push(n);
        }
      }
      if (trimmed.startsWith("context:") && limitContext == null) {
        const n = Number(trimmed.slice("context:".length).trim());
        if (Number.isFinite(n)) limitContext = n;
      }
      continue;
    }
    if (trimmed.endsWith(":") && trimmed.slice(0, -1) === modelId) indent = curIndent;
  }
  if (options.length) return Math.max.apply(null, options);
  return limitContext;
}

/** 读 agent 定义 frontmatter 里的 model */
export function agentModel(dataDir, role) {
  if (!dataDir) return null;
  const files = [
    join(dataDir, "agents", role, "agent.md"),
    join(dataDir, "agents", ".builtin", role, "agent.md"),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const end = text.indexOf("---", 3);
    const front = text.slice(0, end === -1 ? text.length : end);
    for (const line of front.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("model:")) {
        const v = trimmed.slice("model:".length).trim().replace(/^["']|["']$/g, "");
        if (v) return v;
      }
    }
  }
  return null;
}

/**
 * 判定。dispatchByRole: { role: 派工参数输出对象 }；agentModels: { role: agent 声明的 model }。
 * 返回 Finding[]：{ code, severity, role, message }
 */
export function checkSubagentContextWindow({
  dispatchByRole = {},
  agentModels = {},
  hostConfigText = "",
  maxWindow = DEFAULT_MAX,
} = {}) {
  const findings = [];
  for (const [role, out] of Object.entries(dispatchByRole)) {
    const model = out && out.taskArgs ? out.taskArgs.model : null;
    if (!model) continue; // 没下传 model → agent 自己的声明生效
    const agentModel = agentModels[role] || null;
    if (agentModel && model === agentModel) {
      findings.push({
        code: "model-overrides-agent-default",
        severity: "error",
        role,
        message:
          "角色 " + role + " 的派工参数带了 model " + model + "，它与 agent 自身声明相同 —— " +
          "显式下传会覆盖 agent 声明的上下文窗口（实测 512k 被顶成 1M，cacheRead 按累积上下文线性放大）。" +
          "改法：dispatch-params 不要下传与 agent 默认相同的 model。",
      });
      continue;
    }
    const max = modelMaxContext(hostConfigText, model);
    if (max == null) {
      findings.push({
        code: "context-window-unknown",
        severity: "error",
        role,
        message: "角色 " + role + " 要下传 model " + model + "，但宿主模型目录里读不到它的上下文上限 —— 宁可误拒不可误放",
      });
      continue;
    }
    if (max > maxWindow) {
      findings.push({
        code: "context-window-too-large",
        severity: "error",
        role,
        message:
          "角色 " + role + " 要下传 model " + model + "，它的最大上下文 " + max + " > " + maxWindow + " —— " +
          "下传后子会话就是这一档，cacheRead 账单按累积上下文线性放大。改法：换更小的模型，或让 agent 默认生效。",
      });
    }
  }
  return findings;
}

function runCli(args = {}) {
  const maxWindow = Number(args["max-window"] || DEFAULT_MAX);
  const dataDir = hostDataDir();
  if (!dataDir) {
    console.error("找不到宿主数据目录（要有 config.yaml）；可用 MINIMAX_HOME 指过去");
    return 1;
  }
  const teamPath = join(ROOT, "config", "team.json");
  const team = JSON.parse(readFileSync(teamPath, "utf8"));
  const hostConfigText = readFileSync(join(dataDir, "config.yaml"), "utf8");
  const dispatchByRole = {};
  const agentModels = {};
  for (const [role, roleCfg] of Object.entries(team.roles || {})) {
    if (!roleCfg || roleCfg.kind === "decision") continue;
    agentModels[role] = agentModel(dataDir, role);
    try {
      const raw = execFileSync(process.execPath, [join(ROOT, "scripts", "dispatch-params.mjs"), role], {
        encoding: "utf8",
        cwd: ROOT,
      });
      dispatchByRole[role] = JSON.parse(raw);
    } catch (error) {
      console.error("角色 " + role + " 的派工参数取不到：" + (error && error.message));
      return 1;
    }
  }
  const findings = checkSubagentContextWindow({ dispatchByRole, agentModels, hostConfigText, maxWindow });
  if (findings.length) {
    console.error("发现会把子会话上下文顶过头的派工：");
    for (const f of findings) console.error("  " + f.message);
    return 1;
  }
  console.log("OK：派工参数没有把子会话上下文顶过 " + maxWindow + "（" + Object.keys(dispatchByRole).join("、") + "）");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (!process.argv[i].startsWith("--")) continue;
    const k = process.argv[i].slice(2);
    args[k] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
  }
  process.exit(runCli(args));
}
