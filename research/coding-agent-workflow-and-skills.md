> ## Documentation Index
> Fetch the complete documentation index at: https://agent.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Agent 越多，我越忙：我如何走出 AI 编程的监工困境

> 从一次多 Agent 编排的审计出发，分享我现在使用的需求定义、独立验证和交付工作流，以及 core-grill、core-spec、deliver 三个 Skill。

![封面：你定目标和验收方式，冻结需求，一个 Agent 实现并自证，另一家模型验证，最后由你看决定、合入代码](https://mintcdn.com/agent-cn/vxw9ynfGxMwY779c/images/techblog/coding-agent-workflow-and-skills/cover.png?fit=max\&auto=format\&n=vxw9ynfGxMwY779c\&q=85\&s=9e13ae67aeb654a70b68be1727e06828)

我写过一个编排器，让多个编程 Agent 并行干活。结果，一次拆成 8 个模块的任务跑了 14 小时，其中约 76% 的时间只有一个 CLI 在工作。我原以为需要更多 Agent，审计完才改了主意。

这篇聊聊当时出了什么问题，我从 OpenAI、Anthropic 和 Lauren Tan 那里学到了什么，以及现在用的工作流和 3 个 Skill。

## 我从哪里开始

我是 MCode 的后端工程师。MCode 是 MiniMax 的编程 Agent，有桌面应用和终端界面。我写代码几乎全靠 Agent，第一优先用 MCode：我自己在做它，日常开发就先用它。同时也用 Codex 和 Claude Code 做交叉检查，看看它们会怎么处理同一件事。

为了做得更多，我写了 Agent Lord，让一个 Agent 会话把工作分给其他会话。从一个 Codex 会话出发，把功能拆成模块，每个模块交给一个独立的 CLI，通常是 MCode，在各自的 git worktree 里开发。互不依赖的模块并行做，评审时让两个模型家族互相检查，最后由一个整合者合并。在后来统计的那个月里，它派发了 490 次操作，涉及 214 个任务。

当时的想法很简单：同时干活的 Agent 越多，做完的事情就越多。

到了 9 月中旬，实际感受却不是这样。下面是我在同一天发给 Agent 的话：

> 我现在觉得特别繁琐，实现起来特别慢。

> tickets 需要这么多吗？不能合并？

> 这都读一小时了。

> 为什么不能多派点，只要不依赖，不能都派出去吗？

## 多加几个 Agent，解决不了这次的问题

最后那句话就是我当时的判断：并行度不够。Agent Lord 花了一晚上，分 8 个模块做 MCode Goal 功能的新版本。跑完以后，我让 Agent 审计这次执行，看看为什么真正并行的时间这么少。

* 最多只有 4 个 CLI 同时运行，平均 1.27 个。
* 限制并行度的不是 Agent Lord，而是计划：模块排成了一条依赖链，后一个要等前一个交付。
* 等待也没解决问题。下游模块仍然从原始代码开工，看不到上游刚写的代码，只能对着桩实现。真正的代码直到最后合并时才第一次碰到一起。
* 每个 CLI 内部，大部分时间在等模型，每轮通常只调用一个工具。有个模块来回了 91 轮，约 56 分钟，才写下第一个文件。

再加 Agent，也拆不开这条依赖链，更不会自动让下游读到上游的代码。留给我的只会是更多要检查的产出，以及更多可能丢失信息的交接。

## 真正的问题是什么

第二天，我让 Agent 扫了此前 30 天的全部会话，MCode、Codex 和 Claude Code 加起来约 1,700 个，想看看那次是不是个例。它们细读了 40 条任务链，并把引文和原始日志逐一核对。结果不是个例，有两个问题贯穿了整个月。

**Bug 发现得晚，而且是我发现的。** Agent 说做完了，测试也过了。等我自己用，或者把各部分接起来，问题才出现。

* Goal 功能的两个 PR 都被标记为完成，测试全绿。我跑开发版时发现，如果在 Agent 等待后台工作时更新目标，它就不再接着干了。
* 状态栏显示推理强度是 `xhigh`，会话实际按 `medium` 运行，因为新会话没把设置传下去。
* Goal 重做的各个模块都交付了，默认生产配置里却没打开这个功能。

每一部分都通过了自己的测试，坏在各部分之间的连接，以及用户真正使用功能时走的那条路径。

**我的大量时间花在向 Agent 转达决定上。** 已经定过的事要再解释，Agent 停了要检查，再告诉它继续。决定传不过交接。

* 8 月就定好了 MCode 的四档沙箱权限，到了 9 月，我还在跟 Agent 强调：四档，不要再加额外保护。
* 主会话把计划交给另一个 CLI 做交叉评审，擅自加了一句“保持精炼”。原本 875 行的计划被 279 行替换，逐文件迁移表、接口、连接步骤和验收检查都丢了。
* 我要求基于最新集成分支开 PR，结果开到了功能分支上。修正它，做了一次 rebase，还处理了三处合并冲突。

把这两件事放在一起，就能看清问题了。现在不缺写代码的能力，Agent 已经能做大部分。缺的是决策，而决定还是落在我身上。我成了整个需求交付的瓶颈：从一个需求的上下文切到另一个，做个决定，再切回去，直到注意力被耗尽。活在等我，不在等 Agent。

在这批审计过的会话里，两个环境缺口反复出现：Agent 不能操作自己正在开发的产品，已经确认的决定也不能可靠地跨交接保留下来。检查产品和重复决定都落到了我身上。并行任务越多，这两件事也越多。

## 我是怎么选中这三家的

![来源选择过程：自己的会话、Lauren Tan、按五类做法整理的 75 份资料、选定三家、回读原文](https://mintcdn.com/agent-cn/vxw9ynfGxMwY779c/images/techblog/coding-agent-workflow-and-skills/fig0-research.png?fit=max\&auto=format\&n=vxw9ynfGxMwY779c\&q=85\&s=6791ec3881b6ee29c96a1924f763062f)

我先看的是 **Lauren Tan**。她说自己一个月完成了 2,000 个 PR，我很想知道她是怎么做的。在演讲里，她希望 Agent 能“自己运行应用，替我采集 trace”。谈到把规模扩大到上百个 Agent 时，她提醒，这样做会失败，“因为你还没有建立起对 Agent 工作的信任”。这和我的审计结果对上了。（[演讲](https://x.com/poteto/status/2102050467505430555)，4:00 和 6:24）

接着，我把范围扩大到工程团队、Agent 开发者和研究资料。有的做固定流水线，有的强调 spec、任务跟踪，或者更大的 Agent 团队。最直接对应我那两个问题的做法是：让一个 Agent 从头负责，能运行真实产品，并把进度保存在文件里。

**OpenAI、Anthropic 和 Lauren** 都给出了具体机制。OpenAI 和 Anthropic 在做我每天使用的模型，以及基于这些模型的编程 Agent；Lauren 则提供了把这些想法用在生产代码库里的经验。三家都有足够具体的公开材料可以检查：pstack 的源码、OpenAI 的 ExecPlan 格式，以及 Anthropic 的提示词和失败复盘。

我借鉴的是做法，不是产量数字。Lauren 的 PR 数量和其他吞吐数字，都按作者自述看待。下面的引文保留来源链接，英文稿起草时已对照存档核过原文；中文引文均为译文。

最后留下一个想法：**Agent 要在真实产品上证明自己的工作，再由作者以外的一方检查这份证明。** 我在开头定义工作，在结尾看它做过的决定。中间尽量自动化，减少需要我介入和决策的地方。我把这套做法写成了 3 个 Skill，放在 [dev-skills](https://github.com/coder-xieshijie/dev-skills)，MCode、Claude Code 和 Codex 都可以用。

## 工作流一览

![工作流：你、负责交付的 Agent 和另一家模型在 A 到 D 四个阶段各做什么，以及你参与的三个位置](https://mintcdn.com/agent-cn/vxw9ynfGxMwY779c/images/techblog/coding-agent-workflow-and-skills/fig1-workflow.png?fit=max\&auto=format\&n=vxw9ynfGxMwY779c\&q=85\&s=62b8777f21f924e228b76feabd6d8703)

**A. 让应用能被 Agent 驱动，每个仓库准备一次。** 给 Agent 启动和操作应用的命令、功能地图、冒烟测试和质量检查。这来自 Lauren 的 verification skill 思路。每个应用都要单独准备，dev-skills 不附带这部分。

**B. 定义，由你和 Agent 一起完成。** `core-grill` 澄清需求，`core-spec` 记录决定和验证方式，再由另一个模型家族查漏。我确认后，将文件冻结在功能分支上，开一个草稿 PR。

**C. 交付，由 Agent 推进。** 我在新会话里运行 `/deliver <草稿 PR 链接>`。一个主 Agent 负责实现、测试、协调独立检查，处理 CI 和评审，直到 PR 可以合入。它在不可逆操作前暂停，并把过程中做过的决定记录下来，供我审阅。

**D. 回流。** PR 列出这次执行暴露的仓库缺口。我来判断，哪些要补进仓库工具，哪些要改进 Skill。

我只需要参与三个位置：回答问题，确认 `spec.md` 和 `verify.md`，最后看决定清单并合入。

## 三个 Skill 分别做什么

![三个 Skill 的输入与产出：需求、core-grill、决定汇总、core-spec、冻结的 spec 和 verify、草稿 PR、deliver、计划与证据、可合入 PR](https://mintcdn.com/agent-cn/vxw9ynfGxMwY779c/images/techblog/coding-agent-workflow-and-skills/fig2-artifacts.png?fit=max\&auto=format\&n=vxw9ynfGxMwY779c\&q=85\&s=2075523fdb4c07c434bd7b0292c8c03b)

### core-grill：只问会影响用户的决定

它先弄清楚需求、目标、怎样算完成，以及允许它做什么。仓库里能查到答案的问题，先自己查。

它问我的，是会改变用户体验的选择：行为、文案、默认值、入口，以及是否可能丢失数据。每个问题都带选项、后果和推荐。实现上的选择由它自己处理，采用的默认方案也记下来。最后，我确认它整理出的决定汇总。

### core-spec：写两份文件，由另一家模型检查，再冻结

它把决定汇总写成 `spec.md` 和 `verify.md`：前者记录定了什么，后者说明怎么证明做到了。

有用的地方是，先写检查，再写代码。每个场景都从真实入口出发，走完一次完整的用户操作，并写清楚旧代码应该表现成什么样。如果旧代码的表现不足以暴露风险，还要写出一种检查必须拒绝的错误实现。这样，需求里的缺口就得提前暴露出来。

另一个模型家族在全新的只读会话里检查两份文件，不带上作者的推理过程。找不到这个审阅者，就不冻结。查漏结束、我确认之后，两份文件冻结并提交，再开草稿 PR。`deliver` 只需要拿到这个链接，就能接着做。

### deliver：一个主 Agent 负责到底，直到 PR 可以合入

![deliver 内部流程：检出分支，按里程碑实现、运行场景、独立检查；向另一家模型征询决定；最终验证、脚本检查、交付可合入 PR](https://mintcdn.com/agent-cn/vxw9ynfGxMwY779c/images/techblog/coding-agent-workflow-and-skills/fig3-deliver.png?fit=max\&auto=format\&n=vxw9ynfGxMwY779c\&q=85\&s=cf69865afd5d1e6faf70b6d2ea70e95b)

主 Agent 用 OpenAI 的 ExecPlan 格式持续维护 `plan.md`，跟代码一起提交，让新会话也能接着干。

* **每个里程碑都要实现并验证。** 写完代码，在真实应用里运行对应场景，修复失败，再让一个全新的子 Agent 对照 spec 检查。
* **重要决定先听另一家模型的意见。** 如果选择会影响用户，或影响检查结果如何判定，就请另一个模型家族给意见，不透露主 Agent 偏好的方案。然后作决定，继续推进。
* **把决定写成我能审阅的清单。** 放在 PR 最上面，包括缺口、验证偏差和未完成项。每一项都说明，如果我推翻这个决定，哪些工作需要重做。冻结的 spec 和 verify 保持不变。
* **最后做独立验证。** 另一个模型家族在自己的会话和应用实例里检查最终代码。它提出的代码质量问题，主 Agent 要修复，或者解释为什么不修。

主 Agent 一直推进到 PR 可以合入，在合并、强推共享分支、修改共享环境等不可逆操作前暂停。

## 谁来检查什么

![检查分工：冻结前查漏、每个里程碑的独立子 Agent 检查、另一家模型参与决定和最终验证、交付脚本把关、最后由你审阅合入](https://mintcdn.com/agent-cn/vxw9ynfGxMwY779c/images/techblog/coding-agent-workflow-and-skills/fig4-checks.png?fit=max\&auto=format\&n=vxw9ynfGxMwY779c\&q=85\&s=e4239854850da9875b1614f08ae2a5ec)

主 Agent 全程都要自测，最终验收还需要独立验证者。`check-delivery.mjs` 检查四件事：

* `spec.md` 和 `verify.md` 还是我确认过的版本；
* 验证报告覆盖即将合入的代码；
* 验证结论是 `PASS`；
* 验证者和主 Agent 来自不同模型家族。

## 七条原则

![七条原则：OpenAI、Anthropic、Lauren Tan 各自的说法，以及这些原则在 dev-skills 中对应的位置](https://mintcdn.com/agent-cn/vxw9ynfGxMwY779c/images/techblog/coding-agent-workflow-and-skills/fig5-principles.png?fit=max\&auto=format\&n=vxw9ynfGxMwY779c\&q=85\&s=8632f1ebc3097133857163b5023af502)

每条都放上三家的说法，再讲它在 dev-skills 里落在哪里。

### 1. 你定目标和检查方式，然后走开

* **OpenAI**：“人类掌舵，Agent 执行。”（[Harness engineering](https://openai.com/index/harness-engineering/)）
* **Anthropic**：“给 Claude 一个它能运行的检查……这决定了你是要盯着会话，还是可以走开。”（[Claude Code best practices](https://code.claude.com/docs/en/best-practices)）
* **Lauren Tan**：“用你自己的话，给 Agent 一个目标，以及检查它的方法。”（[pstack guide](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/README.md)）

没有能运行的检查，Agent 只能判断工作看起来是不是完成了，最后就得由你来一轮轮测试。在 dev-skills 里，这对应 B 阶段。我又往前走了一步：把完整场景写进 `verify.md`，放在代码之前，由另一家模型审阅，然后冻结。

### 2. 一个 Agent 从头负责到尾

* **OpenAI**：在他们自己的仓库里，给出一个提示词，Agent 已经能从复现 Bug 一直做到合并修复，“只在需要判断时才找人”。（[Harness engineering](https://openai.com/index/harness-engineering/)）
* **Anthropic**：“一个设计得当、工具合适的单 Agent，能完成的工作远超许多开发者的预期。”（[Building multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)）
* **Lauren Tan**：“代码耦合的工作，比如一个功能、一次迁移，交给一个负责人。”（[pstack playbooks](https://github.com/cursor/plugins/tree/main/pstack/skills/poteto-mode)）

每次交接都会丢上下文。我的一次交接，就让计划少了将近 600 行。在 dev-skills 里，这对应 `deliver`：主 Agent 可以把编码、检查或场景运行交给子 Agent，但整合和决策仍由它负责。所以我把 Agent Lord 放到了一边。工作照样并行，只是由一个主 Agent 统一协调。

### 3. Agent 能运行、操作和观察真实产品

* **OpenAI**：“我们让应用能在每个 git worktree 中独立启动，这样 Codex 就能为每次改动启动并驱动一个实例。”（[Harness engineering](https://openai.com/index/harness-engineering/)）
* **Anthropic**：他们发现，Agent 自己做时，单元测试过了，却没意识到功能从头到尾根本用不通。要求它“像人类用户一样完成所有测试”后，表现好了很多。（[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)）
* **Lauren Tan**：验证 Skill 是“关键基础设施，而不只是一个 Skill”。（[The Complete Guide to pstack, Pt. 1](https://x.com/poteto/status/2094457600259842065)）

单元测试检查的是你想到要测的代码。实际操作应用，还会检查各部分有没有接好、默认值对不对、入口能不能用。我那些晚发现的 Bug，就出在这些地方。在 dev-skills 里，这对应 A 阶段和 `verify.md` 中的场景：从用户真正使用的入口运行，并记录旧代码的表现，避免写出一个怎么都不会失败的检查。

### 4. 计划和进度放在仓库文件里

* **OpenAI**：“应该始终能只靠 ExecPlan 就重新开始工作。”（[Using PLANS.md for multi-hour problem solving](https://developers.openai.com/cookbook/articles/codex_exec_plans)）
* **Anthropic**：“仅靠上下文压缩还不够。”每次会话都先读进度文件和 git 日志。（[Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)）
* **Lauren Tan**：“先读前面留下的记录，不要重做。”（[pstack playbooks](https://github.com/cursor/plugins/tree/main/pstack/skills/poteto-mode)）

如果状态只在聊天里，下个会话就只能猜。`deliver` 把进度写进 ExecPlan 格式的 `plan.md`，跟代码一起提交。有一次，我在 Claude Code 里跑的长任务被上游 API 错误打断，就换到 MCode 接手。新会话读了 `plan.md` 和 git 历史，不到半小时就找到了断点。

### 5. 做得对不对，由别人来判断

* **Anthropic**：“默认情况下，Claude 并不擅长做 QA。”他们的改进是：“把干活的 Agent 和判断结果的 Agent 分开，效果很明显。”（[Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)）
* **OpenAI**：“我们把几乎所有评审工作都交给了 Agent 之间互相完成。”（[Harness engineering](https://openai.com/index/harness-engineering/)）
* **Lauren Tan**：“让一个工作单元的验证者和执行者使用不同的模型家族。”（[pstack skills](https://github.com/cursor/plugins/tree/main/pstack/skills)）

作者的盲点就在它自己的上下文里，同一个模型家族也容易有相近的盲点。dev-skills 有三层检查：每个里程碑后找一个全新的子 Agent；查漏和最终验证交给另一家模型；合入前，我再看决定清单。第一次实际运行时，跨家族验证就抓到了同模型两轮检查漏掉的问题。

### 6. Agent 卡住时，修仓库，不只改提示词

* **OpenAI**：“Agent 遇到困难时，我们把它当作一个信号：找出缺少的东西——工具、防护机制、文档——再把它们补进仓库。”（[Harness engineering](https://openai.com/index/harness-engineering/)）
* **Anthropic**：`CLAUDE.md` 中的指令“只是建议”，而 hooks “是确定性的，能保证动作发生”。（[Claude Code best practices](https://code.claude.com/docs/en/best-practices)）
* **Lauren Tan**：“那条指令本身就是症状。”（[Encode Lessons in Structure](https://github.com/cursor/plugins/tree/main/pstack/skills/principle-encode-lessons-in-structure)）

提示词里的规则，是下一个 Agent 可能跳过的要求；写进代码的规则，每次都会执行。dev-skills 用两个脚本守住必须成立的条件：`freeze.mjs` 固定 `spec.md` 和 `verify.md`，`check-delivery.mjs` 检查交付结果。D 阶段则把每次执行里的阻碍，变成仓库工具的改进。

### 7. 复杂度值得加时再加，一次加一点

* **Anthropic**：建议“先找到尽可能简单的方案，只有需要时才增加复杂度”。（[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)）
* **OpenAI**：“优先做范围小的修正，不要每看到一个例子，就累积一条通用规则。”（[Codex skill-creator](https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/skill-creator/SKILL.md)）
* **Lauren Tan**：pstack 的 PR #419 删了 19 条指令。“每一处删减，都在会触及该指令的任务上做了 A/B 运行，比较有无这段文字的表现。”（[PR #419](https://github.com/cursor/plugins/pull/419)）

我在这件事上吃过亏。每次试跑后，就加一条规则，再加个脚本检查。`deliver` 的脚本从 3 个涨到 11 个，指令篇幅增加了约 70%。后来又删回 1 个脚本，指令缩到此前的一半以下。前后四天，这套工作流改了 32 个版本。

## 怎么用

**先准备这些：**

* 两个模型家族。我在 MCode 里开发，检查交给 Codex，它和我在 MCode 里用的模型不是同一家；Claude Code 加 Codex 也可以。查漏和最终验证必须交给没负责实现的那一家，对应 CLI 要装好并登录。
* Node.js 24、git，以及 `gh` 或 `glab`。
* 一个 Agent 能在 worktree 里启动、操作和观察的应用，也就是 A 阶段。dev-skills 的[仓库准备指南](https://github.com/coder-xieshijie/dev-skills/blob/main/docs/repository-readiness.md)写了需要准备什么，Lauren 的 [create-verification-skill](https://github.com/cursor/plugins/tree/main/pstack/skills/create-verification-skill) 也可以作为起点。

**安装交给 Agent。** 把下面这段话贴进 MCode、Claude Code 或 Codex：

```text theme={null}
帮我安装 dev-skills：https://github.com/coder-xieshijie/dev-skills
按 README 中 “From a clone” 一节，选择适合你当前客户端的安装步骤。
如果已经安装了 dev-skills 插件，先停下来告诉我。
安装后列出你链接好的 Skill。
```

它会克隆仓库，把每个 Skill 链接到当前 Agent 读取的目录。以后要更新，就让它拉取最新版 dev-skills。MCode 是我每天都在用的，体验非常好；还没试过的话，很推荐试试。

**在目标仓库里运行：**

```text theme={null}
/core-grill 需求是 <链接或文字>，文档放在 <目录>/。
/core-spec 根据决定汇总，写出 spec.md 和 verify.md。

# 在新会话里运行
/deliver 接手 <草稿 PR 链接>。
```

1. `core-grill` 提问，你回答，并确认最后的决定汇总。
2. `core-spec` 写 spec 和 verify，请另一家模型查漏。你读结果并确认，它再冻结文件、开草稿 PR。
3. `deliver` 推进到 PR 可以合入。你看 PR 顶部的决定清单，再合入。

在 Codex 里，把 `/` 换成 `$`。

## 来源

**OpenAI**

* [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)，Ryan Lopopolo（@\_lopopolo）
* [Using PLANS.md for multi-hour problem solving](https://developers.openai.com/cookbook/articles/codex_exec_plans)（ExecPlans）
* [Codex skill-creator](https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/skill-creator/SKILL.md)

**Anthropic**

* [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
* [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
* [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
* [Building multi-agent systems: when and how to use them](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)
* [Claude Code best practices](https://code.claude.com/docs/en/best-practices)

**Lauren Tan（@poteto）**

* [The Complete Guide to pstack, Pt. 1](https://x.com/poteto/status/2094457600259842065)
* [pstack guide](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/README.md)
* [pstack skills and playbooks](https://github.com/cursor/plugins/tree/main/pstack/skills)：poteto-mode（feature、orchestrate、session-pickup）、principle-encode-lessons-in-structure、create-verification-skill
* [pstack PR #419](https://github.com/cursor/plugins/pull/419)
* [X 上的演讲](https://x.com/poteto/status/2102050467505430555)（2026 年 9 月）
