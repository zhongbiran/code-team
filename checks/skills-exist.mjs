#!/usr/bin/env node
// 检查 config/team.json 里每个角色配置的 skill，在该角色所在侧真实存在。
//
// 为什么要有：skill 名写错或插件没装，流程照跑不报错，只是 skill 从没被加载过——
// 这种失败是隐形的。配置里加新 skill 时跑一次这个检查。
//
// 侧由角色的 backend 决定：codex-cli -> Codex 侧；mcode-agent -> MCode 侧。
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.USERPROFILE || process.env.HOME;
const cfg = JSON.parse(readFileSync(join(ROOT, "config", "team.json"), "utf8"));

function findSkillFile(roots, name) {
  // 在 roots 下找形如 <root>/.../skills/<name>/SKILL.md
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const plugin of safeReaddir(root)) {
      const skillsDir = join(root, plugin, "skills");
      if (!existsSync(skillsDir)) continue;
      const hit = join(skillsDir, name, "SKILL.md");
      if (existsSync(hit)) return hit;
    }
  }
  return null;
}

function findPluginSkillFile(roots, plugin, name) {
  // 找形如 <root>/<plugin>/<version>/skills/<name>/SKILL.md（Codex 插件缓存是两层）
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const p of safeReaddir(root)) {
      const inner = join(root, p, "skills");
      if (!existsSync(inner)) continue;
      const hit = join(inner, name, "SKILL.md");
      if (existsSync(hit)) return hit;
    }
  }
  return null;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
  } catch {
    return [];
  }
}

const CODEX_ROOTS = [
  join(HOME, ".codex", "plugins", "cache"),
  join(HOME, ".codex", "plugins"),
];
const MCODE_ROOTS = [join(HOME, ".minimax", "plugins")];

let problems = 0;
let checked = 0;

for (const [role, rc] of Object.entries(cfg.roles ?? {})) {
  const skills = Array.isArray(rc.skills) ? rc.skills : [];
  if (!skills.length) continue;
  const side = rc.backend === "codex-cli" ? "Codex" : "MCode";
  for (const raw of skills) {
    checked++;
    const i = raw.indexOf(":");
    const plugin = i > 0 ? raw.slice(0, i) : null;
    const name = i > 0 ? raw.slice(i + 1) : raw;
    let hit = null;
    if (side === "Codex") {
      if (plugin) {
        hit = findPluginSkillFile(CODEX_ROOTS, plugin, name);
        // Codex 侧插件缓存是 <root>/<vendor>/<plugin>/<version>/skills/...，多一层
        if (!hit) {
          for (const root of CODEX_ROOTS) {
            if (!existsSync(root)) continue;
            for (const vendor of safeReaddir(root)) {
              for (const p of safeReaddir(join(root, vendor))) {
                for (const ver of safeReaddir(join(root, vendor, p))) {
                  const cand = join(root, vendor, p, ver, "skills", name, "SKILL.md");
                  if (existsSync(cand)) { hit = cand; break; }
                }
              }
            }
          }
        }
      } else {
        for (const p of [join(HOME, ".codex", "skills"), join(HOME, ".agents", "skills")]) {
          const cand = join(p, name, "SKILL.md");
          if (existsSync(cand)) { hit = cand; break; }
        }
      }
    } else {
      if (plugin) {
        hit = findSkillFile(MCODE_ROOTS, plugin, name);
        if (!hit) {
          for (const root of MCODE_ROOTS) {
            const cand = join(root, plugin, "skills", name, "SKILL.md");
            if (existsSync(cand)) { hit = cand; break; }
          }
        }
      } else {
        for (const p of [join(HOME, ".agents", "skills"), join(HOME, ".codex", "skills")]) {
          const cand = join(p, name, "SKILL.md");
          if (existsSync(cand)) { hit = cand; break; }
        }
      }
    }
    if (hit) {
      console.log("OK   " + role.padEnd(10) + raw + "  ->  " + hit);
    } else {
      problems++;
      console.log("FAIL " + role.padEnd(10) + raw + "  ->  " + side + " 侧找不到（插件未装？名字写错？）");
    }
  }
}

// Codex 侧的可见 skill 列表有上下文预算上限（实测）：
// 平铺 19 个描述较长的 skill，可见数从 53 掉到 34，按字母序排在后面的整组消失
// （superpowers: 全组、work-pets: 全部被挤掉）。
// 这里用"平铺数量"当红线——数值是经验值，宁可保守。
const codexFlat = join(HOME, ".codex", "skills");
let flatCount = 0;
try {
  flatCount = readdirSync(codexFlat).filter(
    (n) => n !== ".system" && statSync(join(codexFlat, n)).isDirectory()
  ).length;
} catch {}
if (flatCount > 8) {
  problems++;
  console.log("FAIL Codex 侧平铺 skill " + flatCount + " 个（>8）：列表有预算上限，多的会把后面的整组挤掉");
} else {
  console.log("OK   Codex 侧平铺 skill " + flatCount + " 个（上限 8）");
}

console.log("");
console.log(checked + " 个配置，" + problems + " 个问题");
if (problems) {
  console.log("找不到的 skill 永远不会被加载——流程会照跑，但方法论没生效。");
  process.exit(1);
}
