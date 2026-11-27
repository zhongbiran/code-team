import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBriefDirectory, validateBriefContent } from '../checks/brief-contract.mjs';
import { getBriefsDir } from './data-paths.mjs';
import { appendEvent } from './record-event.mjs';

export function publishBrief({ sourcePath, planId, pkgId, skills = [] }) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`brief 源文件不存在: ${sourcePath}`);
  }
  if (!planId || !pkgId) {
    throw new Error('必须提供 --plan 与 --pkg');
  }

  const content = fs.readFileSync(sourcePath, 'utf8');
  const validation = validateBriefContent(content, `${planId}/${pkgId}`);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  const planDir = path.join(getBriefsDir(), String(planId));
  fs.mkdirSync(planDir, { recursive: true });

  const destMd = path.join(planDir, `${pkgId}.md`);
  const destMeta = path.join(planDir, `${pkgId}.meta.json`);

  // Temporarily check against existing sibling briefs in the same plan
  const tempPath = destMd;
  const existed = fs.existsSync(tempPath);
  const previousContent = existed ? fs.readFileSync(tempPath, 'utf8') : null;
  fs.writeFileSync(tempPath, content, 'utf8');

  const dirCheck = checkBriefDirectory(planDir);
  if (!dirCheck.ok) {
    if (existed && previousContent !== null) {
      fs.writeFileSync(tempPath, previousContent, 'utf8');
    } else {
      fs.rmSync(tempPath, { force: true });
    }
    return { ok: false, errors: dirCheck.errors };
  }

  const meta = {
    planId,
    pkgId,
    sha256: validation.sha256,
    bytes: Buffer.byteLength(content, 'utf8'),
    ownership: validation.ownership,
    skills,
    publishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(destMeta, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  appendEvent({
    kind: 'brief.published',
    role: 'overmind',
    planId,
    pkgId,
    status: 'succeeded',
    sha256: meta.sha256,
    ownership: meta.ownership,
    skillsUsed: skills,
  });

  return { ok: true, briefPath: destMd, metaPath: destMeta, meta };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const skills = args.skills
      ? String(args.skills)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const res = publishBrief({
      sourcePath: args.brief,
      planId: args.plan,
      pkgId: args.pkg,
      skills,
    });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}
