#!/usr/bin/env node
// 从 Codex 会话记录回填事件流。
//
// 为什么需要：Codex 把每次调用的真实 usage 和耗时写在自己的会话日志里
// （~/.codex/sessions/**.jsonl）。事件流丢了、或想统计历史调用时，从这里重建。
//
// 用法：node scripts/rebuild-from-codex.mjs [--days 7]
import { readdirSync, statSync, readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_SESSIONS = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
const EVENTS = join(ROOT, "config", "events.jsonl");

const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 7;
const since = Date.now() - DAYS * 24 * 60 * 60 * 1000;

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const files = walk(CODEX_SESSIONS).filter((f) => statSync(f).mtimeMs >= since);
console.log("扫到 " + files.length + " 个会话文件（最近 " + DAYS + " 天）");

// 从会话文件名或模型名推断这次调用是哪个角色。
// codex 会话记录里没有角色字段，只能按线索猜——猜不出就标"(未记录)"，
// 由控制台的人工归因补上，不硬猜。
function inferRole(model, file) {
  const name = String(file).toLowerCase();
  if (name.includes("overmind")) return "overmind";
  if (name.includes("coder")) return "coder";
  return null;
}

// 统一成 UTC ISO 字符串。codex 的 timestamp 带 Z，但 p.started_at 转出来可能是本地格式。
function normalizeIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

const events = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  let usage = null;
  let startedAt = null;
  let durationMs = null;
  let model = null;
  let effort = null;

  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "session_meta" || rec.type === "turn_context") {
      const p = rec.payload ?? {};
      model = p.model ?? model;
      effort = p.effort ?? p.reasoning_effort ?? effort;
    }
    if (rec.type === "token_usage_record") {
      const u = rec.payload?.usage;
      if (u) usage = u;
    }
    if (rec.type === "event_msg") {
      const p = rec.payload ?? {};
      if (p.type === "task_started" || p.type === "task_started_event") startedAt = p.timestamp ?? startedAt;
      if (p.type === "task_complete") {
        durationMs = p.duration_ms ?? durationMs;
        if (p.started_at) startedAt = new Date(p.started_at * 1000).toISOString();
      }
    }
    // 兜底：会话记录里最早的时间戳一定是 UTC ISO。
    // 少了它，回填出来的时间会被当成本地时间，5 小时窗口就全错位了。
    if (!startedAt && rec.timestamp) startedAt = rec.timestamp;
  }

  if (!usage) continue;
  const threadId = (() => {
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const id = rec.payload?.thread_id ?? rec.payload?.session_id;
        if (id) return id;
      } catch {}
    }
    return null;
  })();

  events.push({
    at: normalizeIso(startedAt) ?? new Date(statSync(file).mtimeMs).toISOString(),
    kind: "codex-call",
    role: inferRole(model, file),
    backend: "codex-cli",
    model: model ?? "(未知)",
    effort: effort ?? null,
    project: null,
    session: threadId,
    task: null,
    skill: "code-team",
    plugin: "code-team",
    elapsedSec: durationMs != null ? Math.round((durationMs / 1000) * 10) / 10 : null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      cached_input_tokens: usage.cached_input_tokens ?? 0,
      cache_write_input_tokens: usage.cache_write_input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      reasoning_output_tokens: usage.reasoning_output_tokens ?? 0,
    },
    ok: true,
    note: threadId ? "thread:" + threadId : null,
  });
}

events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
console.log("重建出 " + events.length + " 条调用事件");

if (process.argv.includes("--dry-run")) {
  for (const e of events.slice(0, 5)) console.log("  " + e.at + "  " + e.model + "  " + e.elapsedSec + "s");
  process.exit(0);
}

mkdirSync(dirname(EVENTS), { recursive: true });
writeFileSync(EVENTS, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
console.log("已写入 " + EVENTS);
