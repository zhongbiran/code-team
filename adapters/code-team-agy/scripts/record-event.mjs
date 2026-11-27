import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getEventsFilePath } from './data-paths.mjs';

export function appendEvent(event) {
  const eventsFile = getEventsFilePath();
  const payload = {
    ts: new Date().toISOString(),
    host: 'antigravity',
    ...event,
  };
  fs.appendFileSync(eventsFile, `${JSON.stringify(payload)}\n`, 'utf8');
  return payload;
}

export function readEvents() {
  const eventsFile = getEventsFilePath();
  if (!fs.existsSync(eventsFile)) return [];
  return fs
    .readFileSync(eventsFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function summarizeEvents(events = readEvents()) {
  const byPool = {};
  const skillsCounter = {};
  let totalTokens = 0;
  let totalCacheRead = 0;

  for (const ev of events) {
    const pool = ev.pool || 'unknown';
    if (!byPool[pool]) {
      byPool[pool] = { count: 0, succeeded: 0, failed: 0, totalTokens: 0, cacheReadTokens: 0 };
    }
    byPool[pool].count += 1;
    if (ev.status === 'succeeded' || ev.status === 'ok') byPool[pool].succeeded += 1;
    if (ev.status === 'failed' || ev.status === 'timeout' || ev.status === 'rate_limited') {
      byPool[pool].failed += 1;
    }
    const t = Number(ev.usage?.totalTokens || 0);
    const c = Number(ev.usage?.cacheReadTokens || 0);
    byPool[pool].totalTokens += t;
    byPool[pool].cacheReadTokens += c;
    totalTokens += t;
    totalCacheRead += c;

    if (Array.isArray(ev.skillsUsed)) {
      for (const s of ev.skillsUsed) {
        if (!s) continue;
        skillsCounter[s] = (skillsCounter[s] || 0) + 1;
      }
    }
  }

  return {
    totalEvents: events.length,
    totalTokens,
    totalCacheRead,
    byPool,
    skillsUsed: skillsCounter,
  };
}

function parseCliArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseCliArgs(process.argv.slice(2));
  const cmd = args._[0] || 'summary';
  if (cmd === 'summary') {
    console.log(JSON.stringify(summarizeEvents(), null, 2));
    process.exit(0);
  }
  if (cmd === 'record') {
    const skillsUsed = args.skills
      ? String(args.skills)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const ev = appendEvent({
      kind: args.kind || 'dispatch',
      role: args.role || null,
      pool: args.pool || null,
      backend: args.backend || null,
      model: args.model || null,
      planId: args.plan || null,
      pkgId: args.pkg || null,
      status: args.status || 'recorded',
      skillsUsed,
      note: args.note || null,
    });
    console.log(JSON.stringify(ev, null, 2));
    process.exit(0);
  }
  console.error(`Usage: record-event.mjs <summary|record> [--kind ...] [--role ...] [--pool ...] [--skills a,b]`);
  process.exit(1);
}
