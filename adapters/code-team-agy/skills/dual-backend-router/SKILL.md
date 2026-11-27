---
name: dual-backend-router
description: 三池配额动态路由与 mcode exec / Gemini 4 混用成本守卫技能。实时核算 MiniMax 订阅、Pro Claude 池与 Pro Gemini 4 池用量，自动分流并发 Worker 并执行撞墙冷却与拆包熔断。
---

# Dual-Backend Router（三池配额路由与成本守卫）

**适用时机**：每次准备并行派工（Worker / Explore）、决定 Overmind/Coder 模型、或遇到限流/超额需要切换后端与续派时激活。

## 1. 三独立配额池分工矩阵
- **Claude 池（Pro 独立窗口）**：`claude-opus-5-5-medium/high`（Overmind 规划、Coder 契约与攻坚）、`claude-sonnet-5-5-medium`（异构 Verify 验收）。
- **Gemini 池（Pro 独立窗口）**：`gemini-4-hydrogen-medium`（主会话与混用 Worker）、`gemini-4-neon-high/medium`（大上下文备选 Overmind/Coder/Verify）、`gemini-4-carbon-medium/high`（极端硬骨头点杀）。
- **MiniMax 池（独立订阅 · `mcode exec`）**：`minimax/MiniMax-M3.1-Flash`（`--effort high`，512k 硬顶），**并发主力 Worker 与 Explore**，完全不消耗 Pro 额度。

## 2. Worker 自动路由规则（`--backend auto`）
优先使用 `scripts/worker-dispatch.mjs` 路由：
1. **默认派 MiniMax（`mcode-exec`）**：标准代码实现、单测补齐、只读 Explore 侦察；同时最多并发 **4** 个。
2. **自动切 Gemini 4 Hydrogen（Antigravity 原生）**：满足任一条件即切换：
   - MiniMax 近期出现限流（429/timeout/quota）或处于撞墙冷却期（120 秒内）；
   - 任务强依赖 Antigravity 原生工具（内置 `browser` 子代理、IDE 上下文）；
   - Pro Gemini 池余量充裕且只需要 1~2 个轻量快包。

## 3. 成本与撞墙硬纪律
- **成本本质**：`cacheRead ≈ toolCalls × 平均上下文长度`。
- **单包红线**：
  - MiniMax Worker：`--max-steps 100`、硬上下文 `512k`、**软警戒 `180k`**；
  - 单包累计 `toolCalls > 180` 或总 Token `> 55M` → 必须拆包，禁止继续叠加。
- **撞墙续派三件套（硬规则）**：
  - 撞限额/超时后 **120 秒内禁止同规模重派**；
  - 续派前必须：① 降低并发数；② 在目标工作区/worktree 跑 `git status` 核查已落盘深度；③ 续派说明里明确写清“已落盘什么 / 剩余未做什么”。
- **统一可观测**：所有派工与事件统一经 `scripts/record-event.mjs` 写入 `$PLUGIN_DATA/events.jsonl`（携带 `pool`, `backend`, `model`, `usage`, `skillsUsed`）。
