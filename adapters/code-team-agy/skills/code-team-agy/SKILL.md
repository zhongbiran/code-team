---
name: code-team-agy
description: Antigravity 原生三池多 Agent 工程协作总控工作流（Claude Opus/Sonnet 池 + Gemini 4 池 + MiniMax mcode exec 并发池）。当用户点名「Code Team」「团队协作」「并行开发」，或面临跨前后端/Rust 硬件的复杂重构与高可靠交付时触发；1~2 文件的轻量小改动不要启动本流程。
---

# Code Team (Antigravity Edition)

**核心原则**：决策权外置给 Overmind，技术契约与难点归 Coder，高并发实现归双后端 Worker 池，异构验收归 Verify；主会话只做**转交、原样派工、监控与汇报**。

## 1. 先判定任务等级（严禁杀鸡用牛刀）

| 等级 | 判定条件 | 执行路径 |
| :--- | :--- | :--- |
| **L1** | 1~2 个文件，边界极清晰，无跨端耦合 | **退出本流程**，主会话直接完成并验证。 |
| **L2** | 单模块中型改动（3~8 文件）或明确疑难排障 | 主会话 + 1 个 `explore` + 1 个 `coder`/`worker`（轻量子代理）。 |
| **L3** | 跨端/全栈 + Rust 硬件、多模块并行、或需异构交叉验收 | **启动完整三池 Code Team**（下方 Quick Start）。 |

## 2. 三池模型编排（Pro 5h + MiniMax 独立订阅）

| 角色 | 主力模型与档位 | 配额池 | 备用 / 升级条件 |
| :--- | :--- | :--- | :--- |
| 主会话 | `gemini-4-hydrogen-medium` | Gemini 池 | 只调度汇报，不写业务代码 |
| Overmind | `claude-opus-5-5-medium` | **Claude 池** | 需 1M 全仓上下文或 Claude 池紧张 → `gemini-4-neon-high`；极复杂重构 → `gemini-4-carbon-medium` |
| Coder | `claude-opus-5-5-high` | **Claude 池** | 常规主力 → `gemini-4-neon-high`；跨模型会诊/2 轮未收口 → `gemini-4-carbon-high` |
| Worker | `mcode exec` (`MiniMax-M3.1-Flash` `high`, 512k) | **MiniMax 池** | MiniMax 限流、Pro Gemini 池富裕、或需浏览器/IDE 原生工具 → `gemini-4-hydrogen-medium` |
| Explore | `mcode exec` (`lightweight`, `--max-steps 20`) | **MiniMax 池** | 超大仓一次全景扫 → `gemini-4-hydrogen-low` |
| Verify | `claude-sonnet-5-5-medium` | **Claude 池** | 与执行者异构，可互备 `gemini-4-neon-medium`（严格只验一次） |

## 3. L3 标准执行流（Quick Start）

1. **只读侦察（Explore）**：
   - 派工前先过**证据可达性三问**（本机/本仓库可达吗？需要改代码吗？能并进已有包吗？），不可达则改产“现场取证清单”，严禁空烧探索包。
   - 先派 `explore` 做单主题取证，拿到 `< 800` 字结构化索引（路径+行号+依赖边）。
2. **顶层规划与 Brief 落盘（Overmind）**：
   - 将用户原始需求（附带**仓库硬约束**：真实编译/测试命令口径、临时产物路径、隔离红线）+ Explore 索引交给 `overmind`（Swarm `/teamwork` 可直接指定 `claude-opus-5-5-medium`）。
   - Overmind 输出的所有子包 brief **必须写明止损条件**，并通过脚本落盘并签名：
     ```bash
     "$PLUGIN_ROOT/scripts/run-node.sh" "$PLUGIN_ROOT/scripts/brief-publish.mjs" \
       --brief <brief.md> --plan <planId> --pkg <pkgId>
     ```
   - 主会话**严禁修改**落盘后的 brief 正文一字（也不在注入后私自追加覆盖）。
3. **契约先行定锚（Coder）**：
   - 跨端或硬件任务，在派任何 Worker 前由 `coder` 先落盘机器可校验的契约文件与最小集成测试骨架，并为每包指定最多 2 个领域 Skill；涉及枚举/口径扩展必须一次覆盖六处。
4. **双后端并发派工（Worker 池）**：
   - **优先走 MiniMax 并发 CLI**（自动创建独立 `git worktree`、硬限 512k 与 `--max-steps 100`、自动采集真实 JSON `usage` 并写 `$PLUGIN_DATA/events.jsonl`）：
     ```bash
     "$PLUGIN_ROOT/scripts/run-node.sh" "$PLUGIN_ROOT/scripts/worker-dispatch.mjs" \
       --role worker --backend auto --pkg <pkgId> --plan <planId> \
       --repo <项目根目录> --brief <已签名的brief路径> --worktree
     ```
   - 当 `--backend auto` 判定 MiniMax 限流、需要原生浏览器/IDE 工具或用户指定回退时，改派 Antigravity 原生 `gemini-4-hydrogen-medium`（同样受 `hooks.json` 硬闸门监管）。
   - 并发上限：MiniMax 同时最多 **4** 个 Worker，Hydrogen 同时最多 **2** 个 Worker。
5. **安全合入与分层验收（Verify + 收尾全量）**：
   - **验收分层不重复**：Worker 只跑「编译闸 + 本包专项测试」；合入后派 `verify`（`claude-sonnet-5-5-medium` 或 `gemini-4-neon-medium`）只跑**一次专项测试 + 读关键 Diff（结合 `ponytail-review` 与注释去 AI 味自查）**；最终**全量测试 / 整套构建由主会话在收尾时跑一次**。
   - 若首轮 `FAIL`，由原 Worker 修复并提交自证命令输出，不再重开第二轮全量 Verify。
6. **把关与透明汇报**：
   - 运行 `"$PLUGIN_ROOT/scripts/run-node.sh" "$PLUGIN_ROOT/scripts/lessons.mjs" check --briefs <brief目录>` 确认所有硬闸门全绿。
   - 向用户汇报必须包含：① 交付清单；② 若有配置/测试断言调整需明确声明；③ 真实编译/验收命令与结果；④ **本轮实际激活使用的 Skill 列表**；⑤ 各配额池真实用量摘要。

## 4. 六条不可绕过铁律
1. **闸门挂 Hook**：编译闸、文件归属互斥、真实用量/步数守卫、生产/硬件隔离红线由根 `hooks.json` 自动拦截，禁止跳过。
2. **撞墙严禁同分钟同规模重派**：先降并发 + `git status` 核查落盘深度 + 续派写明“已落盘 / 未完成”。
3. **单包成本硬红线**：Worker 软上下文警戒 `180k`（硬顶 `512k`）、步数硬上限 `100`（工具调用 `> 180` 或单包 Token `> 55M` 必须拆包）。
4. **3 次同错熔断**：Worker 同一报错 3 轮不收敛立刻交回 Coder；Coder 在 Neon 下 2 轮不收敛升级 Opus High / Carbon High。
5. **Done 只给一条真编译命令**：静态检查不算编译；禁止穷举测试清单。
6. **重复纠正自动升级**：同一类纠正出现 ≥2 次，经 `scripts/lessons.mjs` 升级为 `checks/` 可执行脚本。
