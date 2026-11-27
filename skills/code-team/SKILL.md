---
name: code-team
description: Code Team 多 Agent 协作工作流：Overmind（可换模型、可换后端的外部大脑）出方案、拆包、写每包 brief，Coder 定代码方向，worker/explore/verifier 并行执行，主会话只做原样转交。只在明确意图下触发——用户点名「Code Team」「团队协作」；或要求外部大脑参与决策；或要求按后端核算这项团队任务的用量与验收。普通单任务不要用它，派一个子代理就够。
metadata:
  short-description: Overmind 决策 + Coder 定代码方向 + 三个执行子代理，主会话只转交
---

# Code Team

决策权在 Overmind，不在主会话。主会话是**侧边会话**：转交需求、转发结果、追加用户的问题，不做判断。

细节都在插件根目录的 `references/usage.md`（角色与 skill 名单、事件字段、派工标记与三道闸、上下文纪律、命令清单、常见问题）。本文件只留入口与红线。

## Quick start

1) 确认该不该用、走哪条路径：读 `references/usage.md` 的「何时触发」与「模式交接」两节。
2) 换机器或换项目时做一次后端就绪检查：`node scripts/codex-bootstrap.mjs <项目根目录> report`（确认决策后端与 Codex 侧环境；不健康就按它给的命令修）。
3) 规划：把用户原话写进需求文件，`node scripts/codex-team.mjs plan --prompt-file <需求文件> --role overmind`。
4) 需要代码方向决策的包，换 `--role coder` 跑一次（Coder 只读代码，给接口设计与取舍结论，不写业务代码）。
5) 派工：用 Task 工具派 `worker` / `explore` / `verifier`；提示末尾**同时贴两份输出**——`node scripts/skills-for.mjs <role>`（用哪个方法论）与 `node scripts/dispatch-params.mjs <role>`（已保存的 model / effort / agent），Task 参数照抄后者的 `taskArgs`。**控制台里改过 model/effort 之后必须用 dispatch-params 的输出，否则改了不生效。**每包一个 brief，改动文件互不重叠，单包控制在 20 分钟内。
6) 记事件：派工前后各一条 `node scripts/record-event.mjs record --kind dispatch ...`（`--project` / `--session` / `--task` / `--skill` 必填，否则统计断链）。
7) 验收：全部包完成后派 `verifier` 一次，`run_in_background=false`。**不要自己先验一遍再让 Verifier 验一遍。**
8) 收尾：同一条纠正出现两次 → `node scripts/lessons.mjs record` / `list` / `promote`；发布把关跑总入口 `node scripts/lessons.mjs check [--briefs <本轮 brief 目录>]`（空台账也照跑随包检查）。

## Tool-call guardrails

- 任何工具返回 `Tool <name> not found`：**本任务内把该工具记为不可用。不要换参数重试，也不要稍后再调。**改用 `node scripts/skills-for.mjs <role>` 给的替代能力；替代不了就报告具体阻塞。
- 决策调用只走 `node scripts/codex-team.mjs plan --role overmind|coder`。**不要裸跑 `codex exec`**——本机 WebSocket 到 ChatGPT 不通，裸跑会先空转约 120 秒才降级；`checks/no-bare-codex-exec.mjs` 会拦住。
- 宿主无法兑现的参数（如某个 model/effort 选项）要在汇报里写明原因，**不许伪造已生效或在调用时静默丢弃**。
- `dispatch-params` 的 `status` 是 `CAPABILITY_UNKNOWN` 时，**不许伪造已生效**：那一项没下传，原值在 `requested` 里——按原值向用户说明，让用户改配置或换模型，不要手填一个值塞进 Task 参数。
- 检查脚本报红就修代码或修脚本，**不要改检查让它变绿**。

## 派工前的闸门（宿主自动执行）

闸门挂在宿主 hook 上（注册在 `hooks/hooks.json`，判定脚本 `scripts/dispatch-hook.mjs`）：`task` / `task_append` 每次派工前自动判一次，不合格直接拒绝，Task 不会被创建。**不要靠「记得跑脚本」，也不要改 hook 配置去绕过拒绝。**手跑核对用 `node scripts/lessons.mjs check [--briefs <本轮 brief 目录>]`。

- 闸 1 · 编译闸：brief 的验收段必须含**编译**（`-ChecksOnly` 只是静态检查，不编译）。判定 `checks/brief-requires-compile-gate.mjs`。
- 闸 2 · 文件归属互斥：每份 brief 都要有「文件归属」段，且两份归属清单不得有交集。判定 `checks/brief-file-ownership-disjoint.mjs`。
- 闸 3 · 额度余量：真实用量闸已接进 hook（`scripts/trajectory-usage.mjs`），同一包累计越界会自动要求拆包 / 重拆。
- 闸 4 · 隔离红线：Worker 的测试**不得连生产库 / 现场 Redis / 现场数据库**，隔离由仓库自带机制决定。

派工标记（`code-team-plan` / `code-team-package` / `code-team-brief-ref`）、续派契约与验收证据格式见 `references/usage.md`。

## 何时触发

命中任意一条才用 Code Team：

- 用户点名「Code Team」「团队协作」「并行开工」。
- 用户要求**可选的外部大脑**参与决策（换模型、换后端、跨 CLI）。
- 用户要求**按后端核算**这项团队任务（用量、事件归因、验收）。

不命中就别开。Code Team 不替代 MCode 内置 Agent Team——它多出来的是「决策权在外部、后端可换、统计跨后端」。

## 原生模式交接

只使用**当前会话实际暴露**的模式入口（宿主命令面板里的中文标签 / 斜杠命令）：

| 模式 | 命令 | 什么时候用 |
|---|---|---|
| 计划 | `/plan` | 大量有依赖、范围未定的工作 → 只读调查，出计划；**按宿主流程提交用户审阅（"计划完成，实施计划？"）后才执行** |
| 目标 | `/goal` | 有清楚终点、且用户要求持续做到达标 → 持续推进直到达标或阻塞（目标自带预算上限与校验子会话） |
| 压缩 | `/compact` | 长会话优先用宿主自动压缩；要显式压缩时，**在包交接点**保留原始需求引用、已批 brief、已完成包、下一条 Done、后端线程标识，同一会话继续 |
| 侧边对话 | `/sidechat` | 留给可独立调查的问题，不打断主线 |

两个同时命中 → **先审计划，再按目标推进**。

会话没暴露某个入口 → 不要凭空调用。改用等价手段（新建子会话、让 Worker 去读、落盘交接文档），并在汇报里说明用了哪种替代。

## 角色分工

| 角色 | 后端 | 职责 |
|---|---|---|
| 主会话 | 当前会话 | 只转交、转发、追加问题、汇报。**不判断、不拆包、不改 brief、不写实现代码** |
| Overmind | `codex-cli`（可换） | **所有决策**：问题定义、方案取舍、拆包、每包 brief |
| Coder | `codex-cli`（可换） | **代码方向决策**：接口设计、实现取舍、核心问题定位。不写业务代码 |
| worker | `mcode-agent` | 按 brief 实现，可多开并行 |
| explore | `mcode-agent` | 只读取证 |
| verifier | `mcode-agent` | 独立验收，只做一次 |

后端、模型、思考档位、每个角色的 skill 名单都在 `config/team.json`，控制台可改；**换后端或换模型不改流程**。

每包**最多附加两个专业 skill**，方向清单在 `config/team.json` 的 `routing.directions`，由 Coder 只读选择；命中方向时用 `node scripts/skills-for.mjs <role> --direction <id>` 取附件（或直接用 dispatch-params 输出里的 `attachment.specialty`，选择指南见 `skills/code-team/reference/`，若该目录随包提供）；可选专业插件缺失 → 按缺插件降级，用角色基础能力完成（详见 `references/usage.md`）。

## 主会话只做四件事（越权即偏离工作流）

1. 用户需求**原样**转交 Overmind。
2. Overmind 的方案、拆包、brief **原样**转发给执行者——一个字都不改，包括不补「我觉得还该测什么」。
3. 用户追加问题**原样** `--resume` 给 Overmind，不重开线程。
4. 向用户汇报：做了什么、验证了什么、什么没验证。

brief 由 Overmind 写：主会话不补需求的隐含条件，也不替它写 Hypothesis（派工前没预判过，填出来就是编的）。

## 额度纪律

- 一次任务 Overmind **至多 1 次**、Coder **至多 2 次**。
- 用户追加问题用 `--resume` 复用同一线程与前缀缓存，**不重开**。
- 规划期 Codex 一律只读；实现只由 Worker 做。
- **上下文窗口**：执行侧子代理统一 **512k**，**不要开 1M**——每次模型调用都重发整段累积上下文，窗口越大 token 越贵（缓存读取同样计费）。
- 看用量：`node scripts/codex-team.mjs budget`。

## 缺插件 / 缺后端降级

- 目标机器没装 Codex CLI、没装某个专业插件 → **不崩**：按缺插件降级（用角色基础能力），只在该路径给一条可执行的下一步。
- 没配可用的外部决策后端 → **明示**可以改用内置 Agent Team 或配另一个后端，**不要默默换掉 Overmind**。
- 缺不可替代的数据访问 → 报告具体阻塞。

## 新会话刷新

插件列表是**会话启动快照**。装完或更新插件：`/plugins` → `Ctrl+R` 刷新 → **重开一个会话**，skill 才会出现在可用列表里。

## 硬规则

本轮复盘定下的六条（数据与根因见 `references/lessons-2026-11-25-postmortem.md`）：

1. **闸门必须是 hook / CI**，不是需要人记得跑的脚本。
2. **守卫读真实 usage**（cacheRead / decode / toolCalls），不用「包数 / 12」这种经验值。
3. **撞墙后禁止同分钟重派同规模任务**：先降并发 + `git status` 核查落盘深度 + 续派书写明「已落盘什么 / 没做什么」。
4. **brief 由 Overmind 落盘，主会话不转写**——转写就是改写，改写就是绕过决策权边界。
5. **验收一次**：首轮 FAIL 由执行者自证修复，Verifier 不复验第二遍（除非改动了验收口径本身）。
6. **成本闸看 toolCalls**：单包 > 200 次 tool 调用 = 包太大，拆；> 60M token = 包有结构问题，重拆。

上下文窗口纪律（2026-11-27）：派工**不要显式传与 agent 默认相同的 model** —— 实测会把子会话从 512k 顶成 1M 档，cacheRead 按累积上下文线性放大；`dispatch-params` 已自动不下传，照抄它的 `taskArgs` 即可。守卫见 `checks/subagent-context-window.mjs`。

其余红线：

- 决策调用一律走 `scripts/codex-team.mjs`，不裸跑 `codex exec`；换 codex 模型前用 `codex debug models` 确认 id 有效。
- 每次派工都记事件，带 `--project`、`--session`、`--task`、`--skill`。
- Worker 与 Codex 不同时改同一批文件。
- 重要状态（计划、决定、验收结论）落盘，不只活在对话里。
- 每条结论要么有证据，要么标注是假设。
- brief 的 Done 栏只给「一条命令 + 期望输出」——穷举测试场景会削弱执行者判断。
- 改 `config/team.json` 的 skill 名单后跑 `node checks/skills-exist.mjs`：skill 名写错是隐形失败，流程照跑但方法论从没被加载过。
- 已保存的 model/effort 必须经 `scripts/dispatch-params.mjs` 进入 Task 参数：控制台改了不手动带进去，等于没改。
- 发布把关总入口：`node scripts/lessons.mjs check`（随包检查 + 台账已升级的检查，合并去重；台账引用缺失就报错）。
