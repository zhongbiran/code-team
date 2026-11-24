#!/usr/bin/env node
// Code Team 首次会话自举与安装保全的检查。
//
// 这个检查要证明四件事：
// 1. hook 接线完整：manifest 声明 hooks/hooks.json，hook 文档指向 scripts/session-start.mjs；
// 2. 预检行为正确：隔离环境缺组件时 blocked 且只给一条下一步，组件齐备时 ready 且安静；
// 3. 预检不启动外部程序：源码里不出现 spawn/exec，运行时也不依赖 PATH 上的程序；
// 4. 安装保全：事件流逐字节不变（原本不存在就保持不存在）、纠正台账保留、
//    角色选择保留并合并新默认值、hook 与预检脚本确实被打进安装目录。
//
// 全部验证都在临时目录里跑：不碰本机插件安装目录，不碰本机运行时数据。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_START = join(ROOT, "scripts", "session-start.mjs");
const INSTALLER = join(ROOT, "scripts", "install-plugin.mjs");
const MANIFEST = join(ROOT, ".minimax-plugin", "plugin.json");
const ROOT_MANIFEST = join(ROOT, "plugin.json");
const HOOK_DOC = join(ROOT, "hooks", "hooks.json");

const temps = [];
let failures = 0;

function ok(name, detail) {
  console.log("OK   " + name + (detail ? "  — " + detail : ""));
}
function fail(name, detail) {
  failures++;
  console.log("FAIL " + name + "  — " + detail);
}
function tempDir(tag) {
  const d = mkdtempSync(join(tmpdir(), "code-team-" + tag + "-"));
  temps.push(d);
  return d;
}
function unlockTree(dir) {
  // Windows 上只读文件要先放开权限才能删。
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) unlockTree(p);
    else { try { chmodSync(p, 0o666); } catch {} }
  }
}
function cleanup() {
  for (const d of temps) {
    unlockTree(d);
    rmSync(d, { recursive: true, force: true });
  }
}
function isolatedEnv(home, extra = {}) {
  const env = { ...process.env };
  delete env.CODEX_HOME;
  // 隔离开关由每个用例自己给，不继承外部环境。
  delete env.CODE_TEAM_CONFIG;
  delete env.CODE_TEAM_EVENTS;
  delete env.CODE_TEAM_SCHEMA;
  delete env.CODE_TEAM_LEDGER;
  env.USERPROFILE = home;
  env.HOME = home;
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  // PATH 指到空目录：预检若需要启动 PATH 上的任何程序就会失败——它不需要。
  const emptyPath = join(home, "empty-path");
  mkdirSync(emptyPath, { recursive: true });
  env.PATH = emptyPath;
  return Object.assign(env, extra);
}
function runNode(args, env) {
  return spawnSync(process.execPath, args, { encoding: "utf8", env, cwd: ROOT });
}

// 占位符白名单：只放 CLAUDE_PLUGIN_ROOT——插件来源 hook 的 env 里确实有它。
// 踩坑：asar 里搜不到字面量 "${CLAUDE_PLUGIN_ROOT}"，也没有 Ds3 这个函数；
// 按"搜字面量"下结论会误判成"宿主不认这个占位符"。
const HOST_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";
function checkHookCommand(label, text) {
  if (typeof text !== "string" || !text) {
    fail("hook-placeholder-" + label, "命令为空");
    return;
  }
  if (!text.includes(HOST_PLACEHOLDER)) {
    fail("hook-placeholder-" + label, "没有用插件 hook 的 env 里确实注入的 " + HOST_PLACEHOLDER + "：" + text);
  } else {
    ok("hook-placeholder-" + label, HOST_PLACEHOLDER);
  }
  const tokens = [...text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]);
  const bad = tokens.filter((t) => t !== "CLAUDE_PLUGIN_ROOT");
  if (bad.length) {
    fail("hook-placeholder-only-" + label, "命令里还有别的占位符（只认 " + HOST_PLACEHOLDER + "）：" + bad.map((t) => "${" + t + "}").join(", "));
  } else {
    ok("hook-placeholder-only-" + label, "只用了宿主保证的占位符");
  }
  // 替换之后必须真的指向本插件里那个脚本。
  const resolved = text.replaceAll(HOST_PLACEHOLDER, ROOT);
  const hit = resolved.match(/"([^"]*session-start\.mjs)"/);
  if (hit && existsSync(hit[1])) ok("hook-resolves-" + label, hit[1].replace(ROOT, "<repo>"));
  else fail("hook-resolves-" + label, "替换占位符后定位不到真实的 scripts/session-start.mjs：" + resolved);
}

// --- 1. hook 接线 ---
if (!existsSync(MANIFEST)) {
  fail("manifest", "缺少 .minimax-plugin/plugin.json");
} else {
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(MANIFEST, "utf8")); } catch (e) { fail("manifest", "JSON 解析失败：" + e.message); }
  if (manifest) {
    const declared = Array.isArray(manifest.hooks) ? manifest.hooks : [];
    if (declared.includes("hooks/hooks.json")) ok("manifest-hooks", "已声明 hooks/hooks.json");
    else fail("manifest-hooks", "manifest.hooks 没有声明 hooks/hooks.json → 宿主不会加载 hook，首次会话不会自动预检");
  }
}

// manifest 引用的图标文件必须在仓库里真的有：从 git 全新装出来的插件不能没有图标。
for (const [label, file] of [["minimax", MANIFEST], ["root", ROOT_MANIFEST]]) {
  if (!existsSync(file)) continue;
  let mf = null;
  try { mf = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
  const ext = (mf.extensions && mf.extensions["com.minimax.code"]) || {};
  for (const key of ["icon", "darkIcon"]) {
    const v = mf[key] ?? ext[key];
    if (!v) continue;
    if (existsSync(join(ROOT, v))) ok("manifest-icon-" + label + "-" + key, v);
    else fail("manifest-icon-" + label + "-" + key, "manifest 引用了 " + v + "，仓库里没有这个文件 → 从 git 全新安装出来的插件没有图标");
  }
}

if (!existsSync(HOOK_DOC)) {
  fail("hook-doc", "缺少 hooks/hooks.json → 宿主没有 SessionStart hook，首次会话不会自动预检");
} else {
  let doc = null;
  try { doc = JSON.parse(readFileSync(HOOK_DOC, "utf8")); } catch (e) { fail("hook-doc", "JSON 解析失败：" + e.message); }
  if (doc) {
    const groups = doc.hooks && doc.hooks.SessionStart ? doc.hooks.SessionStart : [];
    const handlers = groups.flatMap((g) => (g.hooks ?? []));
    const cmd = handlers.find((h) => h.type === "command");
    if (!cmd) fail("hook-doc", "SessionStart 没有 type=command 的 handler");
    else {
      if (typeof cmd.command === "string" && cmd.command.includes("scripts/session-start.mjs")) ok("hook-command", cmd.command);
      else fail("hook-command", "SessionStart 命令没有指向 scripts/session-start.mjs：" + cmd.command);
      if (cmd.timeout === undefined || (cmd.timeout >= 1 && cmd.timeout <= 10)) ok("hook-timeout", "timeout=" + (cmd.timeout ?? "默认 5"));
      else fail("hook-timeout", "timeout 必须在 1..10 秒内，实际 " + cmd.timeout);
      // 占位符：宿主按通用 ${NAME} 展开 env 变量（expandHookPlaceholders(value, env)，
      // 正则 /\$\{([A-Z][A-Z0-9_]*)\}/gu）；插件来源的 hook 拿到的 env 里带 CLAUDE_PLUGIN_ROOT
      // （另有 MINIMAX_PLUGIN_ROOT / PLUGIN_ROOT / CODEX_PLUGIN_ROOT）。
      // 只认 CLAUDE_PLUGIN_ROOT：它是插件 hook 这条路上确实注入的那个。
      checkHookCommand("command", cmd.command);
      // commandWindows 是宿主认的字段（parser 的 commandValue 在 win32 上优先取它）。
      if (cmd.commandWindows === undefined) ok("hook-command-windows", "未声明 commandWindows（Windows 上用 command 里的正斜杠路径）");
      else checkHookCommand("commandWindows", cmd.commandWindows);
    }
  }
}

// --- 2. 脚本语法 ---
for (const f of [SESSION_START, INSTALLER, join(ROOT, "scripts", "codex-bootstrap.mjs")]) {
  if (!existsSync(f)) { fail("syntax", "缺少 " + f.replace(ROOT, "<repo>")); continue; }
  const res = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (res.status === 0) ok("syntax", f.replace(ROOT, "<repo>"));
  else fail("syntax", f.replace(ROOT, "<repo>") + " → " + (res.stderr || "").trim().split(/\r?\n/)[0]);
}

// --- 3. 预检不得启动外部程序 ---
for (const f of [SESSION_START, join(ROOT, "scripts", "codex-bootstrap.mjs")]) {
  if (!existsSync(f)) continue;
  const code = readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const hit = code.match(/child_process|\bspawn\w*\(|\bexec\w*\(/);
  if (hit) fail("preflight-no-external-process", f.replace(ROOT, "<repo>") + " 出现 " + hit[0] + " → 预检会启动外部程序");
  else ok("preflight-no-external-process", f.replace(ROOT, "<repo>"));
}

// --- 4. 预检行为（隔离 HOME） ---
function fakeCodexHome(tag) {
  const home = tempDir(tag);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "AGENTS.md"), "# fake\n", "utf8");
  const entry = join(home, "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "// fake codex entry\n", "utf8");
  return home;
}

if (!existsSync(SESSION_START)) {
  fail("preflight-blocked", "缺少 scripts/session-start.mjs → 首次会话不会自动预检");
  fail("preflight-ready", "缺少 scripts/session-start.mjs → 首次会话不会自动预检");
} else {
  // 4a. 缺组件：blocked + 唯一一条可执行的下一步
  const emptyHome = tempDir("nohome");
  const blockedRes = runNode([SESSION_START, "--json"], isolatedEnv(emptyHome));
  let blocked = null;
  try { blocked = JSON.parse(blockedRes.stdout); } catch {}
  if (!blocked) {
    fail("preflight-blocked", "预检没有输出可解析的 JSON：" + (blockedRes.stderr || "").trim().split(/\r?\n/)[0]);
  } else if (blocked.status !== "blocked") {
    fail("preflight-blocked", "空环境下预检状态是 " + blocked.status + "（应为 blocked）");
  } else if (!blocked.nextStep || typeof blocked.nextStep.text !== "string" || !blocked.nextStep.command || typeof blocked.nextStep.command.executable !== "string") {
    fail("preflight-blocked", "blocked 时没有给出唯一一条带命令的下一步：" + JSON.stringify(blocked.nextStep));
  } else {
    ok("preflight-blocked", blocked.status + " → " + blocked.nextStep.text);
    const cmd = blocked.nextStep.command;
    if (Array.isArray(cmd.args) && cmd.args.every((a) => typeof a === "string")) ok("preflight-next-step-command", cmd.executable + " " + cmd.args.join(" "));
    else fail("preflight-next-step-command", "command.args 必须是字符串数组");
  }
  // blocked 时必须把唯一的下一步讲清楚（普通 stdout 就是 additionalContext）
  const blockedPlain = runNode([SESSION_START], isolatedEnv(emptyHome));
  if (blockedPlain.status === 0 && blockedPlain.stdout.trim()) ok("preflight-blocked-output", blockedPlain.stdout.trim().split(/\r?\n/).length + " 行上下文");
  else fail("preflight-blocked-output", "blocked 时没有输出下一步说明：" + (blockedPlain.stderr || "").trim().split(/\r?\n/)[0]);

  // 4b. 组件齐备：ready + 安静
  const goodHome = fakeCodexHome("goodhome");
  const readyRes = runNode([SESSION_START, "--json"], isolatedEnv(goodHome));
  let ready = null;
  try { ready = JSON.parse(readyRes.stdout); } catch {}
  if (!ready) {
    fail("preflight-ready", "预检没有输出可解析的 JSON：" + (readyRes.stderr || "").trim().split(/\r?\n/)[0]);
  } else if (ready.status !== "ready") {
    fail("preflight-ready", "组件齐备时状态是 " + ready.status + "（应为 ready）：" + JSON.stringify(ready.checks));
  } else {
    ok("preflight-ready", "ready，" + ready.checks.length + " 项检查通过");
  }
  const readyPlain = runNode([SESSION_START], isolatedEnv(goodHome));
  if (readyPlain.status === 0 && !readyPlain.stdout.trim()) ok("preflight-quiet", "ready 时不输出任何内容");
  else fail("preflight-quiet", "ready 时不应有输出：" + JSON.stringify(readyPlain.stdout.slice(0, 200)));
}

// --- 5. localContext 键表（契约 1） ---
// 造一个假的后端模块，录下 session-start 传进来的 localContext，验四个必需键。
{
  // 假插件根 + 假后端模块：录下 session-start 真传出去的 localContext。
  const captureLocalContext = (extraEnv) => {
    const fakeRoot = tempDir("ctxroot");
    mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
    mkdirSync(join(fakeRoot, "config"), { recursive: true });
    for (const f of ["session-start.mjs", "codex-bootstrap.mjs"]) {
      cpSync(join(ROOT, "scripts", f), join(fakeRoot, "scripts", f), { recursive: true });
    }
    cpSync(join(ROOT, "config", "team.json"), join(fakeRoot, "config", "team.json"), { recursive: true });
    const capture = join(fakeRoot, "captured.json");
    writeFileSync(
      join(fakeRoot, "scripts", "decision-backend.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'export function preflight(role, roleConfig, localContext) {',
        '  writeFileSync(process.env.CT_CAPTURE, JSON.stringify(localContext));',
        '  return { status: "ready", checks: [{ id: "fake", status: "ok", detail: "fake" }], nextStep: null };',
        '}',
        '',
      ].join("\n"),
      "utf8"
    );
    const ctxHome = fakeCodexHome("ctxhome");
    const res = runNode([join(fakeRoot, "scripts", "session-start.mjs"), "--json"], isolatedEnv(ctxHome, { CT_CAPTURE: capture, ...extraEnv }));
    let ctx = null;
    try { ctx = JSON.parse(readFileSync(capture, "utf8")); } catch {}
    return { ctx, res, fakeRoot };
  };

  const base = captureLocalContext({});
  const ctx = base.ctx;
  if (!ctx) {
    fail("localcontext-keys", "没录到传给后端的 localContext：" + (base.res.stderr || "").trim().split(/\r?\n/)[0]);
  } else {
    const required = ["config", "cwd", "eventsFile", "schemaFile"];
    const missing = required.filter((k) => !(k in ctx));
    if (missing.length) fail("localcontext-keys", "localContext 缺键：" + missing.join(", ") + "（契约 1 要求 config/cwd/eventsFile/schemaFile）");
    else ok("localcontext-keys", required.join(", "));
    if (ctx.eventsFile === join(base.fakeRoot, "config", "events.jsonl")) ok("localcontext-events-file", "config/events.jsonl");
    else fail("localcontext-events-file", "eventsFile 不是插件根下的 config/events.jsonl：" + ctx.eventsFile);
    if (ctx.schemaFile === join(base.fakeRoot, "config", "plan-schema.json")) ok("localcontext-schema-file", "config/plan-schema.json");
    else fail("localcontext-schema-file", "schemaFile 不是插件根下的 config/plan-schema.json：" + ctx.schemaFile);
    if (ctx.config && ctx.config.roles) ok("localcontext-config", "config 是完整 team.json");
    else fail("localcontext-config", "config 不是完整的 team.json 对象");
    if (typeof ctx.cwd === "string" && ctx.cwd) ok("localcontext-cwd", ctx.cwd);
    else fail("localcontext-cwd", "cwd 不是字符串路径");
  }

  // 隔离开关：CODE_TEAM_EVENTS / CODE_TEAM_SCHEMA 与 codex-team.mjs 同一套。
  const ev = join(tempDir("evt"), "events.jsonl");
  const sc = join(tempDir("sch"), "plan-schema.json");
  const swapped = captureLocalContext({ CODE_TEAM_EVENTS: ev, CODE_TEAM_SCHEMA: sc }).ctx;
  if (swapped && swapped.eventsFile === ev) ok("isolate-events-file", "认 CODE_TEAM_EVENTS");
  else fail("isolate-events-file", "认不了 CODE_TEAM_EVENTS：" + (swapped ? swapped.eventsFile : "没录到 localContext"));
  if (swapped && swapped.schemaFile === sc) ok("isolate-schema-file", "认 CODE_TEAM_SCHEMA");
  else fail("isolate-schema-file", "认不了 CODE_TEAM_SCHEMA：" + (swapped ? swapped.schemaFile : "没录到 localContext"));
}

// --- 5b. CODE_TEAM_CONFIG：预检必须读替身配置，不是真实配置 ---
// 替身里把 provider.id 改掉，用它区分读到的是哪一份。真实 config/team.json 只读比对。
{
  const realPath = join(ROOT, "config", "team.json");
  const before = createHash("sha256").update(readFileSync(realPath)).digest("hex");
  const sub = JSON.parse(readFileSync(realPath, "utf8"));
  sub.provider = { ...(sub.provider ?? {}), id: "isolated-provider" };
  const subPath = join(tempDir("cfgswap"), "team.json");
  writeFileSync(subPath, JSON.stringify(sub, null, 2), "utf8");
  const res = runNode([SESSION_START, "--json"], isolatedEnv(fakeCodexHome("cfghost"), { CODE_TEAM_CONFIG: subPath }));
  let out = null;
  try { out = JSON.parse(res.stdout); } catch {}
  const providerDetail = ((out && out.checks) || []).map((c) => c.detail).find((d) => typeof d === "string" && d.startsWith("provider="));
  if (providerDetail === "provider=isolated-provider") ok("isolate-config", "认 CODE_TEAM_CONFIG，预检读的是替身配置");
  else fail("isolate-config", "设了 CODE_TEAM_CONFIG，预检仍读真实配置：" + providerDetail);
  const after = createHash("sha256").update(readFileSync(realPath)).digest("hex");
  if (before === after) ok("isolate-config-readonly", "真实 config/team.json 未被改动");
  else fail("isolate-config-readonly", "真实 config/team.json 被改动了");
}

// --- 6. 安装保全 ---
function fakeSource(tag) {
  // 造一个"开发机"的源目录：仓库的插件部分 + 本地运行时数据（旧版安装器会备份再还原它）。
  const dir = tempDir(tag);
  for (const part of ["scripts", "config", "skills", "checks", "references", "hooks", ".minimax-plugin", "plugin.json", "LICENSE"]) {
    const src = join(ROOT, part);
    if (!existsSync(src)) continue;
    cpSync(src, join(dir, part), { recursive: true });
  }
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "events.jsonl"), "{\"at\":\"2026-01-01T00:00:00.000Z\",\"kind\":\"call\"}\n", "utf8");
  return dir;
}

if (!existsSync(INSTALLER)) {
  fail("install", "缺少 scripts/install-plugin.mjs");
} else {
  // 5a. 全新安装：hook 与预检脚本必须进安装目录；事件流原本不存在就保持不存在
  const freshHome = tempDir("fresh");
  const freshRes = runNode([INSTALLER], isolatedEnv(freshHome));
  const freshDest = join(freshHome, ".minimax", "plugins", "code-team");
  if (freshRes.status !== 0) {
    fail("install-fresh", "安装失败：" + (freshRes.stderr || "").trim().split(/\r?\n/)[0]);
  } else {
    for (const f of ["hooks/hooks.json", "scripts/session-start.mjs", ".minimax-plugin/plugin.json", "icon.png", "icon-dark.png"]) {
      if (existsSync(join(freshDest, ...f.split("/")))) ok("install-fresh-has", f);
      else fail("install-fresh-has", "安装目录里没有 " + f + " → 装完的插件缺件");
    }
    if (!existsSync(join(freshDest, "config", "events.jsonl"))) ok("install-events-absent", "事件流原本不存在，安装后仍不存在");
    else fail("install-events-absent", "安装凭空造出了 config/events.jsonl");
  }

  // 5b. 覆盖更新：事件流逐字节不变、台账保留、角色选择保留并合并新默认值
  const updateHome = tempDir("update");
  const updateDest = join(updateHome, ".minimax", "plugins", "code-team");
  mkdirSync(join(updateDest, "config"), { recursive: true });
  const eventsText = "{\"at\":\"2026-01-02T00:00:00.000Z\",\"kind\":\"call\",\"note\":\"user data\"}\n";
  const eventsFile = join(updateDest, "config", "events.jsonl");
  writeFileSync(eventsFile, eventsText, "utf8");
  chmodSync(eventsFile, 0o444); // 安装器若改写它就会 EPERM 失败——并发追加的那一行正是这样丢的
  const lessonsText = "{\"lessons\":[{\"id\":\"L-001\",\"count\":2}]}\n";
  writeFileSync(join(updateDest, "config", "lessons.json"), lessonsText, "utf8");
  const teamText = JSON.stringify({
    roles: {
      overmind: { backend: "external-command", executable: "my-brain", model: "my/model" },
    },
  }, null, 2) + "\n";
  writeFileSync(join(updateDest, "config", "team.json"), teamText, "utf8");

  const src = fakeSource("src");
  const updateRes = runNode([join(src, "scripts", "install-plugin.mjs")], isolatedEnv(updateHome));
  if (updateRes.status !== 0) {
    fail("install-update", "覆盖安装失败：" + (updateRes.stderr || "").trim().split(/\r?\n/)[0] + " → 安装器动了运行时数据");
  } else {
    ok("install-update", "覆盖安装完成");
  }
  if (existsSync(eventsFile) && readFileSync(eventsFile, "utf8") === eventsText) ok("install-events-bytes", "事件流逐字节一致");
  else fail("install-events-bytes", "事件流被改写或丢失");
  const lessonsFile = join(updateDest, "config", "lessons.json");
  if (existsSync(lessonsFile) && readFileSync(lessonsFile, "utf8") === lessonsText) ok("install-lessons", "纠正台账保留");
  else fail("install-lessons", "纠正台账被覆盖");
  let team = null;
  try { team = JSON.parse(readFileSync(join(updateDest, "config", "team.json"), "utf8")); } catch (e) { fail("install-team-merge", "team.json 解析失败：" + e.message); }
  if (team) {
    const om = team.roles && team.roles.overmind ? team.roles.overmind : {};
    if (om.backend === "external-command" && om.executable === "my-brain" && om.model === "my/model") ok("install-team-keep", "既有角色选择保留");
    else fail("install-team-keep", "既有角色选择被覆盖：" + JSON.stringify(om));
    if (team.roles && team.roles.worker && team.roles.worker.model) ok("install-team-merge-default", "新默认角色已合并进来");
    else fail("install-team-merge-default", "新默认值没有合并进 roles.worker");
  }
  if (existsSync(join(updateDest, "hooks", "hooks.json"))) ok("install-update-has-hook", "更新后 hook 仍在安装目录");
  else fail("install-update-has-hook", "更新后安装目录里没有 hooks/hooks.json");
}

cleanup();

if (failures) {
  console.log("");
  console.log("FAIL bootstrap  — " + failures + " 项未通过");
  process.exit(1);
}
console.log("");
console.log("PASS bootstrap");
