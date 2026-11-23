#!/usr/bin/env node
// 把 plugin/ 复制到本机 MiniMax Code 插件目录。
//
// 用法：node scripts/install-plugin.mjs [--dry-run]
//
// 装完需要：打开 /plugins → Ctrl+R 刷新 → 启用 Code Team → 重开会话。
import { readdirSync, statSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "plugin");
const HOME = process.env.USERPROFILE || process.env.HOME;
const DEST = join(HOME, ".minimax", "plugins", "code-team");
const dryRun = process.argv.includes("--dry-run");

if (!existsSync(SRC)) {
  console.error("找不到 plugin/ 目录：" + SRC);
  process.exit(1);
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

const files = walk(SRC);
console.log((dryRun ? "[dry-run] " : "") + SRC + " → " + DEST);
console.log(files.length + " 个文件");

if (dryRun) {
  for (const f of files) console.log("  " + f);
  process.exit(0);
}

mkdirSync(DEST, { recursive: true });
let copied = 0;
for (const f of files) {
  const to = join(DEST, f);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(SRC, f), to);
  copied++;
}
console.log("已复制 " + copied + " 个文件");
console.log("");
console.log("接下来：");
console.log("  1. 打开 /plugins，按 Ctrl+R 刷新");
console.log("  2. 找到 Code Team，按空格启用");
console.log("  3. 重开一个会话（skill 才会出现在可用列表里）");
