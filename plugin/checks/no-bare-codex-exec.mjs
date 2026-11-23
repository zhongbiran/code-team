#!/usr/bin/env node
// 检查：Codex 调用必须走 scripts/codex-team.mjs，不能裸跑 codex exec。
//
// 原因：本机 WebSocket 到 ChatGPT 不通，裸跑会先空转 5 次重连（约 120 秒）才降级 HTTPS。
// 这条检查防的是"绕过封装直接调 codex"这个具体失误。
//
// 来源：2026-11-23 建插件时实测发现（裸跑 122s vs 走封装 12s）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["scripts", "skills"];

function walk(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (/\.(mjs|js|ps1|md)$/.test(name)) files.push(p);
  }
  return files;
}

const violations = [];
for (const d of SCAN_DIRS) {
  for (const file of walk(join(ROOT, d))) {
    // 这个检查脚本自己、以及封装脚本本身，是允许直接出现 codex exec 的地方。
    if (file.endsWith("codex-team.mjs")) continue;
    if (file.endsWith("no-bare-codex-exec.mjs")) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    // 判定规则要够窄：真正的执行点一定把 codex 当命令或可执行文件调用，
    // 而说明文字里的 "codex exec" 前后是空格与反引号，不是引号或括号。
    // 这样 Markdown 里的示例不会被误报，脚本里的真调用一定会被抓到。
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      const isExecution =
        /spawnSync\(\s*["']codex["']/.test(code) ||
        /execFileSync\(\s*["']codex["']/.test(code) ||
        /\bcodex\s+exec\s+(-m|--sandbox|-C|--json|--output-schema)/.test(code) ||
        /["']codex["']\s*,\s*\[\s*["']exec["']/.test(code);
      if (!isExecution) return;
      // 走封装的调用不算违规。
      if (/codex-team|lessons\.mjs/.test(code)) return;
      violations.push(`${file.replace(ROOT + "\\", "")}:${i + 1}: 裸跑 codex —— 请改用 scripts/codex-team.mjs`);
    });
  }
}

if (violations.length) {
  console.error("发现绕过封装的 Codex 调用：");
  for (const v of violations) console.error("  " + v);
  console.error("\n修复：改用 node scripts/codex-team.mjs plan --prompt-file <file> --role <overmind|coder>");
  process.exit(1);
}
console.log("OK: 没有绕过封装的 Codex 调用");
