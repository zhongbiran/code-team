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
//
// 用法：
//   node scripts/record-event.mjs --role overmind --backend codex-cli --model gpt-6.2-astra ...
//   node scripts/record-event.mjs --list
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(ROOT, "config", "events.jsonl");

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

export function recordEvent(event) {
  mkdirSync(dirname(LEDGER), { recursive: true });
  const line = JSON.stringify({
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
  }) + "\n";
  writeFileSync(LEDGER, line, { encoding: "utf8", flag: "a" });
}

export function readEvents() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

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
  recordEvent({
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
  });
  console.log("已记录");
} else {
  console.log("用法:");
  console.log("  record-event.mjs record --role <r> --backend <b> --model <m> [--effort e] [--project p] [--session s] [--task t] [--skill s] [--plugin pl] [--elapsed-sec n] [--usage json] [--ok true|false] [--note text]");
  console.log("  record-event.mjs list");
}
}
