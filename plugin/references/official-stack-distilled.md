# 官方 mcode-stack 提纯

> 来源：`https://github.com/MiniMax-AI/mcode-stack`（2026-11-23 抓取 main 分支原文）
> 官方原文：`README_ZH.md`、`stacks/ronny/WORKFLOW.md`、ronny 栈 8 个 skill 原文、jiachen/req-tpm/youfang 三份 WORKFLOW

## 一、先说清楚提纯的边界

**本机的 `mcode` 插件就是官方 ronny 栈。** 逐字比对确认：
`D:\.minimax\plugins\mcode\skills\` 下 32 个 skill 里，
`subagent-split-check`、`agent-brief`、`evidence-first-review`、`review-capacity-check`、
`tool-budget-audit`、`context-tax-audit`、`long-session-check`、`long-command-check`、
`independent-review`、`handoff-doc` 等与官方 ronny 栈**逐字一致**。

所以提纯**不是复制 skill**——复制过去只会得到两份相同的方法论。

Code Team 是**编排层**，官方 skill 是**方法论库**，两者是调用关系：

| | 官方 mcode-stack | Code Team（本文档所在插件） |
|---|---|---|
| 形态 | 通用 skill，各自独立触发 | 编排入口，把多个 skill 编成一条流程 |
| 回答 | "这一步该怎么想" | "这一步该做几步、派给谁、花多少额度" |
| 触发 | agent 按 description 自动加载 | 主会话主动编排 |

提纯的真正动作：**把官方 skill 里散落的判据，压缩成 Code Team 流程中可直接执行的一步。**
判据本身不重写（避免与官方版本漂移），只做"在什么环节、用哪条判据"的映射。

官方仓库本身也是插件市场，`.claude-plugin/plugin.json` 里 ronny 的 description 就是它自己的定位：
"how to decide whether a task should go to a subagent, how long to wait on a long command,
how to keep long sessions from going dull, and what goes into context on every turn"。

## 二、官方 skill → Code Team 步骤的映射

| Code Team 环节 | 用官方哪条判据 | 官方 skill | 关键内容（提纯后） |
|---|---|---|---|
| 第 1 步 额度守卫 | 该不该拆 subagent | `subagent-split-check` | 只在三条之一成立时拆：①**实测**的退化（要 eval 数据，凭感觉不算）②可并行的、做完可扔的独立活 ③工具/指令冲突。**决定性问题**：后面还要看原始输出吗？只要结论才适合拆。"这归另一个团队/这是另一类问题"→ 不拆 |
| 第 1 步 额度守卫 | 审查产能 | `review-capacity-check` | **已完工但没人验收的活 > 2 个高风险项 → 不要开新会话**。降本顺序：①让检查自动化 ②让 agent 交证据 ③少开并行。**"快速扫一遍高风险"不在选项里** |
| 第 2 步 Overmind | 派工前的 brief | `agent-brief` | 派工前先写 **hypothesis**（我预判是什么），派工后才有东西可比；brief 必须用**自己的话**写目标/不做什么/约束；**先定义"什么算验证过"**，再看输出，防止事后迁就 |
| 第 3 步 Coder | 派工前的 brief | `agent-brief` | 同上，另加 **mode 标注**：是"帮我想"还是"替我想"。后者要更严的验收（因为推理过程不在你脑子里） |
| 第 4 步 拆包并行 | 切法 | `subagent-split-check` | 按 **context 边界**切，不按问题类型切。子任务应：几乎不依赖系统其他部分、交回紧凑结果。子代理要**作为工具暴露给主代理**，主代理始终握着和用户的对话 |
| 第 5 步 验收 | 证据优先 | `evidence-first-review` | **先看它跑过的命令和输出，再看它的总结**。每个绿色检查要说得出：它证明了什么、**没**证明什么（填不出右列 = 还没理解这个检查）。要它交出"默默做的决定"。最后问："什么会让这个结论是错的"，然后自己验那一件事 |
| 第 5 步 验收 | 独立审查 | `independent-review` | 干净的 context，只拿 diff / 需求 / 测试结果 |
| 第 6 步 收尾 | 重复纠正变检查 | `taste-to-checks` | 同一条纠正出现两次 → 写成测试 / lint / hook / CI |
| 第 6 步 收尾 | 交接 | `handoff-doc` | 会话太长时写交接文档，新会话直接读它接着干 |
| 全程 | 长命令 | `long-command-check` | 前台等待要**明显短于**模型服务的缓存寿命；转后台必须是**同一个进程**不是重跑；后台完成后靠**通知**不是轮询；大输出写文件增量读 |
| 全程 | 上下文税 | `context-tax-audit` | 每轮注入的东西逐项问："删了它模型会在哪犯错？"答不出来就该删。**稳定的在前，会变的在后** |
| 全程 | 工具预算 | `tool-budget-audit` | 工具成本 = 定义开销 + 结果开销 + **选错工具的副作用**。按瓶颈分层：定义大→tool search；结果大→PTC；参数老传错→改描述 |

## 三、三个栈各贡献了一条不同的东西

### ronny（工程负责人）——判据最硬
核心是"什么算证据"。已在本机 `mcode` 插件装好，Code Team 直接调用即可。

### jiachen（PR review）——结论必须由脚本给出
从 `stacks/jiachen/WORKFLOW.md` 提炼出三条 Code Team 能直接用：

1. **交付不等于完成**：开了 MR 不是终点，要跟到无冲突、CI 绿、合理的 review 意见都处理完；
   剩余的**写明为什么没采纳**。
2. **每条结论带概率和检查**：根因、诊断、"这样能修好"都要说清概率、哪些是验证的哪些是推断的、
   **什么检查会推翻它**。不依赖 agent 自身判断的检查优先：测试、脚本、原始日志、源码、git history。
3. **先复现再修**：修复从一个**在未修复代码上以同样症状失败**的测试开始，只在它失败后才改代码。
4. **审自己的 PR 用 CI 的同一套规则**，在自己模型上跑，什么都不发出去。
5. **连续三轮 blocking 后停手**：verdict 变成"需要一个人"，停下来重新想，而不是让 agent 再多转几轮。

### req-tpm（需求管理）——预期效果先写死
从 `stacks/req-tpm/README_ZH.md` 提炼：

- **预期效果在受理时就写死**：指标、基线、目标、测法、观察窗口。最后用它验收。
- **提出人提建议，负责人拍板优先级**。Agent 不改别人需求的优先级。
- **停滞本身是一条信息**：置顶报告，不自动催人，也不沉默。
- **上线不等于完成**，只有拿到效果证据才关闭。

映射到 Code Team：Overmind 产出的方案里，**"目标产出物"和"验收标准"必须是可测量的**，
不能是"代码质量好"这种无法判定的说法。

### youfang（演示）——先定故事线，再画图
提炼一条通用做法：**先在文本里定故事线，人纠正列表而不是图形**。
映射到 Code Team：Overmind 的方案本身就是故事线——人该纠正的是**方案列表**，不是让 agent 先动手再返工。

## 四、官方明确写出的"不要"

这些是反面清单，比正面规则更该遵守：

| 官方原文 | 出处 | 含义 |
|---|---|---|
| "这不是 prompt 合集，也不是最佳实践清单" | README | 官方强调的是可跑的东西，不是理念 |
| "按问题类型拆 agent"→ 传话游戏 | subagent-split-check | 不要按角色/职责拆 |
| "凭感觉不算（实测退化）" | subagent-split-check | 没有 eval 数据就别以"感觉会变差"为由拆 |
| "快速扫高风险工作"**不在**降本清单里 | review-capacity-check | 降本只能靠自动化、靠证据、靠少开，不能靠看得快 |
| "PTC 不会让模型更聪明" | techblog 02 | 别指望上 PTC 提升质量，它只省请求次数 |
| "prompt 里的规则是下一个 agent 可能跳过的要求" | coding-agent-workflow | 硬性要求要写进代码/脚本，不能只写在提示词里 |
| "一次只改一处" | harness-experiment | 实验要可归因 |
| 同一个纠正提两次 → 写成检查 | taste-to-checks | 别靠记性 |

## 五、Code Team 采纳的净新增（相对本机已装的 mcode 插件）

官方 ronny 栈本机已有，**不重复装**。Code Team 的增量只有四项：

1. **流程化**：官方是"某场景该用哪个 skill"，Code Team 是"这次任务按什么顺序走、每步派谁、花多少额度"。
2. **额度配比**：官方没有跨工具（Codex + MCode 子代理）的额度换算表，Code Team 补了。
3. **双脑分工**：官方没有"用另一个 CLI 做规划"的概念，Code Team 引入 Overmind/Coder 两级 Codex 规划。
4. **执行证据链**：把 `agent-brief` 的 hypothesis + `evidence-first-review` 的"证明了什么/没证明什么"
   串成一条：派工前写死验证判据 → 派工后先看命令输出再看总结。

## 六、没提纯的（以及为什么）

| 官方内容 | 没提纯的原因 |
|---|---|
| `magic-move-deck`（演示生成） | 与编码工作流无关，属于内容创作场景 |
| `making-content`（小红书图文） | 同上 |
| `pr-review` / `pr-review-ci` / `pr-review-tuning` | 本机已装，且属于 CI 集成范畴，与 Code Team 的会话内编排不重叠 |
| `req-tpm` 全套（飞书 + Meegle） | 官方自己标注 v0、依赖 `meegle` 与 `lark-cli`、需先查自己空间的字段映射。本机没有 Meegle 空间，整套搬过来会不可用。只提纯了"预期效果先写死"这条通用规则 |
| `harness-experiment` / `trajectory-review` | 属于 harness 工程与复盘，Code Team 只在收尾时按需引用 |
