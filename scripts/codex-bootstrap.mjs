#!/usr/bin/env node
// 把 MCode 侧的项目规范同步到 Codex 侧。
//
// 背景：MCode 装好了自己的环境（AGENTS.md、skills、插件），但 Codex 是全新环境，
// 它只认 ~/.codex/AGENTS.md、项目级 AGENTS.md 和 ~/.codex/skills/<name>/SKILL.md。
// 不做这层同步，Codex 开的规划会话就看不到项目的验收命令与已知坑，等于让它瞎猜。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Codex 侧的位置。首次会话预检（scripts/session-start.mjs）也要判断同一件事，
// 所以导出这组只读函数，别处不再重复推导路径。
export function codexHome(env = process.env) {
  const home = env.USERPROFILE || env.HOME || "";
  return env.CODEX_HOME || join(home, ".codex");
}

// Codex CLI 的 JS 入口（node_modules/@openai/codex/bin/codex.js）。
export function codexEntryPath(env = process.env) {
  return env.APPDATA ? join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js") : null;
}

// 只读快照：Codex 侧现在有什么，缺什么。绝不写任何文件。
export function codexReadiness(env = process.env) {
  const home = codexHome(env);
  const entry = codexEntryPath(env);
  const agentsFile = join(home, "AGENTS.md");
  const skillsDir = join(home, "skills");
  let skills = [];
  try {
    skills = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
  } catch {}
  return {
    codexHome: home,
    codexEntry: entry,
    codexEntryFound: Boolean(entry && existsSync(entry)),
    agentsFile,
    agentsFound: existsSync(agentsFile),
    skills,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const args = isMain ? process.argv.slice(2) : [];
const projectRoot = args[0] ? resolve(args[0]) : process.cwd();
const mode = args[1] ?? "sync";

function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function copySkills() {
  const src = join(projectRoot, "skills");
  const dst = join(codexHome(), "skills");
  if (!existsSync(src)) return { copied: [], skipped: "项目没有 skills/ 目录" };
  mkdirSync(dst, { recursive: true });
  const copied = [];
  for (const name of readdirSync(src)) {
    const skillFile = join(src, name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    // 已有同名 skill 不覆盖：Codex 侧的 .system skill 是官方提供的，优先级更高。
    const target = join(dst, name, "SKILL.md");
    if (existsSync(target)) { copied.push(name + "(已存在，跳过)"); continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(skillFile), "utf8");
    copied.push(name);
  }
  return { copied };
}

function writeCodexAgents() {
  const p = join(codexHome(), "AGENTS.md");
  const existing = readIfExists(p);
  const marker = "<!-- code-team:start -->";
  const block = `${marker}
## Code Team 角色约定

你在 Code Team 工作流里被调用，角色有两种：

- **Overmind**：总策划。只出方案——问题定义、约束、2-3 个方案及推荐理由、执行顺序、
  验收标准、目标产出物。**不写实现代码**，不改工作区文件。
- **Coder**：编码方向规划。只读代码，给出接口设计、关键实现取舍、核心问题定位。
  **不写业务代码**，实现由 Worker 子代理做。

共同规则：
- 只读。除非用户明确要求，否则不修改任何文件。
- 每条结论要么有证据（文件路径、命令输出、行号），要么明确标注是假设。
- 不重复提问：缺失信息若不影响正确性，做合理假设并写明假设。
- 输出用中文，结构化（问题定义 / 约束 / 方案 / 执行顺序 / 验收标准 / 风险 / 待确认问题）。

## Code Team 的自动检查

这两个检查会自己跑，发现问题会自己失败。改本插件的代码后先跑它们：

    node scripts/lessons.mjs check

- no-bare-codex-exec.mjs：禁止绕过封装直接调 codex exec（本机 WebSocket 不通，裸跑白等 120 秒）
- no-hardcoded-abs-paths.mjs：禁止脚本硬编码绝对路径，用 __dirname 推导

## 输出质量的硬要求

- **根因、诊断、"这样能修好"这类结论，必须带三样**：概率、哪些是验证的哪些是推断的、
  以及什么检查会推翻它。不依赖自身判断的检查优先：测试、脚本、原始日志、源码、git history。
- **验收标准必须可测量**。不要写"代码质量好""体验更佳"这类无法判定的说法，
  写成一条能跑的命令、一个具体的数字、一张截图或一行日志。
- **每个建议给方案和理由**。有多个可行方案时，给出推荐项，并说明推荐它的代价。
- **修复类任务先复现再改**：先说清未修复代码上如何复现同样的症状，再谈怎么改。
- 不确定就说不确定，并写清缺什么信息。不要用确定语气包装推测。
${marker}
`;
  if (existing === null) {
    writeFileSync(p, block, "utf8");
    return "已创建 " + p;
  }
  // 标记块已存在时替换整块，保证规则更新能同步到 Codex 侧。
  if (existing.includes(marker)) {
    const start = existing.indexOf(marker);
    const end = existing.indexOf(marker, start + marker.length);
    const replaced = existing.slice(0, start) + block.trimEnd() + existing.slice(end + marker.length);
    writeFileSync(p, replaced, "utf8");
    return "已更新 " + p;
  }
  writeFileSync(p, existing.trimEnd() + "\n\n" + block, "utf8");
  return "已追加到 " + p;
}

function report() {
  const r = codexReadiness();
  console.log("Codex 侧环境检查");
  console.log("  CODEX_HOME: " + r.codexHome);
  console.log("  codex 可执行: " + (r.codexEntryFound ? "是" : "未找到"));
  console.log("  全局 AGENTS.md: " + (r.agentsFound ? "有" : "无"));
  console.log("  项目 AGENTS.md: " + (existsSync(join(projectRoot, "AGENTS.md")) ? "有" : "无"));
  console.log("  Codex skill 目录: " + (r.skills.length ? r.skills.join(", ") : "无"));
  console.log("  项目根: " + projectRoot);
}

// 只在直接运行时执行 CLI；被 import 时（预检）只提供只读函数。
if (isMain) {
  if (mode === "report") {
    report();
  } else if (mode === "sync") {
    console.log(writeCodexAgents());
    const r = copySkills();
    const synced = r.skipped ?? (r.copied.length ? r.copied.join(", ") : "无");
    console.log("skill 同步: " + synced);
    report();
  } else {
    console.log("用法: codex-bootstrap.mjs [项目根目录] [sync|report]");
    process.exit(2);
  }
}
