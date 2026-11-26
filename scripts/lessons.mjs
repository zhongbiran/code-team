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
//   node scripts/lessons.mjs check                   跑所有已升级的检查
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(ROOT, "config", "lessons.json");
const CHECKS_DIR = join(ROOT, "checks");
// 派工闸门：编译闸 + 文件归属互斥。宿主 hook 才是硬闸（见 scripts/dispatch-hook.mjs），
// 这里跑的是同一条规则的脚本入口，方便 CI 与手工核对。
const GATE_CHECKS = ["brief-requires-compile-gate.mjs", "brief-file-ownership-disjoint.mjs"];
const PROMOTE_AT = 2;   // 同一条纠正出现几次就该升级成检查

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

function runCheck(label, scriptArgs) {
  const res = spawnSync(process.execPath, scriptArgs, { encoding: "utf8" });
  const out = (res.stdout || "") + (res.stderr || "");
  const skipped = /^SKIP/m.test(out.trim());
  if (res.status === 0) {
    console.log(`${skipped ? "SKIP" : "PASS"} ${label}`);
    if (skipped && out.trim()) console.log(out.trim().split("\n").map((line) => "      " + line).join("\n"));
    return 0;
  }
  console.log(`FAIL ${label}`);
  if (out.trim()) console.log(out.trim().split("\n").map((line) => "      " + line).join("\n"));
  return 1;
}

function cmdCheck(args) {
  const ledger = loadLedger();
  const promoted = ledger.lessons.filter((l) => l.promoted);
  let failed = 0;
  if (!promoted.length) {
    console.log("还没有已升级的检查。");
  }
  for (const l of promoted) {
    const file = join(CHECKS_DIR, l.promoted);
    if (!existsSync(file)) {
      console.log(`FAIL ${l.id}  检查脚本缺失: ${l.promoted}`);
      failed++;
      continue;
    }
    failed += runCheck(`${l.id}  ${l.promoted}`, [file]);
  }
  // 派工闸门：可以带 --briefs <目录> --project <根目录> 指本轮样本
  for (const name of GATE_CHECKS) {
    const scriptArgs = [join(CHECKS_DIR, name)];
    if (args.briefs) scriptArgs.push("--briefs", args.briefs);
    if (args.project) scriptArgs.push("--project", args.project);
    failed += runCheck("gate  " + name, scriptArgs);
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
  default:
    console.log("用法:");
    console.log('  lessons.mjs record "<纠正内容>"');
    console.log("  lessons.mjs list");
    console.log('  lessons.mjs promote <ID> "<检查脚本名>" "<描述>"');
    console.log("  lessons.mjs check [--briefs <目录>] [--project <根目录>]");
    process.exit(args._[0] ? 2 : 0);
}
