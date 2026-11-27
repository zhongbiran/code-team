import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBriefContent } from '../checks/brief-contract.mjs';
import { checkCommandIsolation } from '../checks/isolation-guard.mjs';
import { loadTeamConfig } from './data-paths.mjs';
import { appendEvent } from './record-event.mjs';

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function checkReferencedBriefIntegrity(text) {
  if (!text || typeof text !== 'string') return { ok: true };
  // Detect published brief paths ending in .md inside /briefs/
  const match = text.match(/(\/[^\s"'`]+?\/briefs\/[^\s"'`]+?\.md)\b/);
  if (!match) return { ok: true };
  const briefPath = match[1];
  if (!fs.existsSync(briefPath)) return { ok: true };

  const content = fs.readFileSync(briefPath, 'utf8');
  const check = validateBriefContent(content, path.basename(briefPath));
  if (!check.ok) {
    return { ok: false, reason: `Brief 硬闸门拒绝 (${briefPath}): ${check.errors.join('；')}` };
  }
  const metaPath = briefPath.replace(/\.md$/, '.meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.sha256 && meta.sha256 !== check.sha256) {
        return {
          ok: false,
          reason: `Brief sha256 校验失败 (${path.basename(briefPath)})：落盘后疑似被篡改，拒绝派工`,
        };
      }
    } catch (err) {
      return { ok: false, reason: `Brief 元数据损坏: ${err.message}` };
    }
  }
  return { ok: true };
}

export function handleHookPayload(payload) {
  if (process.env.CODE_TEAM_GATE === 'off') {
    return {};
  }

  const event = payload?.hookEventName || '';

  if (event === 'SessionStart') {
    return {};
  }

  if (event === 'PreToolUse') {
    const toolName = payload?.toolCall?.name || '';
    const args = payload?.toolCall?.args || {};

    if (toolName === 'run_command') {
      const cmd = args.CommandLine || args.command || '';
      const iso = checkCommandIsolation(cmd);
      if (!iso.ok) {
        const reason = iso.violations.map((v) => v.reason).join('；');
        appendEvent({
          kind: 'gate.blocked',
          gate: 'isolation',
          tool: toolName,
          status: 'denied',
          reason,
        });
        return { decision: 'deny', reason };
      }

      // If dispatching via worker-dispatch.mjs with --brief, pre-verify brief integrity
      if (/worker-dispatch\.mjs/.test(cmd)) {
        const briefRes = checkReferencedBriefIntegrity(cmd);
        if (!briefRes.ok) {
          appendEvent({
            kind: 'gate.blocked',
            gate: 'brief-contract',
            tool: toolName,
            status: 'denied',
            reason: briefRes.reason,
          });
          return { decision: 'deny', reason: briefRes.reason };
        }
      }
    }

    if (toolName === 'invoke_subagent' || toolName === 'swarm') {
      const prompt = args.Prompt || args.brief || '';
      const briefRes = checkReferencedBriefIntegrity(prompt);
      if (!briefRes.ok) {
        appendEvent({
          kind: 'gate.blocked',
          gate: 'brief-contract',
          tool: toolName,
          status: 'denied',
          reason: briefRes.reason,
        });
        return { decision: 'deny', reason: briefRes.reason };
      }
    }

    return { decision: 'allow' };
  }

  if (event === 'PostToolUse') {
    // Lightweight telemetry check on transcript size (never blocks)
    try {
      const transcriptPath = payload?.transcriptPath;
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        const stat = fs.statSync(transcriptPath);
        const team = loadTeamConfig();
        const warnSteps = team.limits?.workerHardToolCalls || 180;
        if (payload?.stepIdx && Number(payload.stepIdx) === warnSteps) {
          appendEvent({
            kind: 'telemetry.step_threshold',
            conversationId: payload.conversationId || null,
            stepIdx: payload.stepIdx,
            transcriptBytes: stat.size,
            status: 'warning',
          });
        }
      }
    } catch {
      // Never crash host loop on telemetry read
    }
    return {};
  }

  if (event === 'Stop') {
    return {};
  }

  return {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = readStdinSync().trim();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }
  const output = handleHookPayload(payload);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(0);
}
