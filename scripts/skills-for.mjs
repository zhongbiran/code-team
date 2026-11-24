#!/usr/bin/env node
// 生成某个 MCode 后端角色在派工时应附加的 skill 提示行。
//
// 用法：node scripts/skills-for.mjs worker
//
// 输出是机械的：主会话原样贴进 Task 提示，不做判断、不做增删。
// 名单来自 config/team.json 里该角色的 skills 字段。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config", "team.json"), "utf8"));
const role = process.argv[2];
if (!role) {
  console.error("用法：node scripts/skills-for.mjs <role>");
  process.exit(2);
}
const roleCfg = cfg.roles?.[role] ?? cfg[role];
if (!roleCfg) {
  console.error("team.json 里没有角色 \"" + role + "\"");
  process.exit(2);
}
const skills = Array.isArray(roleCfg.skills) ? roleCfg.skills : [];
if (!skills.length) {
  console.log("（该角色未配置 skill）");
  process.exit(0);
}
console.log("可用 skill（命中才用，先加载再动手）：" + skills.join("、"));
