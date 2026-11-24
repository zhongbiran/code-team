#!/usr/bin/env node
// 检查：发布总入口必须真的把 checks/ 下的每个检查都跑一遍，并且不会递归调用自己。
//
// 为什么要有：总入口只遍历台账里已升级的条目时，空台账等于「一个检查都没跑」——
// 随包发布的必跑检查被静默跳过。发布把关必须是「随包检查 + 台账检查」的合并去重。
//
// 递归问题：检查脚本再调总入口就会无限递归。总入口用 CODE_TEAM_CHECK_DEPTH 挡住，
// 这里专门验证那道守卫确实在。
import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LESSONS = join(ROOT, "scripts", "lessons.mjs");
const DEPTH_ENV = "CODE_TEAM_CHECK_DEPTH";

const bundled = readdirSync(join(ROOT, "checks")).filter((n) => n.endsWith(".mjs")).sort();
const problems = [];

// 1) 总入口列出的检查 = checks/ 下的文件，不重不漏
const listed = spawnSync(process.execPath, [LESSONS, "list-checks"], { encoding: "utf8", cwd: ROOT });
if (listed.status !== 0) {
  problems.push(`lessons.mjs list-checks 退出码 ${listed.status}`);
}
const names = (listed.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
for (const n of bundled) {
  const count = names.filter((x) => x === n).length;
  if (count === 0) problems.push(`总入口漏掉了随包检查 ${n}`);
  else if (count > 1) problems.push(`总入口重复列出 ${n}（出现 ${count} 次）`);
}
if (new Set(names).size !== names.length) problems.push("总入口的检查清单里有重复项");

// 2) 两个禁止项必须在把关范围内
for (const must of ["no-bare-codex-exec.mjs", "no-hardcoded-abs-paths.mjs"]) {
  if (!bundled.includes(must)) problems.push(`发布检查缺少禁止项 ${must}`);
}

// 3) 检查脚本不许递归调用总入口
const rec = spawnSync(process.execPath, [LESSONS, "check"], {
  encoding: "utf8",
  cwd: ROOT,
  env: { ...process.env, [DEPTH_ENV]: "1" },
});
if (rec.status === 0) problems.push("总入口在检查运行期间被再次调用 —— 递归了");
if (!/递归/.test((rec.stdout || "") + (rec.stderr || ""))) problems.push("总入口没有报告递归调用");

if (problems.length) {
  console.error("检查发现机制有问题：");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`OK: 总入口覆盖 ${bundled.length} 个随包检查，且不会递归调用自己`);
