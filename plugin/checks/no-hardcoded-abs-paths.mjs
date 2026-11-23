#!/usr/bin/env node
// 检查：脚本里不要硬编码绝对路径，用 __dirname / path.join 推导。
//
// 原因：用户的工作区在 C:\Users\biran\.minimax\workspace 与 D:\.minimax\workspace
// 之间是 junction，路径会变。硬编码会在换机或换盘符后直接失效。
//
// 来源：2026-11-23 建插件时的既定约束（脚本不硬编码绝对路径）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["scripts", "checks"];

// 只扫 .mjs/.js：文档里出现绝对路径是正常的（那是给用户看的路径）。
const HARD_ABS = /(?:[A-Za-z]:[\\/]{1,2}(?!\.\.?($|[\\/]))[^\\/\s]+(?:[\\/][^\\/\s]+)*)|(?:\/(?:home|Users|root|mnt|opt)\/[\w.\-]+(?:\/[\w.\-]+)*)/g;

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
    else if (/\.(mjs|js)$/.test(name)) files.push(p);
  }
  return files;
}

const violations = [];
for (const d of SCAN_DIRS) {
  for (const file of walk(join(ROOT, d))) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      // 注释里的示例路径不算；代码里的算。
      const code = line.replace(/\/\/.*$/, "").replace(/\*.*?\*\//g, "");
      // 源码里的 "D:\\\\foo" 在字符串解析后是 D:\\foo；这里先把转义还原成真实分隔符再匹配，
      // 否则正则会把 \ 误当转义序列，漏掉 . 开头或含转义的路径段。
      const normalized = code.replace(/\\\\/g, "\\");
      const hits = normalized.match(HARD_ABS);
      if (!hits) return;
      violations.push(`${file.replace(ROOT + "\\", "")}:${i + 1}: 硬编码绝对路径 ${hits[0]} —— 请用 __dirname + path.join 推导`);
    });
  }
}

if (violations.length) {
  console.error("发现硬编码绝对路径：");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("OK: 没有硬编码绝对路径");
