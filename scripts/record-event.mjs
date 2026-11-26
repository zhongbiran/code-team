#!/usr/bin/env node
// Code Team 的通用调用事件记录器。
//
// 设计要点：事件流**不绑定任何后端**。Codex、Grok、别的 CLI、还是 MCode 自己，
// 都往同一个事件流里写同一种格式。后端换了，统计不用改。
//
// 一条事件长这样：
// {
//   at, kind, role, backend, model, effort,
//   project, task, skill, plugin,   <- 归因维度：哪个项目、哪个任务、哪个 skill
//   elapsedSec, usage{...}, ok, note
// }
// 决策调用另有契约 2 的新字段：invocationId、agent、requestedModel、requestedEffort、
// callMode、status、errorCode（外加 errorMessage、threadId、continuation）。
// 续派判定带 retry.decided 的字段；brief 发布带 projectKey / planRevisionId / refs。
//
// 事件流路径解析顺序：显式文件参数 > CODE_TEAM_EVENTS（二期）> CODE_TEAM_EVENTS_LEDGER（本轮旧别名）> 默认路径。
// 两套隔离变量都留着：老脚本用哪个都能指到同一个文件。
// 测试与验收必须指到临时目录，不然一次随手 record 就把真实运行态污染了。
//
// 用法：
//   node scripts/record-event.mjs record --role overmind --backend codex-cli --model gpt-6.2-astra ...
//   node scripts/record-event.mjs list
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 事件流路径：显式参数 > 二期环境变量 > 本轮旧别名 > 默认路径。 */
export function resolveEventsFile(explicit) {
  const fromArg = String(explicit ?? "").trim();
  if (fromArg) return resolve(fromArg);
  const phase2 = String(process.env.CODE_TEAM_EVENTS || "").trim();
  if (phase2) return resolve(phase2);
  const legacy = String(process.env.CODE_TEAM_EVENTS_LEDGER || "").trim();
  if (legacy) return resolve(legacy);
  return join(ROOT, "config", "events.jsonl");
}

// 决策调用新增的字段。没给就不写，老事件保持逐字节不变。
const EXTRA_FIELDS = [
  "invocationId",
  "agent",
  "requestedModel",
  "requestedEffort",
  "callMode",
  "status",
  "errorCode",
  "errorMessage",
  "threadId",
  "continuation",
];

// retry.decided 事件的字段（与其它事件字段并存，不破坏旧账本形状）。
const RETRY_FIELDS = [
  "failedBatchId", "retryOfAttemptId", "attemptId", "taskId", "childSessionId", "childTurnId",
  "affectedPackageIds", "failureKind", "failureAtMs", "protocolCode", "providerCode",
  "previousConcurrency", "requestedConcurrency", "reservedConcurrency", "attemptMatched",
  "worktreePath", "originalWorktreePath", "baseCommit", "headCommit", "statusEvidence",
  "persistedWork", "remainingWork", "evidenceGaps", "stateStatus",
  "decision", "reason", "progress",
];

// brief 发布事件（kind=brief.published）的字段。
const BRIEF_FIELDS = ["projectKey", "publishedAtMs", "planRevisionId", "refs"];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export function recordEvent(event, file) {
  const target = resolveEventsFile(file);
  mkdirSync(dirname(target), { recursive: true });
  const base = {
    at: event.at ?? new Date().toISOString(),
    kind: event.kind ?? "call",
    role: event.role ?? null,
    backend: event.backend ?? null,
    model: event.model ?? null,
    effort: event.effort ?? null,
    project: event.project ?? null,
    session: event.session ?? null,
    task: event.task ?? null,
    skill: event.skill ?? null,
    plugin: event.plugin ?? null,
    elapsedSec: event.elapsedSec ?? null,
    usage: event.usage ?? null,
    ok: event.ok ?? true,
    note: event.note ?? null,
  };
  for (const key of [...EXTRA_FIELDS, ...RETRY_FIELDS, ...BRIEF_FIELDS]) {
    if (event[key] !== undefined) base[key] = event[key];
  }
  const line = JSON.stringify(base) + "\n";
  writeFileSync(target, line, { encoding: "utf8", flag: "a" });
}

export function readEvents(file) {
  const target = resolveEventsFile(file);
  if (!existsSync(target)) return [];
  return readFileSync(target, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

// 命令行参数名 -> 事件字段名。参数用连字符风格（跟 --elapsed-sec 一致），
// 落到事件里用契约的 camelCase。两种拼法都收，免得调用方按契约名写参数时踩空。
const CLI_FIELDS = {
  kind: "kind",
  "invocation-id": "invocationId",
  invocationId: "invocationId",
  agent: "agent",
  status: "status",
  "call-mode": "callMode",
  callMode: "callMode",
  "error-code": "errorCode",
  errorCode: "errorCode",
  "requested-model": "requestedModel",
  requestedModel: "requestedModel",
  "requested-effort": "requestedEffort",
  requestedEffort: "requestedEffort",
};

// 只有直接运行时才执行 CLI；被 import 时（codex-team.mjs）只提供函数。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
const args = parseArgs(process.argv.slice(2));

if (args._[0] === "list") {
  const events = readEvents();
  console.log(JSON.stringify(events, null, 2));
} else if (args._[0] === "record") {
  let usage = null;
  if (args.usage) {
    try { usage = JSON.parse(args.usage); } catch { usage = null; }
  }
  // 这些字段没给就不写，免得老事件凭空多出一堆 null。
  const extra = {};
  for (const [arg, field] of Object.entries(CLI_FIELDS)) {
    const value = args[arg];
    if (value === undefined || value === true) continue;
    extra[field] = value;
  }
  // --payload 透传续派判定这类附加字段（如 retry.decided 的 failedBatchId 等）。
  let payload = {};
  if (args.payload) {
    try { payload = JSON.parse(args.payload); } catch { payload = {}; }
  }
  recordEvent({
    ...extra,
    role: args.role,
    backend: args.backend,
    model: args.model,
    effort: args.effort,
    project: args.project,
    session: args.session,
    task: args.task,
    skill: args.skill,
    plugin: args.plugin,
    elapsedSec: args["elapsed-sec"] ? Number(args["elapsed-sec"]) : null,
    usage,
    ok: args.ok !== "false",
    note: args.note,
    ...payload,
  });
  console.log("已记录");
} else {
  console.log("用法:");
  console.log("  record-event.mjs record --role <r> --backend <b> --model <m> [--effort e] [--project p] [--session s] [--task t] [--skill s] [--plugin pl] [--elapsed-sec n] [--usage json] [--ok true|false] [--note text]");
  console.log("  record-event.mjs record --kind <call|dispatch> [--invocation-id <id>] [--agent <a>] [--status <s>] [--call-mode <new|resume>] [--error-code <code>] [--requested-model <m>] [--requested-effort <e>] [--payload json]");
  console.log("  record-event.mjs list");
  console.log("事件流路径：CODE_TEAM_EVENTS 优先，其次 CODE_TEAM_EVENTS_LEDGER（默认 config/events.jsonl）");
}
}
