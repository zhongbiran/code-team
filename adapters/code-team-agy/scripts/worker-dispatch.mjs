import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBriefContent } from '../checks/brief-contract.mjs';
import { getStateFilePath, loadTeamConfig } from './data-paths.mjs';
import { appendEvent } from './record-event.mjs';

function loadCooldownState() {
  const file = getStateFilePath('cooldown.json');
  if (!fs.existsSync(file)) return { minimaxRateLimitedUntil: 0, packages: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { minimaxRateLimitedUntil: 0, packages: {} };
  }
}

function saveCooldownState(state) {
  const file = getStateFilePath('cooldown.json');
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function ensureWorktree(repoDir, planId, pkgId) {
  const safePlan = String(planId || 'adhoc').replace(/[^a-zA-Z0-9._-]/g, '-');
  const safePkg = String(pkgId || 'pkg').replace(/[^a-zA-Z0-9._-]/g, '-');
  const wtRoot = path.join(repoDir, '.worktrees');
  const wtPath = path.join(wtRoot, `${safePlan}-${safePkg}`);
  const branch = `wt/${safePlan}-${safePkg}`;

  fs.mkdirSync(wtRoot, { recursive: true });
  if (fs.existsSync(wtPath)) {
    return { worktreePath: wtPath, branch, reused: true };
  }

  try {
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-B', branch, wtPath, 'HEAD'], {
      stdio: 'pipe',
    });
    return { worktreePath: wtPath, branch, reused: false };
  } catch (err) {
    throw new Error(`创建 git worktree 失败: ${err.stderr?.toString() || err.message}`);
  }
}

export function decideBackend({ requested = 'auto', role = 'worker', needsNativeBrowser = false, team = loadTeamConfig(), cooldown = loadCooldownState(), now = Date.now() }) {
  const mcodeCli = team.pools?.minimax_sub?.cli || '/Users/biranzhong/.minimax-code/bin/mcode';
  const mcodeExists = fs.existsSync(mcodeCli);
  const roleCfg = team.roles?.[role] || team.roles.worker;
  const fallbackModel = roleCfg?.fallback?.model || 'gemini-4-hydrogen-medium';

  if (requested === 'hydrogen') {
    return {
      backend: 'antigravity-native',
      pool: 'gemini_pro',
      model: fallbackModel,
      reason: '显式指定使用 Antigravity 原生 Hydrogen 后端',
    };
  }

  if (needsNativeBrowser) {
    return {
      backend: 'antigravity-native',
      pool: 'gemini_pro',
      model: fallbackModel,
      reason: '任务需要 Antigravity 原生 browser/IDE 工具，自动路由至 Gemini 4 Hydrogen',
    };
  }

  if (!mcodeExists) {
    return {
      backend: 'antigravity-native',
      pool: 'gemini_pro',
      model: fallbackModel,
      reason: `未检测到 mcode CLI (${mcodeCli})，自动降级至 Gemini 4 Hydrogen`,
    };
  }

  if (requested === 'auto' && cooldown.minimaxRateLimitedUntil > now) {
    const remainSec = Math.ceil((cooldown.minimaxRateLimitedUntil - now) / 1000);
    return {
      backend: 'antigravity-native',
      pool: 'gemini_pro',
      model: fallbackModel,
      reason: `MiniMax 处于撞墙冷却期（剩余 ${remainSec}s），自动分流至 Gemini 4 Hydrogen`,
    };
  }

  return {
    backend: 'mcode-exec',
    pool: 'minimax_sub',
    cli: mcodeCli,
    model: roleCfg?.primary?.model || 'minimax/MiniMax-M3.1-Flash',
    effort: roleCfg?.primary?.effort || 'high',
    mode: roleCfg?.primary?.mode || 'lightweight',
    promptMode: roleCfg?.primary?.promptMode || 'coding',
    maxSteps: roleCfg?.primary?.maxSteps || (role === 'explore' ? 20 : 100),
    timeout: roleCfg?.primary?.timeout || (role === 'explore' ? '5m' : '20m'),
    reason: '路由至 MiniMax 独立订阅并发池（不消耗 Pro 5h 配额）',
  };
}

function parseJsonTail(stdoutText) {
  const lines = stdoutText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{') && lines[i].endsWith('}')) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // continue scanning
      }
    }
  }
  return null;
}

export function dispatchWorker(opts) {
  const team = loadTeamConfig();
  const limits = team.limits || {};
  const cooldown = loadCooldownState();
  const role = opts.role || 'worker';
  const planId = opts.plan || 'adhoc';
  const pkgId = opts.pkg || 'pkg-1';
  const pkgKey = `${planId}:${pkgId}`;
  const skillsUsed = Array.isArray(opts.skills) ? opts.skills : [];

  // 1. Validate brief if provided (Gate 1 & sha256 integrity)
  let promptText = opts.prompt || '';
  let briefMeta = null;
  if (opts.brief) {
    if (!fs.existsSync(opts.brief)) {
      return { ok: false, error: `brief 文件不存在: ${opts.brief}` };
    }
    const briefBody = fs.readFileSync(opts.brief, 'utf8');
    const check = validateBriefContent(briefBody, path.basename(opts.brief));
    if (!check.ok) {
      return { ok: false, gateBlocked: true, errors: check.errors };
    }
    const metaPath = opts.brief.replace(/\.md$/, '.meta.json');
    if (fs.existsSync(metaPath)) {
      briefMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (briefMeta.sha256 && briefMeta.sha256 !== check.sha256) {
        return {
          ok: false,
          gateBlocked: true,
          errors: ['brief sha256 与签名元数据不匹配（疑似被主会话篡改），拒绝派工'],
        };
      }
    }
    promptText = [
      `请严格按照以下已签名的 Overmind Brief 执行（只改白名单内文件，同一错误连续 3 次未收敛立即停工上报）：`,
      '',
      briefBody,
    ].join('\n');
  }

  if (!promptText.trim()) {
    return { ok: false, error: '必须提供 --brief <path> 或 --prompt "<text>"' };
  }

  // 2. Enforce retry cooldown guard (Hard Rule 3)
  const prevPkg = cooldown.packages?.[pkgKey];
  const cooldownMs = (limits.retryCooldownSeconds || 120) * 1000;
  if (prevPkg && prevPkg.failedAt && Date.now() - prevPkg.failedAt < cooldownMs && !opts.retryAck) {
    const remainSec = Math.ceil((cooldownMs - (Date.now() - prevPkg.failedAt)) / 1000);
    return {
      ok: false,
      gateBlocked: true,
      errors: [
        `硬规则 3 拦截：包 ${pkgKey} 在 ${remainSec}s 冷却期内禁止同规模重派。请先降并发、运行 git status 核查落盘深度，并在续派说明补齐已落盘进度后传 --retry-ack。`,
      ],
    };
  }

  // 3. Decide backend
  const route = decideBackend({
    requested: opts.backend || 'auto',
    role,
    needsNativeBrowser: Boolean(opts.needsNativeBrowser),
    team,
    cooldown,
  });

  if (route.backend !== 'mcode-exec') {
    const decisionPayload = {
      ok: true,
      action: 'delegate_to_antigravity_native',
      role,
      planId,
      pkgId,
      pool: route.pool,
      recommendedModel: route.model,
      reason: route.reason,
      skillsUsed,
    };
    appendEvent({
      kind: 'dispatch.routed_native',
      role,
      planId,
      pkgId,
      pool: route.pool,
      backend: 'antigravity-native',
      model: route.model,
      status: 'routed',
      skillsUsed,
      reason: route.reason,
    });
    return decisionPayload;
  }

  // 4. Prepare working directory / isolated worktree
  let runCwd = opts.cwd || opts.repo || process.cwd();
  let worktreeInfo = null;
  if (opts.worktree && role === 'worker') {
    if (!opts.repo) {
      return { ok: false, error: '使用 --worktree 时必须指定 --repo <git仓库路径>' };
    }
    if (!opts.dryRun) {
      worktreeInfo = ensureWorktree(opts.repo, planId, pkgId);
      runCwd = worktreeInfo.worktreePath;
    } else {
      worktreeInfo = {
        worktreePath: path.join(opts.repo, '.worktrees', `${planId}-${pkgId}`),
        branch: `wt/${planId}-${pkgId}`,
        dryRun: true,
      };
      runCwd = worktreeInfo.worktreePath;
    }
  }

  const maxSteps = Number(opts.maxSteps || route.maxSteps);
  const timeout = String(opts.timeout || route.timeout);
  const mode = String(opts.mode || route.mode);

  const cliArgs = [
    'exec',
    '--cwd',
    runCwd,
    '--model',
    route.model,
    '--effort',
    route.effort,
    '--mode',
    mode,
    '--prompt-mode',
    route.promptMode,
    '--permission',
    role === 'explore' ? 'off' : opts.permission || 'smart',
    '--max-steps',
    String(maxSteps),
    '--timeout',
    timeout,
    '--output-format',
    'json',
    promptText,
  ];

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      route,
      worktree: worktreeInfo,
      command: route.cli,
      args: cliArgs.slice(0, -1).concat(['<prompt>']),
      limits: {
        maxSteps,
        timeout,
        softContextTokens: limits.workerSoftContextTokens,
        hardContextTokens: limits.workerHardContextTokens,
      },
      skillsUsed,
    };
  }

  appendEvent({
    kind: 'dispatch.started',
    role,
    planId,
    pkgId,
    pool: route.pool,
    backend: 'mcode-exec',
    model: route.model,
    status: 'started',
    worktree: worktreeInfo?.worktreePath || null,
    skillsUsed,
  });

  const proc = spawnSync(route.cli, cliArgs, {
    cwd: runCwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  const parsed = parseJsonTail(proc.stdout || '');
  const rawStatus = parsed?.status || (proc.status === 0 ? 'succeeded' : 'failed');
  const combinedErr = `${proc.stderr || ''} ${parsed?.error || ''}`;
  const isRateLimited =
    /429|rate.?limit|quota|limit exceeded/i.test(combinedErr) || rawStatus === 'timeout';

  const usage = parsed?.usage || null;
  const warnings = [];
  if (usage?.inputTokens && limits.workerSoftContextTokens && usage.inputTokens > limits.workerSoftContextTokens) {
    warnings.push(
      `软上下文警戒：本包 inputTokens=${usage.inputTokens} 已超过 ${limits.workerSoftContextTokens}，后续禁止继续在同会话追加，请拆新包`
    );
  }
  if (usage?.totalTokens && limits.workerMaxTotalTokens && usage.totalTokens > limits.workerMaxTotalTokens) {
    warnings.push(
      `成本超标警告：本包 totalTokens=${usage.totalTokens} 已超过 ${limits.workerMaxTotalTokens}，结构偏大需复盘拆包`
    );
  }

  if (rawStatus !== 'succeeded') {
    cooldown.packages = cooldown.packages || {};
    cooldown.packages[pkgKey] = {
      failedAt: Date.now(),
      status: rawStatus,
    };
    if (isRateLimited) {
      cooldown.minimaxRateLimitedUntil = Date.now() + cooldownMs;
    }
    saveCooldownState(cooldown);
  }

  const settled = appendEvent({
    kind: 'dispatch.settled',
    role,
    planId,
    pkgId,
    pool: route.pool,
    backend: 'mcode-exec',
    model: parsed?.model?.modelId || route.model,
    sessionId: parsed?.sessionId || null,
    status: isRateLimited && rawStatus !== 'succeeded' ? 'rate_limited' : rawStatus,
    exitCode: proc.status,
    durationMs: parsed?.durationMs || null,
    usage,
    usageIncomplete: parsed?.usageIncomplete ?? !usage,
    worktree: worktreeInfo?.worktreePath || null,
    skillsUsed,
    warnings,
  });

  return {
    ok: rawStatus === 'succeeded',
    status: settled.status,
    sessionId: parsed?.sessionId || null,
    output: parsed?.output ?? (proc.stdout || '').trim(),
    stderr: proc.status === 0 ? '' : (proc.stderr || '').trim(),
    usage,
    durationMs: parsed?.durationMs || null,
    worktree: worktreeInfo,
    warnings,
    fallbackRecommended:
      isRateLimited && rawStatus !== 'succeeded'
        ? {
            pool: 'gemini_pro',
            model: team.roles?.[role]?.fallback?.model || 'gemini-4-hydrogen-medium',
            reason: 'MiniMax 触发限流或超时，建议对剩余子包混用 Gemini 4 Hydrogen',
          }
        : null,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const k = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const skills = args.skills
    ? String(args.skills)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const res = dispatchWorker({
    role: args.role || 'worker',
    backend: args.backend || 'auto',
    plan: args.plan,
    pkg: args.pkg,
    repo: args.repo,
    cwd: args.cwd,
    brief: args.brief,
    prompt: args.prompt,
    worktree: Boolean(args.worktree),
    needsNativeBrowser: Boolean(args.needsNativeBrowser),
    maxSteps: args.maxSteps,
    timeout: args.timeout,
    mode: args.mode,
    permission: args.permission,
    retryAck: Boolean(args.retryAck),
    dryRun: Boolean(args.dryRun),
    skills,
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
