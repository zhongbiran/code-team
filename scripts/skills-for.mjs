#!/usr/bin/env node
// 生成某个 MCode 后端角色在派工时应附加的 skill 提示行。
//
// 用法：node scripts/skills-for.mjs worker
// 输出是机械的：主会话原样贴进 Task 提示，不做判断、不做增删。
// 名单来自 config/team.json 里该角色的 skills 字段。
//
// 新用法：node scripts/skills-for.mjs worker --direction <id> [--visible-file <json>]
// 输出 { role, specialty } JSON：按任务方向挑专业 skill。
// --visible-file 指向目标会话的 skill 可见清单（Array<{fullName, visibleName}> 或 null），
// 省略它等于 null（拿不到清单 -> 全部 visibility-unknown）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const teamConfig = JSON.parse(readFileSync(join(ROOT, "config", "team.json"), "utf8"));
const cfg = teamConfig;

// 每包最多附 2 个专业 skill；角色原有 skills 不占这两个位置。
export const MAX_SPECIALTY_SKILLS = 2;
const SKIP_REASONS = new Set(["not-visible", "visibility-unknown", "limit"]);

class FieldError extends Error {
  constructor(path, detail) {
    super(path + ": " + detail);
    this.path = path;
    this.detail = detail;
  }
}

/** 方向 id：小写字母开头的 ASCII 标识，可含数字与连字符。 */
const DIRECTION_ID = /^[a-z][a-z0-9-]*$/;
// 完整 skill 名：<plugin>:<skill>，区分大小写。
const FULL_SKILL_NAME = /^[^:\s]+:[^:\s]+$/;

/** 配置级校验：重复方向 ID、非法完整名都是字段错误。 */
export function validateRouting(config) {
  const directions = Array.isArray(config?.routing?.directions) ? config.routing.directions : [];
  const seen = new Set();
  for (const d of directions) {
    if (typeof d?.id !== "string" || !DIRECTION_ID.test(d.id)) {
      throw new FieldError("routing.directions", '非法方向 id "' + d?.id + '"');
    }
    if (seen.has(d.id)) throw new FieldError("routing.directions." + d.id, "方向 ID 重复");
    seen.add(d.id);
    const skills = Array.isArray(d.skills) ? d.skills : [];
    skills.forEach((full, i) => {
      if (typeof full !== "string" || !FULL_SKILL_NAME.test(full)) {
        throw new FieldError("routing.directions." + d.id + ".skills[" + i + "]", '非法完整名 "' + full + '"');
      }
    });
  }
  return directions;
}

/** 从 team.json 取方向；未知方向是字段错误。 */
export function resolveDirection(config, id) {
  const directions = validateRouting(config);
  if (id === undefined || id === null) return null;
  const hit = directions.find((d) => d.id === id);
  if (!hit) throw new FieldError("routing.directions." + id, '未知方向 "' + id + '"');
  return hit;
}

/** 读会话可见清单；文件不存在或格式不对都是字段错误。 */
export function parseVisibleList(file) {
  if (file === undefined || file === null) return null;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new FieldError("visibleFile", "读不到会话清单文件");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FieldError("visibleFile", "会话清单不是合法 JSON");
  }
  if (parsed === null) return null;
  if (!Array.isArray(parsed)) throw new FieldError("visibleFile", "会话清单应为数组或 null");
  parsed.forEach((item, i) => {
    if (!item || typeof item.fullName !== "string" || !item.fullName) {
      throw new FieldError("visibleFile[" + i + "].fullName", "缺少完整名");
    }
    if (typeof item.visibleName !== "string" || !item.visibleName) {
      throw new FieldError("visibleFile[" + i + "].visibleName", "缺少可见名");
    }
  });
  return parsed;
}

/**
 * 组装派工附件的 specialty：{ direction, skills, skipped }。
 * 可见但排不进前 2 个的标 limit；清单里没有的标 not-visible；
 * 拿不到清单时全部标 visibility-unknown。
 */
export function buildSpecialty(directionConfig, visibleList) {
  if (!directionConfig) return { direction: null, skills: [], skipped: [] };
  const visible = visibleList === null ? null : new Map(visibleList.map((v) => [v.fullName, v.visibleName]));
  const skills = [];
  const skipped = [];
  const candidates = [];
  const list = Array.isArray(directionConfig.skills) ? directionConfig.skills : [];
  const seen = new Set();
  for (const full of list) {
    if (seen.has(full)) continue; // 同名只保留第一次
    seen.add(full);
    if (visible === null) {
      skipped.push({ fullName: full, reason: "visibility-unknown" });
      continue;
    }
    if (!visible.has(full)) {
      skipped.push({ fullName: full, reason: "not-visible" });
      continue;
    }
    candidates.push({ fullName: full, visibleName: visible.get(full) });
  }
  for (const c of candidates) {
    if (skills.length < MAX_SPECIALTY_SKILLS) skills.push(c);
    else skipped.push({ fullName: c.fullName, reason: "limit" });
  }
  return { direction: directionConfig.id, skills, skipped };
}

/** 目录里的 specialty 与派工附件同形，便于直接贴进 Task 提示。 */
export function specialtyAttachment(specialty) {
  return { specialty };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const role = argv[0];
  if (!role) {
    console.error("用法：node scripts/skills-for.mjs <role>");
    process.exit(2);
  }
  const roleCfg = cfg.roles?.[role] ?? cfg[role];
  if (!roleCfg) {
    console.error('team.json 里没有角色 "' + role + '"');
    process.exit(2);
  }

  // 新参数存在就走新模式：输出 { role, specialty } JSON。
  const directionIndex = argv.indexOf("--direction");
  const visibleIndex = argv.indexOf("--visible-file");
  const wantsSpecialty = directionIndex !== -1 || visibleIndex !== -1;
  if (wantsSpecialty) {
    const direction = directionIndex === -1 ? null : argv[directionIndex + 1];
    const visibleFile = visibleIndex === -1 ? null : argv[visibleIndex + 1];
    try {
      const directionConfig = resolveDirection(cfg, direction);
      const visibleList = parseVisibleList(visibleFile);
      const specialty = buildSpecialty(directionConfig, visibleList);
      console.log(JSON.stringify({ role, specialty }, null, 2));
    } catch (error) {
      if (error instanceof FieldError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
    process.exit(0);
  }

  const skills = Array.isArray(roleCfg.skills) ? roleCfg.skills : [];
  if (!skills.length) {
    console.log("（该角色未配置 skill）");
    process.exit(0);
  }
  console.log("可用 skill（命中才用，先加载再动手）：" + skills.join("、"));
}
