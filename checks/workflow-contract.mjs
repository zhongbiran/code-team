#!/usr/bin/env node
// 检查：主 skill 必须符合「一个入口」的契约——frontmatter 带 short-description、
// 编号 quick start、每步点名真实入口、细节外置、触发条件是明确意图而不是「任何复杂任务」。
//
// 为什么要有：主 skill 是整套工作流的唯一入口。它写错了命令、漏了触发口径、
// 或者退化成「什么活都触发」，用户就会照着跑错——而且这种错不会报错，只会静默降级。
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = join(ROOT, "skills", "code-team", "SKILL.md");
const USAGE = join(ROOT, "references", "usage.md");
const MAX_SKILL_BYTES = 12000;   // 主 SKILL.md 保持精简，细节外置

const problems = [];
const text = readFileSync(SKILL, "utf8");

// 1) frontmatter
const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fm) {
  problems.push("SKILL.md 没有 frontmatter");
} else {
  const front = fm[1];
  if (!/^name:[ \t]*code-team[ \t]*$/m.test(front)) problems.push("frontmatter 缺 name: code-team");
  const desc = front.match(/^description:[ \t]*(.+)$/m);
  if (!desc) problems.push("frontmatter 缺 description");
  else {
    if (!desc[1].includes("Code Team")) problems.push("description 没点名 Code Team");
    // 明确意图触发：不能写成「任何复杂任务都触发」，那会与内置 Agent Team 冲突
    for (const banned of ["任何复杂任务", "所有复杂任务", "任何多步任务"]) {
      if (desc[1].includes(banned)) problems.push(`description 含泛化触发词「${banned}」——必须是明确意图触发`);
    }
    for (const need of ["点名", "决策", "后端"]) {
      if (!desc[1].includes(need)) problems.push(`description 没写清触发口径「${need}」`);
    }
  }
  if (!/^[ \t]{2}short-description:[ \t]*.+$/m.test(front)) problems.push("frontmatter 缺 metadata.short-description");
}

// 2) quick start 是编号步骤，且不少于 5 步
const qs = text.match(/##\s*Quick start\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/);
if (!qs) {
  problems.push("SKILL.md 没有 Quick start 段");
} else {
  const steps = qs[1].split(/\r?\n/).filter((l) => /^\d+[.)]\s/.test(l));
  if (steps.length < 5) problems.push(`Quick start 只有 ${steps.length} 步，少于 5 步`);
}

// 3) 点名的入口必须真实存在
const referenced = new Set();
for (const m of text.matchAll(/(?:scripts|checks)\/([A-Za-z0-9_.-]+\.mjs)/g)) referenced.add(m[0]);
for (const ref of referenced) {
  if (!existsSync(join(ROOT, ref))) problems.push(`SKILL.md 点名的 ${ref} 不存在`);
}
for (const m of text.matchAll(/references\/([A-Za-z0-9_.-]+\.md)/g)) {
  if (!existsSync(join(ROOT, "references", m[1]))) problems.push(`SKILL.md 点名的 references/${m[1]} 不存在`);
}

// 4) 契约关键词：删了就说明某条已验证的结论被弄丢了
const required = [
  "Overmind", "Coder", "worker", "explore", "verifier",
  "原样", "至多", "降级", "重开",
  "Tool <name> not found", "/plan", "/goal", "/compact", "/sidechat",
  "lessons.mjs check", "record-event.mjs", "skills-for.mjs", "dispatch-params.mjs", "codex-team.mjs",
];
for (const k of required) {
  if (!text.includes(k)) problems.push(`SKILL.md 缺少关键结论：${k}`);
}

// 5) 细节外置：主 skill 要精简，详细用法在 references/usage.md
if (statSync(SKILL).size > MAX_SKILL_BYTES) {
  problems.push(`SKILL.md 超过 ${MAX_SKILL_BYTES} 字节，细节要外置到 references/usage.md`);
}
if (!existsSync(USAGE)) problems.push("缺少 references/usage.md（细节外置的落点）");

if (problems.length) {
  console.error("主 skill 不符合工作流契约：");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("OK: SKILL.md 符合工作流契约（触发口径 / 编号 quick start / 入口真实 / 细节外置）");
