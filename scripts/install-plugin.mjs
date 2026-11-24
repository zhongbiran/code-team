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

// 运行时数据：安装时一个字节都不碰。
// 这些是这台机器的账本（用量记录、纠正台账、事件流）。
// 旧做法是"先备份、装完再还原"——安装期间并发追加的那一行会被还原覆盖掉。
// 现在改成根本不写：文件原样留下，原本不存在就依然不存在。
const RUNTIME_DATA = new Set([
  "config/events.jsonl",
  "config/usage-ledger.json",
  "config/lessons.json",
]);

// 合并安装：角色选择是这台机器已经做过的决定，安装只能补新默认值，不能覆盖。
const MERGED = new Set(["config/team.json"]);

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// 既有配置赢，仓库默认值只补缺失的键。
function mergeConfig(defaults, existing) {
  if (!isPlainObject(defaults)) return defaults;
  if (!isPlainObject(existing)) return defaults;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(existing)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeConfig(out[k], v) : v;
  }
  return out;
}

// 只装插件组件，docs/ research/ 这些是仓库内容，不是插件运行时。
const PLUGIN_PARTS = new Set([".minimax-plugin", "skills", "checks", "scripts", "references", "config", "hooks", "plugin.json", "icon.png", "icon-dark.png", "LICENSE"]);
const rel = (f) => f.replace(/\\/g, "/");
const all = walk(SRC).filter((f) => PLUGIN_PARTS.has(rel(f).split("/")[0]));
const files = all.filter((f) => !RUNTIME_DATA.has(rel(f)) && !MERGED.has(rel(f)));
const merged = all.filter((f) => MERGED.has(rel(f)));
const runtime = all.filter((f) => RUNTIME_DATA.has(rel(f)));

console.log((dryRun ? "[dry-run] " : "") + SRC + " → " + DEST);
console.log(files.length + " 个文件" + (merged.length ? "，合并 " + merged.length + " 个配置文件" : "") + (runtime.length ? "（跳过 " + runtime.length + " 个运行时数据文件）" : ""));

if (dryRun) {
  for (const f of files) console.log("  " + f);
  for (const f of merged) console.log("  ~ " + f + "（保留既有选择，合并新默认值）");
  for (const f of runtime) console.log("  - " + f + "（保留现有）");
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

for (const f of merged) {
  const from = join(SRC, f);
  const to = join(DEST, f);
  let defaults;
  try {
    defaults = JSON.parse(readFileSync(from, "utf8"));
  } catch (e) {
    console.error("跳过 " + f + "：仓库里的默认配置不是合法 JSON（" + e.message + "）");
    continue;
  }
  let existing = {};
  if (existsSync(to)) {
    try {
      existing = JSON.parse(readFileSync(to, "utf8"));
    } catch (e) {
      // 既有文件坏了就原样留着：它是用户的文件，不用默认值盖掉。
      console.error("跳过 " + f + "：既有配置不是合法 JSON（" + e.message + "），保持原样");
      continue;
    }
  }
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, JSON.stringify(mergeConfig(defaults, existing), null, 2) + "\n", "utf8");
  console.log("已合并 " + f + "（保留既有角色选择，补上新默认值）");
}

// 运行时数据一个字节都不写：留着就是原样。
const kept = [...RUNTIME_DATA].filter((f) => existsSync(join(DEST, f)));
console.log(kept.length ? "运行时数据保持原样：" + kept.join(", ") : "运行时数据：原本不存在，保持不存在");

console.log("");
console.log("接下来：");
console.log("  1. 打开 /plugins，按 Ctrl+R 刷新");
console.log("  2. 找到 Code Team，按空格启用");
console.log("  3. 重开一个会话（skill 才会出现在可用列表里）");
