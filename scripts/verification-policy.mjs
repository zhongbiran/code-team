#!/usr/bin/env node
// Code Team 的一次性验收策略 —— 同一验收口径下，Verifier 实际只能启动一次。
//
// 为什么存在（2026-11-25 复盘 §四根因 C / §五第 5 条）：
// 用户 11-23 已明确纠正「验收只做一次」，但实际派了两轮 Verifier
// （"独立验收九包" + "复验 P11 五项"）。SKILL.md 里写着「验收（只做一次）」，
// 那只是文字，没有任何机器判定 —— 复盘里第二轮照样派了出去。
//
// 判定口径（照抄 Coder 对事故的取证，不改写）：
//   1. 验收键 = (projectKey, planId, criteriaRevisionId)。
//      普通补丁、plan 内容修订都继续用同一个验收键 —— 不重置次数。
//   2. 一轮 = (projectKey, criteriaRevisionId)：planId 不是口径，
//      换 planId 仍是同一轮，不重置名额。
//   3. 全部包完成后只预留一次；实际启动即占用（reserved → started → result）。
//   4. 首轮 FAIL 之后不派第二轮 Verifier，由执行者按原失败命令自证
//      （recordSelfEvidence），自证记录挂在同一条验收记录上。
//   5. 唯一例外：验收口径实质变更。必须带 Overmind 给出的旧/新口径文本、具体差异、
//      批准人，并引用一个已有的验收键；只改口径 ID 不算实质变更。
//   6. 整批完成的判断基于已发布计划的预期包集合（D 的 listPublishedPackages）；
//      **取不到预期集合 ⇒ 拒签**（没有发布清单就不许整体验收）。
//   7. 包「完成」必须有终结成功证据：**预留 / 运行中 / 失败都不算完成**。
//   8. 验收结果必须有证据引用；空引用视为无效结果，不得记成通过。
//   9. 状态严格读取：解析失败 / 缺字段 / 版本不认识 ⇒ 拒签（不是当空状态）。
//  10. 自证用**原始**退出码与**原始**提交号：null 退出码、空白提交号 ⇒ accepted:false。
//
// 宿主接线（A）：
//   - 预期包集合：D 的 listPublishedPackages({ planRevisionId })，或直接给 expectedPackages。
//   - 包完成证据：packageStates / completedPackages 里给**带终结状态的对象**：
//       { packageId, status, attemptId?, outcome?, evidenceRefs? }
//     纯字符串条目（旧的「已预留包号」写法）**不算完成证据**。
//   - 状态：decision.nextState 持久化（saveVerificationState）或直接用
//     decideAndPersistVerification({ stateFile, request })（锁内读改写）。
//   - Task prompt 里带标记，便于 A 取出口径键：
//     code-team-verification-key: {"projectKey":"...","planId":"...","criteriaRevisionId":"...","criteriaChange":{...}}
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const VERIFICATION_STATE_VERSION = 1;

// 验收记录允许的状态。状态文件里出现别的值 = 状态不可信 ⇒ 拒签。
const RECORD_STATUSES = new Set(["reserved", "started", "passed", "failed"]);
// 终结成功才算「完成」。reserved / running / failed 都不在里面。
const STATUS_SUCCESS = new Set([
  "completed", "complete", "passed", "pass", "succeeded", "success", "done", "finished", "ok",
]);
// 空白与占位不算内容。
const PLACEHOLDERS = new Set([
  "n/a", "na", "none", "null", "nil", "unknown", "-", "--", "?", "todo", "tbd",
  "无", "没有", "待定", "占位", "xxx",
]);

// 预期包集合的提供者：优先用宿主注入的替身/真实实现，否则用 D 的 listPublishedPackages。
let publishedPackagesProvider = null;

/** 注入预期包集合的提供者（签名 ({ planRevisionId }) => 包标识数组）。D 落地前的替身也走这里。 */
export function setPublishedPackagesProvider(fn) {
  publishedPackagesProvider = typeof fn === "function" ? fn : null;
}

// D 包提供 listPublishedPackages；还没落地时下面保持 null，宿主给 expectedPackages 兜底。
let listPublishedPackages = null;
try {
  const d = await import("./codex-team.mjs");
  if (typeof d.listPublishedPackages === "function") listPublishedPackages = d.listPublishedPackages;
} catch {
  /* D 还没提供 listPublishedPackages：预期包集合由宿主注入或随请求给出 */
}

// Task prompt 里标记验收口径键用的写法（A 接线时按这个取）。
export const VERIFICATION_MARKER_RE = /code-team-verification-key:[ \t]*(\{[^\n]*\})/i;

/** 从 Task prompt 里解析验收口径标记；解析不出来返回 null（不猜）。 */
export function parseVerificationMarker(prompt) {
  const m = VERIFICATION_MARKER_RE.exec(String(prompt || ""));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** 验收键 = (projectKey, planId, criteriaRevisionId)。 */
export function verificationKeyOf({ projectKey, planId, criteriaRevisionId } = {}) {
  return [projectKey ?? "", planId ?? "", criteriaRevisionId ?? ""].join("::");
}

/** 从验收键里解析口径版本（最后一段）。 */
function criteriaRevisionIdOfKey(key) {
  const parts = String(key ?? "").split("::");
  return parts[parts.length - 1] ?? "";
}

/** 空白 / 占位内容。 */
function isBlankish(v) {
  if (typeof v !== "string") return true;
  const t = v.trim();
  if (!t) return true;
  return PLACEHOLDERS.has(t.toLowerCase());
}

/** 退出码：原始值 → 数字。null / 空白 / 非法一律返回 null（不能当 0）。 */
function toExitCode(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function emptyState() {
  return { version: VERIFICATION_STATE_VERSION, verifications: {}, criteriaLineage: {} };
}

function normalizeState(state) {
  const src = state && typeof state === "object" ? state : {};
  const verifications = {};
  for (const [key, v] of Object.entries(src.verifications ?? {})) {
    verifications[key] = {
      verificationKey: v.verificationKey ?? key,
      projectKey: v.projectKey ?? null,
      planId: v.planId ?? null,
      criteriaRevisionId: v.criteriaRevisionId ?? null,
      status: v.status ?? "reserved",
      reservedCount: v.reservedCount ?? 0,
      startedCount: v.startedCount ?? 0,
      requestKey: v.requestKey ?? null,
      taskId: v.taskId ?? null,
      childSessionId: v.childSessionId ?? null,
      verdict: v.verdict ?? null,
      evidenceRefs: Array.isArray(v.evidenceRefs) ? [...v.evidenceRefs] : [],
      failedCommands: Array.isArray(v.failedCommands) ? [...v.failedCommands] : [],
      selfEvidence: Array.isArray(v.selfEvidence) ? [...v.selfEvidence] : [],
      criteriaChange: v.criteriaChange ?? null,
      completedPackages: Array.isArray(v.completedPackages) ? [...v.completedPackages] : [],
      history: Array.isArray(v.history) ? [...v.history] : [],
    };
  }
  const criteriaLineage = {};
  for (const [key, v] of Object.entries(src.criteriaLineage ?? {})) {
    criteriaLineage[key] = Array.isArray(v) ? v : [];
  }
  return { version: src.version ?? VERIFICATION_STATE_VERSION, verifications, criteriaLineage };
}

/**
 * 严格读状态。坏状态不是「空状态」，是不能签的状态。
 * 返回 { ok, state, reason }。
 */
function readState(raw) {
  if (raw === null || raw === undefined) return { ok: true, state: emptyState() };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "验收状态不是对象" };
  if (!("version" in raw)) return { ok: false, reason: "验收状态缺 version 字段" };
  if (raw.version !== VERIFICATION_STATE_VERSION) {
    return { ok: false, reason: "验收状态版本不认识：" + JSON.stringify(raw.version) };
  }
  if (!("verifications" in raw)) return { ok: false, reason: "验收状态缺 verifications 字段" };
  if (!raw.verifications || typeof raw.verifications !== "object" || Array.isArray(raw.verifications)) {
    return { ok: false, reason: "verifications 不是对象" };
  }
  for (const [key, v] of Object.entries(raw.verifications)) {
    if (!v || typeof v !== "object") return { ok: false, reason: "验收记录 " + key + " 不是对象" };
    if (typeof v.status !== "string" || !RECORD_STATUSES.has(v.status)) {
      return { ok: false, reason: "验收记录 " + key + " 状态非法：" + JSON.stringify(v.status) };
    }
    if (!Number.isFinite(v.reservedCount) || !Number.isFinite(v.startedCount)) {
      return { ok: false, reason: "验收记录 " + key + " 缺计数字段" };
    }
  }
  if (raw.criteriaLineage !== undefined && (!raw.criteriaLineage || typeof raw.criteriaLineage !== "object" || Array.isArray(raw.criteriaLineage))) {
    return { ok: false, reason: "criteriaLineage 不是对象" };
  }
  return { ok: true, state: normalizeState(raw) };
}

/** 记录侧用：状态不可信就抛（宿主 hook 会把它变成拒签）。 */
function requireState(raw) {
  const r = readState(raw);
  if (!r.ok) throw new Error("验收状态不可信：" + r.reason);
  return r.state;
}

/** 口径变更声明归一化：没有具体差异就不算实质变更。 */
function normalizeCriteriaChange(change) {
  if (!change || typeof change !== "object") return null;
  const diffs = (Array.isArray(change.diffs) ? change.diffs : [])
    .map((d) => {
      if (typeof d === "string") return d.trim();
      if (d && typeof d === "object") return String(d.text ?? d.diff ?? d.description ?? "").trim();
      return "";
    })
    .filter((d) => d && !PLACEHOLDERS.has(d.toLowerCase()));
  return {
    fromVerificationKey: change.fromVerificationKey ?? null,
    fromCriteriaRevisionId: change.fromCriteriaRevisionId ?? change.from ?? null,
    toCriteriaRevisionId: change.toCriteriaRevisionId ?? change.to ?? null,
    oldCriteria: change.oldCriteria ?? null,
    newCriteria: change.newCriteria ?? null,
    diffs,
    approvedBy: change.approvedBy ?? null,
    reason: change.reason ?? null,
  };
}

/** 同一轮 = (projectKey, criteriaRevisionId)：planId 不是口径，换 plan 不重置名额。 */
function findRoundRecord(s, projectKey, criteriaRevisionId) {
  let best = null;
  for (const rec of Object.values(s.verifications)) {
    if (rec.projectKey !== projectKey) continue;
    if (rec.criteriaRevisionId !== criteriaRevisionId) continue;
    if (!best || (rec.startedCount > 0 && best.startedCount === 0)) best = rec;
  }
  return best;
}

function hasProjectHistory(s, projectKey) {
  return Object.values(s.verifications).some((rec) => rec.projectKey === projectKey);
}

/** 本项目最近用过的一轮（口径版本可能不止一个）：给「只改口径 ID」这类拒绝报出被占用的名额。 */
function latestRoundRecord(s, projectKey) {
  let best = null;
  const score = (r) => r.startedCount * 1000 + r.reservedCount * 10 + r.history.length;
  for (const rec of Object.values(s.verifications)) {
    if (rec.projectKey !== projectKey) continue;
    if (!best || score(rec) > score(best)) best = rec;
  }
  return best;
}

/** 口径变更必须引用一个已有的验收键。 */
function findReferencedRecord(s, projectKey, change) {
  if (change.fromVerificationKey) {
    const rec = s.verifications[change.fromVerificationKey];
    return rec && rec.projectKey === projectKey ? rec : null;
  }
  return findRoundRecord(s, projectKey, change.fromCriteriaRevisionId);
}

/**
 * 预期包集合：宿主给的 expectedPackages 优先，否则查已发布计划的包集合（D 的 listPublishedPackages）。
 * known=false = 现在拿不到预期集合 —— 这种情况下**不得放行整批验收**。
 */
function expectedPackageIds(request) {
  const explicit = request.expectedPackages;
  if (Array.isArray(explicit)) {
    const ids = explicit
      .map((p) => String((p && typeof p === "object" ? (p.packageId ?? p.id ?? "") : p) ?? "").trim())
      .filter(Boolean);
    return { known: ids.length > 0, ids };
  }
  const provider = publishedPackagesProvider ?? (listPublishedPackages ? (arg) => listPublishedPackages(arg) : null);
  const planRevisionId = request.planRevisionId ?? request.planId ?? null;
  if (!provider || !planRevisionId) return { known: false, ids: [] };
  let out;
  try {
    out = provider({ planRevisionId });
  } catch {
    return { known: false, ids: [] };
  }
  if (!out || typeof out.then === "function") return { known: false, ids: [] };
  const ids = (Array.isArray(out) ? out : [])
    .map((p) => String((p && typeof p === "object" ? (p.packageId ?? p.id ?? "") : p) ?? "").trim())
    .filter(Boolean);
  // 该计划版本没有发布过 brief：拿不到预期集合，按未知处理（不据此放行整批验收）。
  if (!ids.length) return { known: false, ids: [] };
  return { known: true, ids };
}

/**
 * 包完成证据：只有「终结成功」才算完成。
 * 纯字符串条目（旧写法：一律是「已预留」的包号）没有终结证据 ⇒ 不算完成。
 */
function packageCompletionOf(request) {
  const entries = [];
  if (Array.isArray(request.packageStates)) entries.push(...request.packageStates);
  if (Array.isArray(request.completedPackages)) entries.push(...request.completedPackages);
  const completed = [];
  const notCompleted = [];
  for (const e of entries) {
    if (typeof e === "string") {
      const id = e.trim();
      if (id) notCompleted.push(id);
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const packageId = String(e.packageId ?? e.id ?? "").trim();
    if (!packageId) continue;
    const rawStatus = e.status ?? e.state ?? e.outcome ?? null;
    const status = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : null;
    const attemptId = String(e.attemptId ?? "").trim();
    const evidenceRefs = Array.isArray(e.evidenceRefs)
      ? e.evidenceRefs.map((r) => String(r ?? "").trim()).filter(Boolean)
      : [];
    // 成功状态 + 对应 attempt / 明确完成事件，才算完成。
    const succeeded = STATUS_SUCCESS.has(status) && (attemptId !== "" || evidenceRefs.length > 0);
    if (succeeded) completed.push(packageId);
    else notCompleted.push(packageId);
  }
  return { completed: [...new Set(completed)], notCompleted: [...new Set(notCompleted)] };
}

/** 首轮失败命令：退出码必须是原始的 0 才算通过，null/空白/非法一律算失败。 */
function failedCommandsOf(evidence) {
  const ev = evidence ?? {};
  const commands = Array.isArray(ev.commands) ? ev.commands.map((c) => String(c ?? "").trim()) : [];
  const codes = Array.isArray(ev.exitCodes) ? ev.exitCodes : [];
  if (!commands.length || !codes.length) return [];
  return commands.filter((c, i) => {
    const n = toExitCode(codes[i]);
    return n === null ? true : n !== 0;
  });
}

function makeEvent(kind, fields) {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    atMs: fields.atMs ?? Date.now(),
    kind,
    projectKey: fields.projectKey ?? null,
    planId: fields.planId ?? null,
    criteriaRevisionId: fields.criteriaRevisionId ?? null,
    verificationKey: fields.verificationKey ?? null,
    requestKey: fields.requestKey ?? null,
    taskId: fields.taskId ?? null,
    packageId: fields.packageId ?? null,
    verdict: fields.verdict ?? null,
    evidenceRefs: fields.evidenceRefs ?? [],
    action: fields.action ?? null,
    reason: fields.reason ?? null,
    criteriaChange: fields.criteriaChange ?? null,
  };
}

/** 判拒时给宿主一个完整形状的结论（allowed=false）。 */
function denyDecision(request, reason, extra = {}) {
  const projectKey = request?.projectKey ?? null;
  const planId = request?.planId ?? null;
  const criteriaRevisionId = request?.criteriaRevisionId ?? null;
  const requestKey = request?.requestKey ?? null;
  const key = verificationKeyOf({ projectKey, planId, criteriaRevisionId });
  const payload = {
    verificationKey: key,
    requestedKey: key,
    projectKey,
    planId,
    criteriaRevisionId,
    requestKey,
    decision: "deny",
    allowed: false,
    action: null,
    reason,
    status: null,
    verdict: null,
    reservedCount: 0,
    startedCount: 0,
    completedPackages: [],
    expectedPackagesKnown: false,
    criteriaChange: null,
    atMs: request?.nowMs ?? Date.now(),
    ...extra,
  };
  return {
    ...payload,
    nextState: extra.nextState ?? emptyState(),
    event: makeEvent("verification.denied", payload),
  };
}

/**
 * 验收派工判定。state 是上一轮的持久状态；返回的 nextState 是判定后的状态。
 * decision: "allow" | "deny"（宿主按这两个值放行/拒绝）。
 */
export function evaluateVerification(request = {}, state = null) {
  const read = readState(state);
  if (!read.ok) {
    return denyDecision(request, "验收状态不可信（" + read.reason + "），拒签", { stateReason: read.reason });
  }
  const s = read.state;
  const atMs = request.nowMs ?? Date.now();
  const change = normalizeCriteriaChange(request.criteriaChange);
  const projectKey = request.projectKey ?? null;
  const planId = request.planId ?? null;
  const criteriaRevisionId = request.criteriaRevisionId ?? change?.toCriteriaRevisionId ?? null;
  const requestKey = request.requestKey ?? null;
  const key = verificationKeyOf({ projectKey, planId, criteriaRevisionId });
  let expected = { known: false, ids: [] };

  const decide = (allowed, action, reason, rec = null) => {
    const payload = {
      verificationKey: rec?.verificationKey ?? key,
      requestedKey: key,
      projectKey,
      planId: rec?.planId ?? planId,
      criteriaRevisionId: rec?.criteriaRevisionId ?? criteriaRevisionId,
      requestKey,
      decision: allowed ? "allow" : "deny",
      allowed,
      action,
      reason,
      status: rec?.status ?? null,
      verdict: rec?.verdict ?? null,
      reservedCount: rec?.reservedCount ?? 0,
      startedCount: rec?.startedCount ?? 0,
      completedPackages: completion.completed,
      expectedPackagesKnown: expected.known,
      criteriaChange: change,
      atMs,
    };
    return {
      ...payload,
      nextState: s,
      event: makeEvent(allowed ? "verification.reserved" : "verification.denied", {
        ...payload,
        evidenceRefs: rec?.evidenceRefs ?? [],
      }),
    };
  };

  // 口径键字段缺一不可：没有口径就谈不上「同一口径只验一次」。
  for (const field of ["projectKey", "planId", "criteriaRevisionId"]) {
    const v = request[field] ?? (field === "criteriaRevisionId" ? change?.toCriteriaRevisionId : undefined);
    if (typeof v !== "string" || !v.trim()) {
      return denyDecision(request, "验收请求缺口径键字段：" + field + "，拒签（非整批验收派工就不该进验收闸）");
    }
  }

  // 包完成证据：预留 / 运行中 / 失败都不算完成。
  const completion = packageCompletionOf(request);

  // 口径变更声明必须自洽：具体差异 + 新旧口径文本确实不同 + 批准人 + 引用已有验收键。
  let fromRec = null;
  if (change) {
    if (!change.diffs.length) {
      return decide(false, null, "验收口径变更未给出具体差异，不构成实质变更");
    }
    if (
      change.fromCriteriaRevisionId &&
      change.toCriteriaRevisionId &&
      change.fromCriteriaRevisionId === change.toCriteriaRevisionId
    ) {
      return decide(false, null, "新旧验收口径相同，不构成实质变更");
    }
    if (change.toCriteriaRevisionId && criteriaRevisionId && change.toCriteriaRevisionId !== criteriaRevisionId) {
      return decide(false, null, "请求的口径键与口径变更声明的新口径不一致");
    }
    if (!change.fromCriteriaRevisionId) {
      return decide(false, null, "验收口径变更未指明旧口径版本");
    }
    // 旧键里解析出的口径版本必须与声明的 from 版本一致。
    if (change.fromVerificationKey) {
      const keyVersion = criteriaRevisionIdOfKey(change.fromVerificationKey);
      if (keyVersion !== change.fromCriteriaRevisionId) {
        return decide(false, null, "旧验收键的口径版本与声明的旧口径版本不一致");
      }
    }
    if (!change.oldCriteria || !change.newCriteria) {
      return decide(false, null, "验收口径变更缺少旧口径或新口径文本");
    }
    if (String(change.oldCriteria).trim() === String(change.newCriteria).trim()) {
      return decide(false, null, "新旧验收口径文本相同，不构成实质变更");
    }
    if (isBlankish(change.approvedBy)) {
      return decide(false, null, "验收口径变更缺少批准人（空白或占位不算批准）");
    }
    fromRec = findReferencedRecord(s, projectKey, change);
    if (!fromRec) {
      return decide(false, null, "验收口径变更引用的旧验收键不存在：" + (change.fromVerificationKey || change.fromCriteriaRevisionId));
    }
    if (fromRec.criteriaRevisionId !== change.fromCriteriaRevisionId) {
      return decide(false, null, "引用的旧验收键与声明的旧口径版本不一致");
    }
  }

  // 整批验收的前提是包已全部完成：判断基于已发布计划的预期包集合。
  expected = expectedPackageIds(request);
  if (!expected.known) {
    return decide(false, null, "预期包集合未知：该计划没有已发布清单（listPublishedPackages 取不到），不得整批验收");
  }
  const missing = expected.ids.filter((id) => !completion.completed.includes(id));
  if (missing.length) {
    return decide(false, null, `包未全部完成（缺 ${missing.join("、")}），不得整体验收`);
  }

  // 同一轮 = (projectKey, criteriaRevisionId)：planId 不是口径，换 plan 不重置名额。
  const rec = findRoundRecord(s, projectKey, criteriaRevisionId);
  if (!rec) {
    // 本项目还有别的口径版本在用，却只改口径 ID 就想再开一轮 —— 拒。
    if (!change && hasProjectHistory(s, projectKey)) {
      return decide(false, null, "验收口径 ID 变更必须走 criteriaChange 审批：只改口径 ID 不构成新一轮验收", latestRoundRecord(s, projectKey));
    }
    const newRec = {
      verificationKey: key,
      projectKey,
      planId,
      criteriaRevisionId,
      status: "reserved",
      reservedCount: 1,
      startedCount: 0,
      requestKey,
      taskId: null,
      childSessionId: null,
      verdict: null,
      evidenceRefs: [],
      failedCommands: [],
      selfEvidence: [],
      criteriaChange: change,
      completedPackages: completion.completed,
      history: [],
    };
    s.verifications[key] = newRec;
    if (change?.fromCriteriaRevisionId) {
      const fromKey = fromRec
        ? fromRec.verificationKey
        : verificationKeyOf({
            projectKey,
            planId,
            criteriaRevisionId: change.fromCriteriaRevisionId,
          });
      const lineage = s.criteriaLineage[fromKey] ?? (s.criteriaLineage[fromKey] = []);
      lineage.push({
        fromVerificationKey: fromKey,
        toVerificationKey: key,
        fromCriteriaRevisionId: change.fromCriteriaRevisionId,
        toCriteriaRevisionId: criteriaRevisionId,
        diffs: change.diffs,
        approvedBy: change.approvedBy,
        atMs,
      });
    }
    const action = change ? "new-round" : "reserve";
    const reason = change
      ? `放行：验收口径实质变更（${change.diffs.length} 处差异），开新一轮`
      : "放行：该验收口径下首次验收";
    newRec.history.push(makeEvent("verification.reserved", { atMs, projectKey, planId, criteriaRevisionId, verificationKey: key, requestKey, action, reason, criteriaChange: change }));
    return decide(true, action, reason, newRec);
  }

  // 同请求重放：同一 requestKey、还没启动 —— 幂等放行，不重复占用名额。
  if (requestKey && rec.requestKey === requestKey && rec.status === "reserved") {
    return decide(true, "replay", "同一请求重放：沿用已预留名额", rec);
  }

  const denyReasons = {
    reserved: "该验收口径已预留（尚未启动），不得重复预留",
    started: "该验收口径已启动过一次验收，等结果",
    passed: "该验收口径已验收通过",
    failed: "首轮 FAIL：由执行者按原口径提交自证（recordSelfEvidence），不得再派 Verifier",
  };
  return decide(false, null, denyReasons[rec.status] ?? "该验收口径已用掉一次验收名额", rec);
}

/** 验收任务真正启动：占用名额（startedCount +1）。 */
export function recordVerificationStarted({ verificationKey, requestKey, taskId, childSessionId, atMs } = {}, state = null) {
  const s = requireState(state);
  const rec = s.verifications[verificationKey];
  if (!rec) throw new Error("验收记录不存在：" + verificationKey);
  if (rec.status === "started") {
    if (rec.taskId && taskId && rec.taskId !== taskId) {
      throw new Error("验收已由另一个任务启动：" + rec.taskId);
    }
    return s;
  }
  if (rec.status !== "reserved") throw new Error("验收状态不允许启动：" + rec.status);
  rec.status = "started";
  rec.startedCount += 1;
  rec.taskId = taskId ?? null;
  rec.childSessionId = childSessionId ?? null;
  if (requestKey) rec.requestKey = requestKey;
  rec.history.push(makeEvent("verification.started", {
    atMs: atMs ?? Date.now(),
    projectKey: rec.projectKey,
    planId: rec.planId,
    criteriaRevisionId: rec.criteriaRevisionId,
    verificationKey,
    requestKey: rec.requestKey,
    taskId: rec.taskId,
  }));
  return s;
}

/** 验收结果：pass / fail。fail 之后由执行者自证，不派第二轮。 */
export function recordVerificationOutcome({ verificationKey, taskId, childSessionId, verdict, evidence, atMs } = {}, state = null) {
  const s = requireState(state);
  const rec = s.verifications[verificationKey];
  if (!rec) throw new Error("验收记录不存在：" + verificationKey);
  if (verdict !== "pass" && verdict !== "fail") throw new Error("验收结论非法：" + verdict);
  if (rec.status === "passed" || rec.status === "failed") {
    if (rec.verdict === verdict) return s;
    throw new Error("验收已有结论：" + rec.verdict);
  }
  if (rec.status === "reserved") throw new Error("验收尚未启动，不能记结果");

  const ev = evidence ?? {};
  const evidenceRefs = (Array.isArray(ev.outputRefs) ? ev.outputRefs : Array.isArray(ev.evidenceRefs) ? ev.evidenceRefs : [])
    .map((r) => String(r ?? "").trim())
    .filter(Boolean);
  // 空证据引用 = 无效结果：不得记成通过。
  if (!evidenceRefs.length) throw new Error("验收证据引用为空，结果无效");

  // 原始证据：命令与退出码必须一一对应，退出码必须是真实数字。
  const commands = Array.isArray(ev.commands) ? ev.commands.map((c) => String(c ?? "").trim()).filter(Boolean) : [];
  const rawCodes = Array.isArray(ev.exitCodes) ? ev.exitCodes.slice() : [];
  if (commands.length) {
    if (rawCodes.length !== commands.length) {
      throw new Error("验收证据的命令与退出码数量不一致，结果无效");
    }
    const bad = rawCodes.findIndex((raw) => toExitCode(raw) === null);
    if (bad >= 0) {
      throw new Error("验收证据的退出码非法（null / 空白 / 非数字），结果无效");
    }
    if (verdict === "pass" && rawCodes.some((raw) => toExitCode(raw) !== 0)) {
      throw new Error("通过结论的证据里有非零退出码，结果无效");
    }
  }

  rec.verdict = verdict;
  rec.status = verdict === "pass" ? "passed" : "failed";
  rec.taskId = taskId ?? rec.taskId;
  rec.childSessionId = childSessionId ?? rec.childSessionId;
  rec.evidenceRefs = evidenceRefs;
  rec.failedCommands = failedCommandsOf(ev);
  rec.history.push(makeEvent("verification.result", {
    atMs: atMs ?? Date.now(),
    projectKey: rec.projectKey,
    planId: rec.planId,
    criteriaRevisionId: rec.criteriaRevisionId,
    verificationKey,
    requestKey: rec.requestKey,
    taskId: rec.taskId,
    verdict,
    evidenceRefs: rec.evidenceRefs,
  }));
  return s;
}

/**
 * 执行者自证：按首轮失败的原命令重跑并交出输出。
 * 自证挂在同一条验收记录上，不重置名额、也不允许再派 Verifier。
 */
export function recordSelfEvidence({ verificationKey, packageId, commands, exitCodes, outputRefs, commit, atMs } = {}, state = null) {
  const s = requireState(state);
  const rec = s.verifications[verificationKey];
  if (!rec) throw new Error("验收记录不存在：" + verificationKey);
  if (rec.status !== "failed") {
    throw new Error("只有首轮 FAIL 的验收才需要执行者自证，当前状态：" + rec.status);
  }

  const cmds = (Array.isArray(commands) ? commands : []).map((c) => String(c ?? "").trim()).filter(Boolean);
  // 原始退出码：不归一化，null / 空白就是「没有有效退出码」。
  const rawCodes = Array.isArray(exitCodes) ? exitCodes.slice() : [];
  const refs = (Array.isArray(outputRefs) ? outputRefs : []).map((r) => String(r ?? "").trim()).filter(Boolean);
  const commitText = typeof commit === "string" ? commit.trim() : "";
  const reasons = [];
  // 首轮没记下失败命令，自证就无从证明覆盖了失败点 —— 不算有效自证。
  if (!rec.failedCommands.length) reasons.push("首轮失败未记录命令，无法证明自证覆盖了失败点");
  if (!cmds.length) reasons.push("自证没有命令");
  if (rawCodes.length !== cmds.length) reasons.push("自证命令与退出码数量不一致");
  const missing = rec.failedCommands.filter((c) => !cmds.includes(c));
  if (missing.length) reasons.push("自证未覆盖首轮失败命令：" + missing.join(" / "));
  if (!refs.length) reasons.push("自证缺少输出引用");
  let invalidCodes = 0;
  let nonZeroCodes = 0;
  for (const raw of rawCodes) {
    const n = toExitCode(raw);
    if (n === null) invalidCodes += 1;
    else if (n !== 0) nonZeroCodes += 1;
  }
  if (invalidCodes) reasons.push("自证存在缺失或非法的退出码");
  if (nonZeroCodes) reasons.push("自证存在非零退出码");
  if (!commitText || isBlankish(commitText)) reasons.push("自证缺少提交号");

  const entry = {
    packageId: packageId ?? null,
    commands: cmds,
    exitCodes: rawCodes,
    outputRefs: refs,
    commit: commitText || null,
    atMs: atMs ?? Date.now(),
    accepted: reasons.length === 0,
    reason: reasons.join("；") || "自证满足原口径",
  };
  rec.selfEvidence.push(entry);
  rec.history.push(makeEvent("verification.self-evidence", {
    atMs: entry.atMs,
    projectKey: rec.projectKey,
    planId: rec.planId,
    criteriaRevisionId: rec.criteriaRevisionId,
    verificationKey,
    requestKey: rec.requestKey,
    packageId: entry.packageId,
    evidenceRefs: entry.outputRefs,
  }));
  return s;
}

/** 状态文件默认位置：宿主给的 PLUGIN_DATA，没有就退到临时目录。 */
export function defaultVerificationStateFile() {
  const base = String(process.env.PLUGIN_DATA || "").trim();
  return join(base || join(tmpdir(), "code-team-verification"), "verification-state.json");
}

/** 读状态文件：文件不存在 = 还没有状态（合法）；文件在但读不出/不可信 ⇒ 抛。 */
export function loadVerificationState(file) {
  if (!existsSync(file)) return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error("验收状态文件不是合法 JSON：" + ((err && err.message) || String(err)));
  }
  const r = readState(parsed);
  if (!r.ok) throw new Error("验收状态文件不可信：" + r.reason);
  return r.state;
}

export function saveVerificationState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(normalizeState(state), null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

// 同一验收键的判定不能并发读改同一个状态文件。
export function withVerificationLock(stateFile, fn) {
  const lockDir = stateFile + ".lock";
  mkdirSync(dirname(stateFile), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 30000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        /* 锁刚被别的进程清掉，重试 */
      }
      if (Date.now() > deadline) throw new Error("获取验收状态锁超时: " + lockDir);
      const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sleepBuf, 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** 宿主入口：锁内读状态 → 判定 → 写回。放行且占用名额时落盘。 */
export function decideAndPersistVerification({ stateFile, request, nowMs } = {}) {
  const file = stateFile ?? defaultVerificationStateFile();
  try {
    return withVerificationLock(file, () => {
      const state = loadVerificationState(file);
      const decision = evaluateVerification({ ...request, nowMs: nowMs ?? request?.nowMs }, state);
      if (decision.allowed && (decision.action === "reserve" || decision.action === "new-round")) {
        saveVerificationState(file, decision.nextState);
      }
      return decision;
    });
  } catch (err) {
    // 状态读不出来 / 拿不到锁 = 判不了 = 拒签（不能当没事发生）。
    return denyDecision(request, "验收状态不可用，拒签：" + ((err && err.message) || String(err)));
  }
}

/** 宿主入口：启动 / 结果 / 自证 落盘。 */
export function recordAndPersistVerification({ stateFile, action, payload } = {}) {
  const file = stateFile ?? defaultVerificationStateFile();
  const fn = { started: recordVerificationStarted, result: recordVerificationOutcome, "self-evidence": recordSelfEvidence }[action];
  if (!fn) throw new Error("未知验收动作：" + action);
  return withVerificationLock(file, () => {
    const next = fn(payload ?? {}, loadVerificationState(file));
    saveVerificationState(file, next);
    return next;
  });
}
