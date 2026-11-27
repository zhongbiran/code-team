import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const COMPILE_PATTERNS = [
  /\bcargo\s+(check|build|test|clippy)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|typecheck|tsc|test|check)\b/i,
  /\btsc\b/i,
  /\bdotnet\s+(build|test)\b/i,
  /\bgo\s+(build|test|vet)\b/i,
  /\b(cmake|make|ninja|gcc|clang|rustc|mvn|gradle|pytest|vitest|jest|node\s+--test)\b/i,
  /\bplaywright\s+test\b/i,
];

const STATIC_ONLY_DISALLOWED = [
  /-ChecksOnly\b/i,
  /--lint-only\b/i,
];

export function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function extractSection(markdown, headingRegex) {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i]) && headingRegex.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  const collected = [];
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
}

export function extractOwnershipFiles(markdown) {
  const section = extractSection(markdown, /(文件归属|Ownership)/i);
  if (!section) return [];
  const files = [];
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('<!--')) continue;
    const cleaned = line
      .replace(/^[-*+]\s+/, '')
      .replace(/^`([^`]+)`.*$/, '$1')
      .split(/\s+[—–-]\s+/)[0]
      .trim()
      .replace(/^['"`]|['"`]$/g, '');
    if (cleaned && !cleaned.startsWith('#')) {
      files.push(cleaned.replace(/\\/g, '/').replace(/^\.\//, ''));
    }
  }
  return [...new Set(files)];
}

export function validateBriefContent(markdown, label = 'brief') {
  const errors = [];
  const warnings = [];

  const goal = extractSection(markdown, /(目标|Goal)/i);
  if (!goal) errors.push(`${label}: 缺少「目标 / Goal」段`);

  const ownership = extractOwnershipFiles(markdown);
  if (ownership.length === 0) {
    errors.push(`${label}: 缺少「文件归属 / Ownership」白名单`);
  }

  const done = extractSection(markdown, /(验收|Done)/i);
  if (!done) {
    errors.push(`${label}: 缺少「验收 / Done」段`);
  } else {
    for (const bad of STATIC_ONLY_DISALLOWED) {
      if (bad.test(done)) {
        errors.push(`${label}: 验收段包含纯静态检查标记 (${bad})，不能替代真实编译闸`);
      }
    }
    const hasCompile = COMPILE_PATTERNS.some((re) => re.test(done));
    if (!hasCompile) {
      errors.push(`${label}: 验收段未检测到真实编译/构建/测试命令（闸 1 拒绝）`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ownership,
    sha256: sha256Text(markdown),
  };
}

export function checkBriefDirectory(dirPath) {
  const errors = [];
  if (!fs.existsSync(dirPath)) {
    return { ok: true, checked: 0, errors: [] };
  }
  const files = fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith('.md') && !f.endsWith('.bak'))
    .map((f) => path.join(dirPath, f));

  const ownershipMap = new Map();
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const name = path.basename(filePath);
    const res = validateBriefContent(content, name);
    errors.push(...res.errors);

    // Check sidecar .meta.json sha256 integrity if present
    const metaPath = filePath.replace(/\.md$/, '.meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.sha256 && meta.sha256 !== res.sha256) {
          errors.push(`${name}: sha256 校验失败（brief 疑似被主会话篡改！）`);
        }
      } catch (err) {
        errors.push(`${name}: meta.json 损坏 (${err.message})`);
      }
    }

    for (const owned of res.ownership) {
      if (ownershipMap.has(owned)) {
        errors.push(
          `闸 2 文件归属冲突: "${owned}" 同时出现在 ${ownershipMap.get(owned)} 与 ${name}`
        );
      } else {
        ownershipMap.set(owned, name);
      }
    }
  }

  return { ok: errors.length === 0, checked: files.length, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no brief target specified' }));
    process.exit(0);
  }
  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!stat) {
    console.error(`brief-contract: 路径不存在 ${target}`);
    process.exit(1);
  }
  const result = stat.isDirectory()
    ? checkBriefDirectory(target)
    : validateBriefContent(fs.readFileSync(target, 'utf8'), path.basename(target));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
