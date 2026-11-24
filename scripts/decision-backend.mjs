#!/usr/bin/env node
// 决策调用的后端派发入口：codex-cli 与 external-command 共用同一套 describe/preflight/invoke。
//
// 为什么单独一个文件：换后端只改这一处。预算、事件、规划输出、续聊这些流程不该知道后端是谁。
// P1/P4 也从这里取后端能力定义，别处不要再写一份后端知识。
//
// 三个导出（字段名见 interfaces/contracts 契约 1）：
//   describe(role, roleConfig, localContext) -> { id, fields, resume, output }
//   preflight(role, roleConfig, localContext) -> { status, checks, nextStep }
//   invoke(request, localContext)             -> 调用结果
//
// 只有 invoke 有权发起模型请求。describe 与 preflight 只读本地信息，不启动任何外部程序。
//
// localContext 的键（缺省都有回退）：
//   config      完整的 team.json 对象
//   cwd         工作目录，默认 process.cwd()
//   eventsFile  事件流路径，用来确认本地记录过的线程
//   schemaFile  规划输出 schema 路径
//   codexEntry  codex 的 JS 入口，默认按 APPDATA 推导
//   modelsFile  模型目录证据文件，默认 ~/.codex/models_cache.json
//   timeoutMs   单次调用超时（毫秒），缺省不设
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { readEvents } from "./record-event.mjs";

export const BACKENDS = ["codex-cli", "external-command"];
export const CODEX_BACKEND = "codex-cli";
export const EXTERNAL_BACKEND = "external-command";

const MODEL_PLACEHOLDER = "{model}";
const EFFORT_PLACEHOLDER = "{effort}";

// 契约 2 定的缺省值：新装机器上没配模型时按这两个走。
export const DEFAULT_MODELS = { overmind: "gpt-6.2-astra", coder: "gpt-6.2-sol" };
export const DEFAULT_EFFORT = "medium";

// Windows 上 .cmd/.bat 必须经 shell 才能跑，本项目不经 shell，所以不在支持域。
const WINDOWS_SHELL_ONLY = [".cmd", ".bat"];

// 事件与错误摘要里不许出现的东西：密钥、令牌、口令。stdout/stderr 只留脱敏后的短摘要。
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[=:]\s*\S+/gi,
];

export function sanitize(text, limit = 200) {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > limit ? out.slice(0, limit) + "…" : out;
}

// 缺省是 codex-cli；写了不认识的后端就原样报出去，不静默换后端。
function backendOf(roleConfig) {
  const b = roleConfig?.backend;
  if (b === undefined || b === null || b === "") return CODEX_BACKEND;
  return String(b);
}

function codexHome(localContext) {
  if (localContext.codexHome) return localContext.codexHome;
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  const home = process.env.USERPROFILE || process.env.HOME;
  return home ? join(home, ".codex") : null;
}

// 模型目录证据：本机 codex 写的缓存。读不到就报"能力未知"，不猜。
function codexModels(localContext) {
  const file = localContext.modelsFile ?? (codexHome(localContext) ? join(codexHome(localContext), "models_cache.json") : null);
  if (!file) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const models = Array.isArray(data.models) ? data.models : [];
    return models
      .filter((m) => m && typeof m.slug === "string" && m.visibility !== "hide")
      .map((m) => ({
        slug: m.slug,
        efforts: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
          .map((l) => l?.effort)
          .filter(Boolean),
      }));
  } catch {
    return [];
  }
}

function effortValuesFor(models, model) {
  const hit = models.find((m) => m.slug === model);
  return hit && hit.efforts.length ? hit.efforts : null;
}

function resolveCodexEntry(localContext) {
  if (localContext.codexEntry) return existsSync(localContext.codexEntry) ? localContext.codexEntry : null;
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const candidate = join(appdata, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  return existsSync(candidate) ? candidate : null;
}

// 用自定义 provider 覆盖内置 openai（内置 provider 不允许被覆盖，只能另起一个 id）。
// supports_websockets=false 是关键：它让 codex 跳过 WebSocket 直连，不再空转 120 秒。
function providerArgs(cfg) {
  const p = cfg?.provider;
  if (!p?.id) return [];
  return [
    "-c", `model_provider="${p.id}"`,
    "-c", `model_providers.${p.id}.name="${p.name}"`,
    "-c", `model_providers.${p.id}.base_url="${p.base_url}"`,
    "-c", `model_providers.${p.id}.wire_api="${p.wire_api}"`,
    "-c", `model_providers.${p.id}.requires_openai_auth=true`,
    "-c", `model_providers.${p.id}.supports_websockets=false`,
  ];
}

// 不经 shell 解析可执行入口：绝对路径直接查，裸名字按 PATH 逐个目录找。
function resolveExecutable(executable, cwd) {
  const name = String(executable).trim();
  if (!name) return { ok: false, reason: "executable 为空" };
  const ext = extname(name).toLowerCase();
  if (WINDOWS_SHELL_ONLY.includes(ext)) {
    return { ok: false, reason: `${name} 需要经 shell 启动，不在本项目的支持域` };
  }
  if (name.includes("/") || name.includes("\\")) {
    const full = isAbsolute(name) ? name : resolve(cwd || process.cwd(), name);
    return existsSync(full) ? { ok: true, path: full, prefix: [] } : { ok: false, reason: `找不到 ${full}` };
  }
  const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of pathDirs) {
    for (const e of exts) {
      const candidate = join(dir, name + e.toLowerCase());
      if (!existsSync(candidate)) continue;
      if (WINDOWS_SHELL_ONLY.includes(extname(candidate).toLowerCase())) {
        return { ok: false, reason: `${candidate} 需要经 shell 启动，不在本项目的支持域` };
      }
      return { ok: true, path: candidate, prefix: [] };
    }
  }
  return { ok: false, reason: `PATH 里找不到 ${name}` };
}

// 续问标识：绑定提供方、后端与角色。
// 不绑文件系统路径——同一个线程换个目录续问是常态，绑路径会把正常续问全部拒掉。
export function targetKey(role, roleConfig, localContext = {}) {
  const providerId = localContext.config?.provider?.id ?? "default";
  return createHash("sha256")
    .update([providerId, backendOf(roleConfig), String(role)].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

function placeholderSupported(args, placeholder) {
  return (Array.isArray(args) ? args : []).some((a) => a === placeholder);
}

function describeCodex(role, roleConfig, localContext) {
  const models = codexModels(localContext);
  const model = roleConfig?.model ?? DEFAULT_MODELS[role] ?? null;
  return {
    id: CODEX_BACKEND,
    fields: {
      model: {
        type: "string",
        state: "supported",
        nullable: false,
        required: true,
        default: DEFAULT_MODELS[role] ?? null,
        values: models.length ? models.map((m) => m.slug) : null,
      },
      effort: {
        type: "string",
        state: "supported",
        nullable: false,
        required: true,
        default: DEFAULT_EFFORT,
        values: effortValuesFor(models, model),
      },
    },
    resume: "thread-id",
    output: "codex-jsonl",
  };
}

function describeExternal(roleConfig) {
  const args = Array.isArray(roleConfig?.args) ? roleConfig.args : [];
  const modelOk = placeholderSupported(args, MODEL_PLACEHOLDER);
  const effortOk = placeholderSupported(args, EFFORT_PLACEHOLDER);
  return {
    id: EXTERNAL_BACKEND,
    fields: {
      executable: {
        type: "string",
        state: "supported",
        nullable: false,
        required: true,
        default: null,
        values: null,
      },
      args: {
        type: "string[]",
        state: "supported",
        nullable: false,
        required: false,
        default: [],
        values: null,
      },
      model: {
        type: "string",
        state: modelOk ? "supported" : "unsupported",
        nullable: true,
        required: false,
        default: null,
        values: null,
      },
      effort: {
        type: "string",
        state: effortOk ? "supported" : "unsupported",
        nullable: true,
        required: false,
        default: null,
        values: null,
      },
    },
    resume: "none",
    output: "text",
  };
}

export function describe(role, roleConfig = {}, localContext = {}) {
  const backend = backendOf(roleConfig);
  if (backend === EXTERNAL_BACKEND) return describeExternal(roleConfig);
  if (backend === CODEX_BACKEND) return describeCodex(role, roleConfig, localContext);
  return { id: backend, fields: {}, resume: "none", output: "text" };
}

function preflightCodex(roleConfig, localContext) {
  const checks = [];
  const cfg = localContext.config ?? null;
  // 没拿到配置就是"本地判不了"，不是"坏了"——别把调用方的正常路径判成阻塞。
  const providerOk = Boolean(cfg?.provider?.id);
  checks.push({
    id: "config",
    status: cfg === null ? "unknown" : providerOk ? "ok" : "blocked",
    detail: cfg === null ? "没拿到配置，本地判不了 provider" : providerOk ? `provider=${cfg.provider.id}` : "team.json 里没有 provider 配置",
  });
  const cwd = localContext.cwd ?? process.cwd();
  checks.push({
    id: "cwd",
    status: existsSync(cwd) ? "ok" : "blocked",
    detail: cwd,
  });
  const entry = resolveCodexEntry(localContext);
  checks.push({
    id: "executable",
    status: entry ? "ok" : "blocked",
    detail: entry ?? "找不到 codex 的 JS 入口",
  });
  const blocked = checks.find((c) => c.status === "blocked");
  const unknown = checks.some((c) => c.status === "unknown");
  return {
    status: blocked ? "blocked" : unknown ? "unknown" : "ready",
    checks,
    nextStep: blocked
      ? {
          text:
            blocked.id === "executable"
              ? "安装或修复 codex CLI：npm install -g @openai/codex"
              : `先修好 ${blocked.id}：${blocked.detail}`,
          command:
            blocked.id === "executable"
              ? { executable: "npm", args: ["install", "-g", "@openai/codex"] }
              : null,
        }
      : null,
  };
}

function preflightExternal(roleConfig, localContext) {
  const checks = [];
  const cwd = localContext.cwd ?? process.cwd();
  const executable = roleConfig?.executable;
  const executableOk = typeof executable === "string" && executable.trim() !== "";
  checks.push({
    id: "config",
    status: executableOk ? "ok" : "blocked",
    detail: executableOk ? executable : "roles.<角色>.executable 没填",
  });
  const args = Array.isArray(roleConfig?.args) ? roleConfig.args : [];
  const argsOk = args.every((a) => typeof a === "string" && !a.includes("\u0000"));
  checks.push({
    id: "args",
    status: argsOk ? "ok" : "blocked",
    detail: argsOk ? `${args.length} 个参数` : "args 里有非字符串项或含 NUL",
  });
  const resolved = executableOk ? resolveExecutable(executable, cwd) : { ok: false, reason: "executable 没填" };
  checks.push({
    id: "executable",
    status: resolved.ok ? "ok" : "blocked",
    detail: resolved.ok ? resolved.path : resolved.reason,
  });
  const model = roleConfig?.model;
  const effort = roleConfig?.effort;
  const modelNeeded = placeholderSupported(args, MODEL_PLACEHOLDER);
  const effortNeeded = placeholderSupported(args, EFFORT_PLACEHOLDER);
  checks.push({
    id: "placeholders",
    status: (modelNeeded && !model) || (effortNeeded && !effort) ? "blocked" : "ok",
    detail:
      (modelNeeded && !model) || (effortNeeded && !effort)
        ? "args 里的占位符没有对应取值"
        : `model=${model ?? "null"} effort=${effort ?? "null"}`,
  });
  checks.push({ id: "cwd", status: existsSync(cwd) ? "ok" : "blocked", detail: cwd });
  const blocked = checks.find((c) => c.status === "blocked");
  return {
    status: blocked ? "blocked" : "ready",
    checks,
    nextStep: blocked
      ? {
          text:
            blocked.id === "executable"
              ? `把 roles.<角色>.executable 改成能不经 shell 启动的程序`
              : `先修好 ${blocked.id}：${blocked.detail}`,
          command: null,
        }
      : null,
  };
}

export function preflight(role, roleConfig = {}, localContext = {}) {
  const backend = backendOf(roleConfig);
  if (backend === EXTERNAL_BACKEND) return preflightExternal(roleConfig, localContext);
  if (backend === CODEX_BACKEND) return preflightCodex(roleConfig, localContext);
  return {
    status: "blocked",
    checks: [{ id: "backend", status: "blocked", detail: `后端 ${backend} 不可用` }],
    nextStep: { text: `把角色的 backend 改成 ${BACKENDS.join(" 或 ")}`, command: null },
  };
}

function baseResult(invocationId, backend) {
  return {
    invocationId,
    backend,
    ok: false,
    callMode: null,
    text: null,
    continuation: null,
    exitCode: null,
    usage: null,
    reportedModel: null,
    reportedEffort: null,
    error: null,
  };
}

// 本地事件流里找这个线程的确认记录。没有记录就不算"先前确认过的线程"。
function findThreadRecord(localContext, threadId) {
  if (!threadId) return null;
  const file = localContext.eventsFile;
  if (!file) return null;
  let events = [];
  try {
    events = readEvents(file);
  } catch {
    return null;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const recorded = e.threadId ?? (typeof e.note === "string" && e.note.startsWith("thread:") ? e.note.slice(7) : null);
    if (recorded && recorded === threadId) {
      return {
        backend: e.backend ?? null,
        role: e.role ?? null,
        targetKey: e.continuation?.targetKey ?? null,
        threadId: recorded,
      };
    }
  }
  return null;
}

function invokeCodex(base, request, localContext) {
  const cfg = localContext.config ?? {};
  const roleConfig = request.roleConfig ?? {};
  const model = roleConfig.model ?? null;
  const effort = roleConfig.effort ?? null;
  if (!cfg.provider?.id) {
    return { ...base, error: { code: "INVALID_CONFIG", message: "team.json 里没有 provider 配置" } };
  }
  if (!model || !effort) {
    return { ...base, error: { code: "INVALID_CONFIG", message: "codex-cli 后端必须配置 model 与 effort" } };
  }
  const entry = resolveCodexEntry(localContext);
  if (!entry) {
    return {
      ...base,
      error: { code: "PREFLIGHT_BLOCKED", message: "找不到 codex 的 JS 入口（预期 node_modules/@openai/codex/bin/codex.js）" },
    };
  }

  let callMode = "new";
  let requestedThread = null;
  const continuation = request.continuation ?? null;
  if (continuation) {
    requestedThread = continuation.threadId ?? null;
    const record = findThreadRecord(localContext, requestedThread);
    if (!record) {
      return {
        ...base,
        error: { code: "RESUME_MISMATCH", message: `本地事件流里没有线程 ${requestedThread} 的确认记录` },
      };
    }
    if (continuation.backend && continuation.backend !== CODEX_BACKEND) {
      return { ...base, error: { code: "RESUME_MISMATCH", message: "续问句柄的后端与当前后端不一致" } };
    }
    if (continuation.role && continuation.role !== request.role) {
      return { ...base, error: { code: "RESUME_MISMATCH", message: "续问句柄的角色与当前角色不一致" } };
    }
    if (record.backend && record.backend !== CODEX_BACKEND) {
      return { ...base, error: { code: "RESUME_MISMATCH", message: "该线程不是当前后端产生的" } };
    }
    if (record.role && record.role !== request.role) {
      return { ...base, error: { code: "RESUME_MISMATCH", message: "该线程属于别的角色" } };
    }
    const expectedKey = targetKey(request.role, roleConfig, localContext);
    // 老事件没有记 targetKey，那条记录没法校验，只能放行；新事件一律比。
    if (record.targetKey && record.targetKey !== expectedKey) {
      return { ...base, error: { code: "RESUME_MISMATCH", message: "提供方或后端换过了，旧线程不能续" } };
    }
    if (continuation.targetKey && continuation.targetKey !== expectedKey) {
      return { ...base, error: { code: "RESUME_MISMATCH", message: "续问句柄与当前提供方不匹配" } };
    }
    callMode = "resume";
  }

  const globalArgs = [...providerArgs(cfg), "-m", model, "-c", `model_reasoning_effort="${effort}"`];
  const execArgs = ["--skip-git-repo-check", "--json"];
  const cwd = request.cwd ?? localContext.cwd ?? null;
  if (callMode === "new") {
    execArgs.unshift("--sandbox", "read-only");
    if (cwd) execArgs.push("-C", String(cwd));
  }
  if (!request.plain && localContext.schemaFile && existsSync(localContext.schemaFile)) {
    execArgs.push("--output-schema", localContext.schemaFile);
  }

  // 整个 prompt 走 stdin，Codex 侧用 "-" 明确表示从标准输入读。
  const cmd = callMode === "resume"
    ? ["exec", "resume", ...globalArgs, ...execArgs, requestedThread, "-"]
    : ["exec", ...globalArgs, ...execArgs, "-"];

  const started = Date.now();
  const res = spawnSync(process.execPath, [entry, ...cmd], {
    input: request.prompt ?? "",
    encoding: "utf8",
    cwd: cwd ?? undefined,
    maxBuffer: 64 * 1024 * 1024,
    timeout: localContext.timeoutMs ?? undefined,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";

  let usage = null;
  let threadId = null;
  let reportedModel = null;
  let lastMessage = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === "thread.started") threadId = evt.thread_id;
    if (evt.type === "turn.completed") usage = evt.usage;
    if (evt.type === "item.completed" && evt.item?.type === "agent_message") lastMessage = evt.item.text;
    if (typeof evt.model === "string") reportedModel = evt.model;
  }

  if (res.error) {
    const timedOut = res.error.code === "ETIMEDOUT";
    return {
      ...base,
      exitCode: res.status ?? null,
      elapsedSec: Number(elapsed),
      error: {
        code: timedOut ? "TIMEOUT" : "SPAWN_FAILED",
        message: sanitize(res.error.message),
      },
    };
  }
  if (res.status !== 0) {
    return {
      ...base,
      exitCode: res.status ?? null,
      elapsedSec: Number(elapsed),
      usage,
      reportedModel,
      error: { code: "NONZERO_EXIT", message: sanitize(stderr || `退出码 ${res.status}`) },
    };
  }

  // 续问要等输出里的线程 ID 与请求的一致，才算真的续上了同一线程。
  let confirmedCallMode = callMode;
  if (callMode === "resume" && threadId !== requestedThread) confirmedCallMode = null;
  const continuationOut = threadId
    ? {
        backend: CODEX_BACKEND,
        role: request.role ?? null,
        threadId,
        targetKey: targetKey(request.role, roleConfig, localContext),
      }
    : null;

  return {
    ...base,
    ok: true,
    callMode: confirmedCallMode,
    text: lastMessage || stdout || null,
    continuation: continuationOut,
    exitCode: res.status ?? null,
    usage,
    reportedModel,
    reportedEffort: null,
    elapsedSec: Number(elapsed),
  };
}

function invokeExternal(base, request, localContext) {
  const roleConfig = request.roleConfig ?? {};
  const cwd = request.cwd ?? localContext.cwd ?? process.cwd();
  const executable = roleConfig.executable;
  if (typeof executable !== "string" || executable.trim() === "") {
    return { ...base, error: { code: "INVALID_CONFIG", message: "external-command 后端必须配置 executable" } };
  }
  // 续问红线：v1 不支持续问，收到句柄就报，绝不启动进程，也绝不失败后自动重开。
  if (request.continuation) {
    return {
      ...base,
      error: {
        code: "RESUME_UNSUPPORTED",
        message: "external-command v1 不支持续问；请带完整上下文重新发起一次新调用",
      },
    };
  }
  const args = Array.isArray(roleConfig.args) ? roleConfig.args : [];
  const model = roleConfig.model ?? null;
  const effort = roleConfig.effort ?? null;
  const resolvedArgs = [];
  for (const a of args) {
    if (a === MODEL_PLACEHOLDER) {
      if (!model) return { ...base, error: { code: "INVALID_CONFIG", message: "args 里有 {model}，但 model 没设值" } };
      resolvedArgs.push(model);
    } else if (a === EFFORT_PLACEHOLDER) {
      if (!effort) return { ...base, error: { code: "INVALID_CONFIG", message: "args 里有 {effort}，但 effort 没设值" } };
      resolvedArgs.push(effort);
    } else {
      resolvedArgs.push(String(a));
    }
  }
  const exe = resolveExecutable(executable, cwd);
  if (!exe.ok) {
    return { ...base, error: { code: "PREFLIGHT_BLOCKED", message: sanitize(exe.reason) } };
  }

  const started = Date.now();
  const res = spawnSync(exe.path, [...exe.prefix, ...resolvedArgs], {
    input: request.prompt ?? "",
    encoding: "utf8",
    cwd,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    timeout: localContext.timeoutMs ?? undefined,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";

  if (res.error) {
    const timedOut = res.error.code === "ETIMEDOUT";
    return {
      ...base,
      exitCode: res.status ?? null,
      elapsedSec: Number(elapsed),
      error: { code: timedOut ? "TIMEOUT" : "SPAWN_FAILED", message: sanitize(res.error.message) },
    };
  }
  if (res.status !== 0) {
    return {
      ...base,
      exitCode: res.status ?? null,
      elapsedSec: Number(elapsed),
      error: { code: "NONZERO_EXIT", message: sanitize(stderr || `退出码 ${res.status}`) },
    };
  }
  if (stdout.trim() === "") {
    return {
      ...base,
      exitCode: res.status ?? null,
      elapsedSec: Number(elapsed),
      error: { code: "INVALID_OUTPUT", message: "命令退出码 0，但 stdout 是空的" },
    };
  }

  // 外部命令自己决定用什么模型；只有真的把占位符替成了值，才敢说模型已知。
  const reportedModel = placeholderSupported(args, MODEL_PLACEHOLDER) ? model : null;
  const reportedEffort = placeholderSupported(args, EFFORT_PLACEHOLDER) ? effort : null;
  return {
    ...base,
    ok: true,
    callMode: "new",
    text: stdout,
    continuation: null,
    exitCode: res.status ?? null,
    usage: null,
    reportedModel,
    reportedEffort,
    elapsedSec: Number(elapsed),
  };
}

export function invoke(request = {}, localContext = {}) {
  const backend = backendOf(request.roleConfig ?? {});
  const base = baseResult(request.invocationId ?? null, backend);
  if (backend === CODEX_BACKEND) return invokeCodex(base, request, localContext);
  if (backend === EXTERNAL_BACKEND) return invokeExternal(base, request, localContext);
  return { ...base, error: { code: "INVALID_CONFIG", message: `不支持的后端：${backend}` } };
}
