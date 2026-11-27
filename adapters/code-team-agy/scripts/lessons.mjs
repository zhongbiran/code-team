import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBriefDirectory } from '../checks/brief-contract.mjs';
import { getBriefsDir, getStateFilePath, loadTeamConfig, resolvePluginRoot } from './data-paths.mjs';

function loadLessons() {
  const file = getStateFilePath('lessons.json');
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function saveLessons(items) {
  const file = getStateFilePath('lessons.json');
  fs.writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

export function runAllChecks({ briefsDir } = {}) {
  const root = resolvePluginRoot();
  const errors = [];
  const checksRun = [];

  // 1. Validate team.json and verify local skills exist
  checksRun.push('team-config-integrity');
  try {
    const team = loadTeamConfig();
    if (!team.roles || !team.pools || !team.limits) {
      errors.push('config/team.json 缺少 roles / pools / limits 顶层字段');
    }
  } catch (err) {
    errors.push(`config/team.json 解析失败: ${err.message}`);
  }

  // 2. Verify plugin root hooks.json & plugin.json valid JSON
  checksRun.push('plugin-manifests-valid');
  for (const rel of ['plugin.json', 'hooks.json']) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) {
      errors.push(`缺少根目录必需文件: ${rel}`);
    } else {
      try {
        JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (err) {
        errors.push(`${rel} JSON 格式错误: ${err.message}`);
      }
    }
  }

  // 3. Verify all 5 agent definitions exist
  checksRun.push('agents-present');
  for (const agent of ['overmind.md', 'coder.md', 'worker.md', 'explore.md', 'verify.md']) {
    if (!fs.existsSync(path.join(root, 'agents', agent))) {
      errors.push(`缺少角色定义: agents/${agent}`);
    }
  }

  // 4. Verify briefs directory if provided or default
  const targetBriefs = briefsDir || getBriefsDir();
  checksRun.push('brief-contract');
  if (fs.existsSync(targetBriefs)) {
    const entries = fs.readdirSync(targetBriefs, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(targetBriefs, e.name));
    const dirsToCheck = subdirs.length > 0 ? subdirs : [targetBriefs];
    for (const d of dirsToCheck) {
      const res = checkBriefDirectory(d);
      if (!res.ok) errors.push(...res.errors);
    }
  }

  // 5. Verify promoted lessons reference existing checks
  checksRun.push('lessons-ledger');
  for (const item of loadLessons()) {
    if (item.promotedCheck) {
      const checkFile = path.join(root, item.promotedCheck);
      if (!fs.existsSync(checkFile)) {
        errors.push(`台账已升级检查缺失: ${item.promotedCheck} (lesson: ${item.id})`);
      }
    }
  }

  return { ok: errors.length === 0, checksRun, errors };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'check';

  if (cmd === 'check') {
    const res = runAllChecks({ briefsDir: args.briefs });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  if (cmd === 'list') {
    console.log(JSON.stringify(loadLessons(), null, 2));
    process.exit(0);
  }

  if (cmd === 'record') {
    const title = args.title || args._[1];
    if (!title) {
      console.error('Usage: lessons.mjs record --title "<教训描述>" [--category <cat>]');
      process.exit(1);
    }
    const lessons = loadLessons();
    const existing = lessons.find((l) => l.title === title);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = new Date().toISOString();
      existing.readyToPromote = existing.count >= 2 && !existing.promotedCheck;
    } else {
      lessons.push({
        id: `L-${Date.now()}`,
        title,
        category: args.category || 'workflow',
        count: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        readyToPromote: false,
        promotedCheck: null,
      });
    }
    saveLessons(lessons);
    console.log(JSON.stringify(existing || lessons[lessons.length - 1], null, 2));
    process.exit(0);
  }

  console.error('Usage: lessons.mjs <check|list|record> [--briefs <dir>]');
  process.exit(1);
}
