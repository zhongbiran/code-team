#!/usr/bin/env node
// 检查：派工 brief 里必须包含「编译闸」，不能让 Worker 只跑静态检查就交付。
//
// 原因（2026-11-24 实测）：RC.DustFall 九包并行时，P5 与 P2 两个包**编译都不过**
// （CS0101 同名类型重复 / CS0120 静态方法访问实例成员），但它们跑的是
// `pwsh -File Scripts\\verify.ps1 -ChecksOnly` —— 那是纯静态检查，不编译 ——
// 于是两个包各自把「静态检查通过」当成「编译通过」交付，返工两轮。
//
// 规则：brief 的验收段必须出现「编译」字样与具体工程名，
// 且必须明确说明 -ChecksOnly 不等于编译通过。
//
// 适用范围：只有 .NET 项目才需要编译闸。判据是目标项目根目录里有 .sln/.csproj，
// 或 brief 自己出现 .NET 痕迹（verify.ps1 / dotnet build / .csproj）。
// 这条范围限制沿用旧检查：非 .NET 项目的 brief 不因本检查被拦。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRIEF_DIRS = ["briefs", "tmp"];

function walk(dir) {
  const files = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return files; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (/\.md$/.test(name)) files.push(p);
  }
  return files;
}

// .NET 项目根目录里有 .sln / .csproj 吗
function hasDotNetProjectFiles(projectRoot) {
  if (!projectRoot || !existsSync(projectRoot)) return false;
  let entries;
  try { entries = readdirSync(projectRoot); } catch { return false; }
  return entries.some((n) => /\.(sln|csproj)$/i.test(n));
}

function isDotNetScope(projectRoot, briefs) {
  if (hasDotNetProjectFiles(projectRoot)) return true;
  return briefs.some((b) => /verify\.ps1|dotnet\s+build|\.csproj/i.test(b.text || ""));
}

/**
 * 编译闸判定。briefs: [{ id?, text }]
 * 返回 Finding[]：{ code, severity, brief, message }
 */
export function checkCompileGate({ projectRoot, briefs }) {
  const findings = [];
  const list = briefs || [];
  const dotnet = isDotNetScope(projectRoot, list);
  for (const b of list) {
    const text = b.text || "";
    // 只看提了 -ChecksOnly 的 brief（沿用旧检查的触发点）
    if (!text.includes("-ChecksOnly")) continue;
    if (!dotnet) continue;
    const hasCompile = /编译|dotnet build|0 个错误|0 错误/.test(text);
    if (hasCompile) continue;
    findings.push({
      code: "compile-gate-missing",
      severity: "error",
      brief: b.id || null,
      message:
        (b.id ? b.id + ": " : "") +
        "brief 只要求 -ChecksOnly（静态检查，不编译）—— 必须补编译闸：dotnet build <工程> → 0 错误",
    });
  }
  return findings;
}

// CLI：扫插件自带 brief；--briefs <目录> 时只扫该目录
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { out._.push(argv[i]); continue; }
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith("--")) out[k] = true;
    else { out[k] = n; i++; }
  }
  return out;
}

function collectBriefs(args) {
  const dirs = args.briefs ? [args.briefs] : BRIEF_DIRS.map((d) => join(ROOT, d));
  const briefs = [];
  for (const d of dirs) {
    for (const file of walk(d)) {
      briefs.push({
        id: file.replace(ROOT + "\\", ""),
        text: readFileSync(file, "utf8"),
      });
    }
  }
  return briefs;
}

export function runCli(args = {}) {
  const briefs = collectBriefs(args);
  if (!briefs.length) {
    if (args.briefs) {
      console.error("FAIL: 没有样本 —— 零样本通过不算数（--briefs " + args.briefs + " 下没有 .md brief）");
      return 1;
    }
    console.log("SKIP: 没有样本（零样本通过不算数）");
    return 0;
  }
  const findings = checkCompileGate({
    projectRoot: args.project ? resolve(args.project) : ROOT,
    briefs,
  });
  if (findings.length) {
    console.error("发现缺少编译闸的 brief：");
    for (const f of findings) console.error("  " + f.message);
    return 1;
  }
  console.log("OK: brief 都带编译闸（样本 " + briefs.length + " 份）");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(parseArgs(process.argv.slice(2))));
}
