#!/usr/bin/env node
// 检查：并行包的 brief 必须声明文件归属，且不得与已登记的其它包重叠。
//
// 原因（2026-11-24 实测）：RC.DustFall 九包并行时，P5（模拟引擎）与 P9（WebAdmin 历史）
// 都改了 Src/02-Application/.../Domain/Helper/Simulation*.cs —— P9 收尾时把 P5 的实现打乱，
// 直接产生 10 条编译错误，最后要另起一个集成修复包收尾。
//
// 规则：每份 brief 必须有「文件归属」段；两份 brief 的归属文件清单不得有交集。
//
// 归属段有两种写法，都要认：
//   1) 标题 + 列表：  ## 文件归属（只改这些）  下面跟 - `Src/A.cs`
//   2) 一行写完：    文件归属：Src/A.cs、Src/B.cs
// 路径按目标项目根目录规范化后再比（相对路径 vs 绝对路径也算同一个文件）。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRIEF_DIRS = ["briefs", "tmp"];
const PATH_RE = /[\w.\\/-]+\.(?:cs|razor|css|json|csproj|sql|md|mjs|js)/g;
const PATH_ANY = /[\w.\\/-]+\.(?:cs|razor|css|json|csproj|sql|md|mjs|js)/;

/** 从 brief 正文里抽出归属文件清单；抽不到返回 null */
export function extractOwnedFiles(text) {
  const lines = String(text || "").split(/\r?\n/);
  const idx = lines.findIndex((l) => /文件归属|归属文件|文件所有权/.test(l));
  if (idx < 0) return null;
  const seg = [];
  const m = lines[idx].match(/(?:文件归属|归属文件|文件所有权)[^：:]*[：:]?\s*(.*)$/);
  const inline = m ? m[1] : "";
  if (inline && PATH_ANY.test(inline)) {
    // 写法 2：一行写完
    seg.push(inline);
  } else {
    // 写法 1：标题 + 下面的列表，直到下一个标题或新段落正文
    for (let i = idx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*#{1,6}\s/.test(l)) break;   // 下一个标题
      if (/^\s*\S/.test(l) && !/^\s*[-*|]/.test(l) && seg.length) break; // 新段落正文
      seg.push(l);
    }
  }
  const out = new Set();
  for (const mm of seg.join("\n").matchAll(PATH_RE)) {
    out.add(mm[0].replace(/\\/g, "/"));
  }
  return out.size ? [...out] : null;
}

/** 按目标项目根目录规范化路径（相对路径按项目根解析），用于跨写法比对 */
export function normalizeOwnedPath(p, projectRoot) {
  const s = String(p).replace(/\\/g, "/");
  const base = projectRoot || ROOT;
  const abs = isAbsolute(s) ? resolve(s) : resolve(base, s);
  return abs.replace(/\\/g, "/").toLowerCase();
}

/**
 * 文件归属判定。briefs: [{ id?, text?, owned? }]（owned 给了就跳过正文解析）
 * 返回 Finding[]：{ code, severity, brief, briefs?, message }
 */
export function checkFileOwnership({ projectRoot, briefs }) {
  const findings = [];
  const list = (briefs || []).map((b) => ({
    id: b.id || null,
    owned: b.owned || extractOwnedFiles(b.text || ""),
  }));
  for (const b of list) {
    if (!b.owned || !b.owned.length) {
      findings.push({
        code: "ownership-missing",
        severity: "error",
        brief: b.id,
        message: (b.id ? b.id + ": " : "") + "brief 没有「文件归属」段 —— 并行包必须写死文件清单",
      });
    }
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].owned, c = list[j].owned;
      if (!a || !c || !a.length || !c.length) continue;
      const normC = new Map(c.map((p) => [normalizeOwnedPath(p, projectRoot), p]));
      const overlap = a
        .map((p) => ({ p, n: normalizeOwnedPath(p, projectRoot) }))
        .filter((x) => normC.has(x.n))
        .map((x) => x.p);
      if (overlap.length) {
        findings.push({
          code: "ownership-overlap",
          severity: "error",
          brief: list[i].id,
          briefs: [list[i].id, list[j].id],
          message:
            (list[i].id ? list[i].id + " 与 " : "") +
            (list[j].id ? list[j].id + " " : "") +
            "文件重叠: " + overlap.slice(0, 5).join(", ") +
            " —— 并行包必须文件互斥，或由集成包统一处理",
        });
      }
    }
  }
  return findings;
}

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
      briefs.push({ id: file.replace(ROOT + "\\", ""), text: readFileSync(file, "utf8") });
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
  const findings = checkFileOwnership({
    projectRoot: args.project ? resolve(args.project) : ROOT,
    briefs,
  });
  if (findings.length) {
    console.error("发现并行包文件归属问题：");
    for (const f of findings) console.error("  " + f.message);
    return 1;
  }
  console.log("OK: 并行包文件归属互斥且齐全（样本 " + briefs.length + " 份）");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(parseArgs(process.argv.slice(2))));
}
