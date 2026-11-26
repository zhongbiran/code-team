#!/usr/bin/env node
// Code Team 的经验台账：把重复出现的纠正，变成会自己跑的检查。
//
// 为什么要有这个：同一条纠正出现两次，就是我们的错。记在脑子里的话下次会话还会被跳过。
// 所以把它写成 checks/ 下的一行检查，让它自己失败、自己提醒。
//
// 用法：
//   node scripts/lessons.mjs record "<纠正内容>"   记录一次纠正
//   node scripts/lessons.mjs list                    列出台账，标出该升级的
//   node scripts/lessons.mjs promote <ID> "<检查脚本名>" "<检查描述>"
//   node scripts/lessons.mjs check                   跑随包检查 + 台账已升级的检查
//   node scripts/lessons.mjs check --briefs <目录> [--project <根目录>]
//                                                       用本轮 brief 样本跑编译闸 / 归属闸
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(ROOT, "config", "lessons.json");
const CHECKS_DIR = join(ROOT, "checks");
const PROMOTE_AT = 2;   // 同一条纠正出现几次就该升级成检查
const DEPTH_ENV = "CODE_TEAM_CHECK_DEPTH";   // 递归调用守卫

// 随包发布的检查：checks/ 下的每个 .mjs 都是必跑项。
// 台账里已升级的检查也合并进来，重复的只跑一次。
function bundledChecks() {
  try {
    return readdirSync(CHECKS_DIR).filter((n) => n.endsWith(".mjs")).sort();
  } catch {
    return [];
  }
}

// 接受 brief 参数的检查：编译闸与文件归属互斥闸要看本轮 brief 样本。
const BRIEF_CHECKS = ["brief-requires-compile-gate.mjs", "brief-file-ownership-disjoint.mjs"];

function checkPlan(ledger) {
  const plan = [];
  const seen = new Set();
  const add = (name, lesson) => {
    if (seen.has(name)) return;
    seen.add(name);
    plan.push({ name, lesson: lesson || null });
  };
  for (const n of bundledChecks()) add(n);
  for (const l of ledger.lessons.filter((x) => x.promoted)) add(l.promoted, l);
  return plan;
}

function loadLedger() {
  if (!existsSync(LEDGER)) return { lessons: [] };
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch {
    return { lessons: [] };
  }
}

function saveLedger(ledger) {
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

// 用内容做 key：措辞不同但意思相同的纠正也能归到一起，所以先做归一化。
function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[。，,.!！?？;；:：]/g, "");
}

function cmdRecord(args) {
  const text = args._[1];
  if (!text) {
    console.error('用法: lessons.mjs record "<纠正内容>"');
    process.exit(2);
  }
  const ledger = loadLedger();
  const key = normalize(text);
  let lesson = ledger.lessons.find((l) => l.key === key);
  if (lesson) {
    lesson.count += 1;
    lesson.lastSeen = new Date().toISOString();
    if (!lesson.history.includes(text)) lesson.history.push(text);
  } else {
    lesson = {
      id: "L-" + String(ledger.lessons.length + 1).padStart(3, "0"),
      key,
      text,
      count: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      history: [text],
      promoted: null,
    };
    ledger.lessons.push(lesson);
  }
  saveLedger(ledger);
  const ready = lesson.count >= PROMOTE_AT && !lesson.promoted;
  console.log(`${lesson.id} 已记录第 ${lesson.count} 次${ready ? " —— 已达升级门槛，请 promote" : ""}`);
}

function cmdList() {
  const ledger = loadLedger();
  if (!ledger.lessons.length) {
    console.log("台账为空：还没有记录过纠正。");
    return;
  }
  console.log("纠正台账（升级门槛：同一条出现 " + PROMOTE_AT + " 次）\n");
  for (const l of ledger.lessons) {
    const mark = l.promoted ? "[已升级] " : l.count >= PROMOTE_AT ? "[待升级] " : "          ";
    console.log(`${mark}${l.id} ×${l.count}  ${l.text}`);
    if (l.promoted) console.log(`           → ${l.promoted}`);
  }
  const pending = ledger.lessons.filter((l) => l.count >= PROMOTE_AT && !l.promoted);
  console.log("\n" + (pending.length ? `待升级 ${pending.length} 条：` + pending.map((l) => l.id).join(", ") : "没有待升级的条目。"));
}

function cmdPromote(args) {
  const id = args._[1];
  const checkName = args._[2];
  const desc = args._[3] || "";
  if (!id || !checkName) {
    console.error('用法: lessons.mjs promote <ID> "<检查脚本名>" "<检查描述>"');
    process.exit(2);
  }
  const ledger = loadLedger();
  const lesson = ledger.lessons.find((l) => l.id === id);
  if (!lesson) {
    console.error("找不到 " + id);
    process.exit(2);
  }
  if (lesson.count < PROMOTE_AT) {
    console.error(`${id} 只出现 ${lesson.count} 次，不到升级门槛 ${PROMOTE_AT} 次。`);
    process.exit(2);
  }
  mkdirSync(CHECKS_DIR, { recursive: true });
  const file = join(CHECKS_DIR, checkName);
  if (!existsSync(file)) {
    console.error("检查脚本不存在: " + file + "\n先写这个脚本，它必须能在旧现场失败、在当前代码通过。");
    process.exit(2);
  }
  lesson.promoted = checkName;
  lesson.promotedAt = new Date().toISOString();
  lesson.promotedDesc = desc;
  saveLedger(ledger);
  console.log(`${id} 已升级为检查: checks/${checkName}`);
}

function cmdListChecks() {
  const ledger = loadLedger();
  for (const item of checkPlan(ledger)) console.log(item.name);
}

function cmdCheck(args) {
  // 递归守卫：检查脚本再调总入口就是无限递归，直接拒掉。
  if (process.env[DEPTH_ENV]) {
    console.error(`检测到检查入口的递归调用（${DEPTH_ENV} 已设置）——检查脚本不许再跑总入口。`);
    process.exit(2);
  }
  const ledger = loadLedger();
  const plan = checkPlan(ledger);
  if (!plan.length) {
    console.error("checks/ 下没有检查脚本 —— 发布检查没有把关项。");
    process.exit(1);
  }
  let failed = 0;
  for (const item of plan) {
    const file = join(CHECKS_DIR, item.name);
    const tag = item.lesson ? item.lesson.id : item.name;
    if (!existsSync(file)) {
      console.log(`FAIL ${tag}  检查脚本缺失: ${item.name}`);
      failed++;
      continue;
    }
    // brief 参数透传：编译闸与归属闸要看本轮样本。
    const scriptArgs = [file];
    if (BRIEF_CHECKS.includes(item.name)) {
      if (args.briefs) scriptArgs.push("--briefs", args.briefs);
      if (args.project) scriptArgs.push("--project", args.project);
    }
    const res = spawnSync(process.execPath, scriptArgs, {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, [DEPTH_ENV]: "1" },
    });
    const out = (res.stdout || "") + (res.stderr || "");
    const skipped = /^SKIP/m.test(out.trim());
    if (res.status === 0) {
      console.log(`${skipped ? "SKIP" : "PASS"} ${tag}  ${item.name}`);
      if (skipped && out.trim()) console.log(out.trim().split("\n").map((line) => "      " + line).join("\n"));
    } else {
      failed++;
      console.log(`FAIL ${tag}  ${item.name}`);
      if (out.trim()) console.log(out.trim().split("\n").map((line) => "      " + line).join("\n"));
    }
  }
  console.log("\n" + (failed ? `${failed} 条检查未通过` : "全部检查通过"));
  process.exit(failed ? 1 : 0);
}

const argv = process.argv.slice(2);
const args = { _: argv };
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith("--")) args[k] = true;
    else { args[k] = n; i++; }
  }
}

switch (args._[0]) {
  case "record": cmdRecord(args); break;
  case "list": cmdList(); break;
  case "promote": cmdPromote(args); break;
  case "check": cmdCheck(args); break;
  case "list-checks": cmdListChecks(); break;
  default:
    console.log("用法:");
    console.log('  lessons.mjs record "<纠正内容>"');
    console.log("  lessons.mjs list");
    console.log('  lessons.mjs promote <ID> "<检查脚本名>" "<描述>"');
    console.log("  lessons.mjs check [--briefs <目录>] [--project <根目录>]");
    console.log("  lessons.mjs list-checks");
    process.exit(args._[0] ? 2 : 0);
}
