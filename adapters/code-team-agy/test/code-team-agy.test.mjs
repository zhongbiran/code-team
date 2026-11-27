import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkBriefDirectory, validateBriefContent } from '../checks/brief-contract.mjs';
import { checkCommandIsolation } from '../checks/isolation-guard.mjs';
import { publishBrief } from '../scripts/brief-publish.mjs';
import { handleHookPayload } from '../scripts/dispatch-hook.mjs';
import { runAllChecks } from '../scripts/lessons.mjs';
import { appendEvent, summarizeEvents } from '../scripts/record-event.mjs';
import { decideBackend, dispatchWorker } from '../scripts/worker-dispatch.mjs';

function withTempDataDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-team-agy-test-'));
  const prev = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Gate 1: rejects brief missing real compile command or using -ChecksOnly', () => {
  const badStatic = `
## 目标
修复协议解析
## 文件归属
- src/proto.rs
## 验收
运行 verify.ps1 -ChecksOnly 退出码 0
`;
  const r1 = validateBriefContent(badStatic, 'bad-static.md');
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('静态检查')));

  const good = `
## 目标
实现二进制帧解析状态机
## 文件归属
- src/proto.rs
- tests/proto_test.rs
## 验收
\`cargo check --all-targets && cargo clippy --all-targets -- -D warnings && cargo test\` 退出码 0
`;
  const r2 = validateBriefContent(good, 'good.md');
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.ownership, ['src/proto.rs', 'tests/proto_test.rs']);
});

test('Gate 2 & sha256: blocks overlapping file ownership and tampered briefs', () => {
  withTempDataDir((tmp) => {
    const srcA = path.join(tmp, 'src-a.md');
    const srcB = path.join(tmp, 'src-b.md');
    fs.writeFileSync(
      srcA,
      `## 目标\nA\n## 文件归属\n- src/shared.rs\n## 验收\n\`cargo test\` 退出码 0\n`,
      'utf8'
    );
    fs.writeFileSync(
      srcB,
      `## 目标\nB\n## 文件归属\n- src/shared.rs\n## 验收\n\`cargo test\` 退出码 0\n`,
      'utf8'
    );

    const pubA = publishBrief({ sourcePath: srcA, planId: 'plan-1', pkgId: 'pkg-a', skills: ['rust-hardware-protocol'] });
    assert.equal(pubA.ok, true);

    // Overlapping ownership must be rejected
    const pubB = publishBrief({ sourcePath: srcB, planId: 'plan-1', pkgId: 'pkg-b' });
    assert.equal(pubB.ok, false);
    assert.ok(pubB.errors.some((e) => e.includes('文件归属冲突')));

    // Tampering with published brief must fail sha256 check and PreToolUse hook
    fs.appendFileSync(pubA.briefPath, '\n# sneaky edit by main session\n', 'utf8');
    const dirCheck = checkBriefDirectory(path.dirname(pubA.briefPath));
    assert.equal(dirCheck.ok, false);
    assert.ok(dirCheck.errors.some((e) => e.includes('sha256')));

    const hookDecision = handleHookPayload({
      hookEventName: 'PreToolUse',
      toolCall: {
        name: 'invoke_subagent',
        args: { Prompt: `请执行 ${pubA.briefPath}` },
      },
    });
    assert.equal(hookDecision.decision, 'deny');
    assert.match(hookDecision.reason, /sha256/);
  });
});

test('Gate 4: isolation-guard and PreToolUse hook block production DB / destructive commands', () => {
  const res = checkCommandIsolation('pytest tests/ --dsn postgresql://prod.example.com/app');
  assert.equal(res.ok, false);

  const hookRes = handleHookPayload({
    hookEventName: 'PreToolUse',
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'redis-cli FLUSHALL' },
    },
  });
  assert.equal(hookRes.decision, 'deny');
  assert.match(hookRes.reason, /隔离红线/);

  const safeRes = handleHookPayload({
    hookEventName: 'PreToolUse',
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'cargo test --offline' },
    },
  });
  assert.equal(safeRes.decision, 'allow');
});

test('Dual-backend router switches cleanly between MiniMax mcode-exec and Gemini 4 Hydrogen', () => {
  const fakeTeam = {
    pools: { minimax_sub: { cli: process.execPath } },
    roles: {
      worker: {
        primary: { model: 'minimax/MiniMax-M3.1-Flash', effort: 'high', mode: 'lightweight', promptMode: 'coding', maxSteps: 100, timeout: '20m' },
        fallback: { model: 'gemini-4-hydrogen-medium' },
      },
    },
  };

  const r1 = decideBackend({ requested: 'auto', role: 'worker', team: fakeTeam, cooldown: { minimaxRateLimitedUntil: 0 }, now: 1000 });
  assert.equal(r1.backend, 'mcode-exec');
  assert.equal(r1.pool, 'minimax_sub');

  const r2 = decideBackend({ requested: 'auto', role: 'worker', team: fakeTeam, cooldown: { minimaxRateLimitedUntil: 60000 }, now: 1000 });
  assert.equal(r2.backend, 'antigravity-native');
  assert.equal(r2.model, 'gemini-4-hydrogen-medium');

  const r3 = decideBackend({ requested: 'auto', role: 'worker', needsNativeBrowser: true, team: fakeTeam, cooldown: { minimaxRateLimitedUntil: 0 }, now: 1000 });
  assert.equal(r3.backend, 'antigravity-native');
});

test('worker-dispatch dry-run & event summary track skillsUsed and pools', () => {
  withTempDataDir((tmp) => {
    const src = path.join(tmp, 'brief.md');
    fs.writeFileSync(
      src,
      `## 目标\n测试 dry-run\n## 文件归属\n- src/app.ts\n## 验收\n\`npm run build\` 退出码 0\n`,
      'utf8'
    );
    const pub = publishBrief({ sourcePath: src, planId: 'p-dry', pkgId: 'pkg-1', skills: ['frontend-design-and-e2e'] });
    assert.equal(pub.ok, true);

    const dry = dispatchWorker({
      role: 'worker',
      backend: 'auto',
      plan: 'p-dry',
      pkg: 'pkg-1',
      repo: tmp,
      brief: pub.briefPath,
      worktree: true,
      dryRun: true,
      skills: ['frontend-design-and-e2e', 'test-driven-development'],
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.route.backend, 'mcode-exec');

    appendEvent({
      kind: 'dispatch.settled',
      pool: 'minimax_sub',
      status: 'succeeded',
      usage: { totalTokens: 12000, cacheReadTokens: 8000 },
      skillsUsed: ['frontend-design-and-e2e', 'test-driven-development'],
    });
    const summary = summarizeEvents();
    assert.equal(summary.byPool.minimax_sub.totalTokens, 12000);
    assert.equal(summary.skillsUsed['frontend-design-and-e2e'], 2);
  });
});

test('lessons.mjs check passes full plugin self-check', () => {
  withTempDataDir(() => {
    const res = runAllChecks();
    assert.equal(res.ok, true, `Expected checks to pass, got errors: ${res.errors.join('; ')}`);
  });
});
