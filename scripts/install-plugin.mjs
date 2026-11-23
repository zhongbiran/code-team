#!/usr/bin/env node
// 把 plugin/ 复制到本机 MiniMax Code 插件目录。
//
// 用法：node scripts/install-plugin.mjs [--dry-run]
//
// 装完需要：打开 /plugins → Ctrl+R 刷新 → 启用 Code Team → 重开会话。
import { readdirSync, statSync, copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 插件根就是仓库根：plugin.json / skills/ / checks/ / scripts/ / references/ / config/ 都在根。
const SRC = ROOT;
const HOME = process.env.USERPROFILE || process.env.HOME;
const DEST = join(HOME, ".minimax", "plugins", "code-team");
const dryRun = process.argv.includes("--dry-run");

if (!existsSync(SRC)) {
  console.error("找不到 plugin/ 目录：" + SRC);
  process.exit(1);
}

// 运行时数据：安装时不能覆盖——那是用户的用量记录、纠正台账。
const RUNTIME_DATA = new Set([
  "config/events.jsonl",
  "config/usage-ledger.json",
  "config/lessons.json",
]);

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

// 只装插件组件，docs/ research/ miniapps/ 这些是仓库内容，不是插件运行时。
const PLUGIN_PARTS = new Set([".minimax-plugin", "skills", "checks", "scripts", "references", "config", "plugin.json", "icon.png", "icon-dark.png", "LICENSE"]);
const all = walk(SRC).filter((f) => PLUGIN_PARTS.has(f.replace(/\\/g, "/").split("/")[0]));
const files = all.filter((f) => !RUNTIME_DATA.has(f.replace(/\\/g, "/")));
const skipped = all.filter((f) => RUNTIME_DATA.has(f.replace(/\\/g, "/")));

console.log((dryRun ? "[dry-run] " : "") + SRC + " → " + DEST);
console.log(files.length + " 个文件" + (skipped.length ? "（跳过 " + skipped.length + " 个运行时数据文件）" : ""));

if (dryRun) {
  for (const f of files) console.log("  " + f);
  for (const f of skipped) console.log("  - " + f + "（保留现有）");
  process.exit(0);
}

mkdirSync(DEST, { recursive: true });

// 运行时数据先备份再还原：
// 源目录（git 仓库）不含这些文件，但目标目录可能有——那是用户的数据，不能因为装一次插件就没了。
const saved = new Map();
for (const f of skipped) {
  const from = join(DEST, f);
  if (existsSync(from)) saved.set(f, readFileSync(from));
}

let copied = 0;
for (const f of files) {
  const to = join(DEST, f);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(SRC, f), to);
  copied++;
}
console.log("已复制 " + copied + " 个文件");

if (saved.size) {
  for (const [f, content] of saved) {
    const to = join(DEST, f);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, content);
  }
  console.log("已还原运行时数据：" + [...saved.keys()].join(", "));
} else if (skipped.length) {
  console.log("运行时数据（源目录没有，保持现有）：" + skipped.join(", "));
}
console.log("");
console.log("接下来：");
console.log("  1. 打开 /plugins，按 Ctrl+R 刷新");
console.log("  2. 找到 Code Team，按空格启用");
console.log("  3. 重开一个会话（skill 才会出现在可用列表里）");
