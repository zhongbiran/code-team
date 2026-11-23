> ## Documentation Index
> Fetch the complete documentation index at: https://agent.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 给 Coding Agent 建一座试验场

> 从 MiniMax Code 出发，搭建能验证 Harness 改动的评测系统。

![给 Coding Agent 建一座试验场：如何构建可信的 Harness 评测](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/eval-cover.jpg?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=892ecb996f3233f0df13e1af4a9f46b9)

[上一篇](https://agent.minimaxi.com/docs/techblog/minimax-code-harness)聊了 MiniMax Code 背后的 Harness 设计。这次我想接着谈一个更难回答的问题：改完 Harness，我们怎么知道它变好了？

拿上下文压缩来说。换了一个 checkpoint 格式，几个长任务跑下来，Agent 好像更少忘事了。这个结果当然值得继续试，但我还不敢据此判断该不该合入。也许这几次任务碰巧简单，也许模型服务刚好稳定。甚至有可能，压缩时省下的 token，后面又被重复读文件花了回去。

我希望评测能帮我们把这些情况分清楚。具体到工程上，就是一道任务怎样准备、Agent 怎样运行、结果由谁验收，以及最后怎样比较两个版本。这篇用已经开源的 [MiniMax Code](https://github.com/MiniMax-AI/minimax-code) 来讲这套设计。执行入口和采集接口已有源码可看，外部 Runner、任务协议和评分流水线则是本文要搭建的部分。

## 01　一道评测题，得带上环境和验收方法

假设我们出一道题：修复解析器的边界问题，保留旧 API，不许改测试。

把这句话写进 prompt 还不够。仓库在哪个 commit？依赖装好了吗？Agent 能联网吗？如果上次运行已经生成了修复文件，这次就不是从同一个起点开始了。

我会把这些条件放进一个任务包：指令、初始环境、允许的操作、预算，以及验收程序。模型、Harness 和评分器的版本各自记录，只留一个仓库 commit 往往对不上完整的运行条件。任务包可以长这样：

```yaml theme={null}
# task.yaml — 评测层协议示例，非 mcode 配置格式
id: parser-compat-017
revision: 3
instruction: instruction.md
initial_state:
  repository_commit: <full-commit-sha>
  environment_image: <image-at-sha256-digest>
  fixture_digest: <sha256>
  network_policy: model-proxy-only
resources:
  cpu_cores: 2
  memory_limit_mib: 4096
budget:
  agent_wall_seconds: 900
  assistant_steps: 80
  verifier_wall_seconds: 120
acceptance:
  verifier_revision: <full-commit-sha>
  required: [behavior, regression, integrity]
  protected_paths: [tests/**, public-api.json]
```

这是评测层的示例协议，不是 mcode 的配置格式。尖括号里的值在任务入库时要换成真实的 commit、镜像 digest 和文件摘要。900 秒、80 步也只是示例预算，需要用任务校准。

Agent 可以看到需求、代码和公开测试。参考修复、隐藏测试及评分程序留在评测侧。管理上把它们放在同一个仓库没问题，挂载环境时得分开，否则答案可能和题目一起送进去了。

资源限制也得真的生效。配置里写了 4 GiB，实际却允许临时超用，和一到上限就终止进程，跑出来的结果可能不同。最终采用的限制要记下来。

[Harbor 的任务格式](https://docs.harborframework.com/core-concepts/tasks/overview)把指令、环境和验收脚本放在一起，可以参考。任务入库之前，我会先检查未修复版本是否确实失败、参考修复能否稳定通过。还要在干净环境重跑，排除本机残留文件，以及失效网页这类外部依赖。不然测了一晚上，第二天才发现题本身就有问题。

## 02　Runner 的工作不止是启动进程

这里约定一下名字：task 是一道题，trial 是某个版本做这道题的一次尝试。每个 trial 都拿到独立的运行环境、数据目录和产物目录。上一次的记忆、登录配置、缓存和后台进程，不能悄悄影响下一次。

Runner 按下面几个阶段执行。状态变化要落盘，调度器重启后才能知道哪些还没开始、哪些仍在跑、哪些只差评分。重复执行一次任务会多花钱，也可能让结果混进两次运行的产物。

![一次评测，完整封存：准备环境、运行 Agent、冻结产物、独立验收、封存与清理](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/eval-runner.jpg?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=7f1f51ff8cb6cfb96b766df0251f5090)

*Runner 管理运行状态；原始记录保存在宿主侧，Agent 无权改写。*

准备时校验任务指纹、镜像和初始文件，确认环境健康，再启动 Agent。执行结束后先停止后台进程和文件写入，冻结产物，然后交给评分器。即使中途失败，也要收集证据并清理环境。

这里很容易低估隔离的范围。建一个 Git worktree 并不会清掉用户数据目录里的记忆，也隔离不了端口、插件配置和外部数据库。每个 trial 用到的外部服务要有独立命名空间，资源配额也要落实。只读依赖缓存可以共享，但内容要固定；计时里是否包含缓存预热，同样得约定。

我会保留两层超时：Agent 自己的任务时限，外加 Runner 的看门狗。内部取消失效时，外部仍能终止整个进程组或容器，并记录强制终止的原因。准备环境、运行 Agent、验收结果分别计时，否则依赖下载慢一点，就可能被算成 Agent 性能退步。

如果实验有费用上限，计费要覆盖重试、压缩和子任务里的模型调用。统一模型网关可以累计用量并执行停止策略，最终回答里的 usage 留作对账。等回答出来才知道花了多少钱，已经来不及控制预算了。价格表和缓存计价方式也要固定，缺失用量另作标记。

## 03　用真实的 MiniMax Code 跑任务

适配器只做启动、读输出、停止和收集产物这些事。工具调度、上下文压缩、模型重试继续交给 MiniMax Code。为了方便评测重写一套执行循环，可能把最想测的 Harness 行为也换掉了。

MiniMax Code 已有 `mcode exec`，可以指定工作目录、配置、超时和步数上限，并输出 `stream-json`。在准备好的隔离环境里，启动方式如下。变量由 Runner 填入，使用前需要准备对应的目录和配置。

```bash theme={null}
# 已固定 mcode 构建、模型与配置；每次 trial 使用全新 DATA_DIR
# RAW_DIR 是 Agent 环境之外、由 Runner 持有的日志目录。
MINIMAX_DATA_DIR="$DATA_DIR" mcode exec \
  --cwd "$WORKSPACE" \
  --config "$RUN_CONFIG" \
  --input - \
  --output-format stream-json \
  --timeout 15m \
  --max-steps 80 \
  < "$INSTRUCTION_FILE" \
  > "$RAW_DIR/stdout.jsonl" 2> "$RAW_DIR/stderr.log"
```

实际接入时，我会用进程 API 同时读取 stdout 和 stderr，避免管道写满。如果 Agent 在容器里运行，日志流接回宿主保存。上面这条命令没有包办环境准备、权限策略和清理，这些还要由 Runner 实现。

JSONL 事件里有 `schemaVersion`、`sequence`，以及 `runId`、`sessionId`、`turnId`。适配器验证事件的版本、身份和顺序，按 item ID 合并增量，同时保存原始流。遇到截断行、重复终态或错误的 runId，要留下异常记录。

终态事件 `exec.completed` 携带执行结果。`status: succeeded` 只说明这次执行成功结束，代码有没有改对，仍要验收。`--output-schema` 也只校验最终回答的结构。回答 JSON 再规整，测试照样可能失败。

还会有连终态都来不及输出的情况，比如预检失败或进程崩溃，所以退出码和 stderr 要一起收集。Headless 运行如果卡在需要人回答的问题上，就按预先约定的无人值守或交互任务规则处理；临时帮其中一组回答，会改变实验条件。

接适配器时，可以直接对照 [CLI 契约](https://github.com/MiniMax-AI/minimax-code/blob/14053355f39c9bc4575650ce0f48a3ae3cff9285/packages/tui/src/cli/contract.ts)、[事件投影](https://github.com/MiniMax-AI/minimax-code/blob/14053355f39c9bc4575650ce0f48a3ae3cff9285/packages/tui/src/headless/events.ts)和[结果类型](https://github.com/MiniMax-AI/minimax-code/blob/14053355f39c9bc4575650ce0f48a3ae3cff9285/packages/tui/src/headless/contract.ts)。

## 04　测试全绿，也得看是谁改的测试

Agent 能改工作区里的测试、构建脚本和依赖。它输出一行“全部通过”，甚至真的把测试跑绿了，都还不足以验收。

对代码修改任务，我会先冻结最终工作区，由宿主检查受保护文件、文件类型和修改范围，再把允许交付的变更放进干净的验收环境。镜像、测试入口和隐藏测试由评测侧固定。候选代码仍然不可信，运行它的 Verifier 也需要隔离。

导出产物时也有细节。只存一份普通 Git diff，可能漏掉未跟踪文件、二进制文件、权限变化或符号链接。产物协议得把这些写清楚。如果交付的是服务状态或数据库变更，还得保存相应快照，并从外部检查实际行为。

![评分权，留在 Agent 之外：Agent 环境与 Verifier 环境之间的信任边界](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/eval-verifier.jpg?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=d08e7241a8a2e970f57c8c341027ca20)

*Agent 交付候选产物，评分程序和隐藏测试留在独立环境里。*

回到解析器这道题：行为测试、既有功能回归和完整性检查应该分别给出结果。三项都通过，任务才算完成。删掉测试换来的通过，不能靠其他项多得几分抵消。

比如下面这条示例记录，执行正常结束，行为测试也通过了，但受保护文件被改过，所以 `accepted` 仍是 false。这是数据结构示例，不是真实跑分。

```json theme={null}
{
  "trial_id": "parser-compat-017/B/03",
  "execution": {"status": "succeeded"},
  "validity": {"status": "valid"},
  "checks": {
    "behavior": "pass",
    "regression": "pass",
    "integrity": "fail"
  },
  "accepted": false,
  "failure_code": "protected_file_changed"
}
```

评分器写完以后，我最想试的是它会不会接受坏答案。完全不改代码、只修普通输入、删除测试、伪造输出，都可以作为测试样本。再加上利用文件链接绕过保护路径的情况。参考修复能通过，只验证了评分器的一半工作。

“实现是不是过度复杂”这类问题，很难写成自动断言，可以交给 LLM judge。模型和 rubric 要固定，结论要引用具体文件或轨迹位置。成对评审时隐藏候选身份、随机交换顺序，再拿人工标注的样本检查误判。Agent 留下的文字是待评材料，即便它写着“忽略之前的评分规则”，也不能成为 judge 的指令。

## 05　拿一次压缩改动做实验

现在有了运行和验收流程，可以回到开头那个问题：改进 checkpoint 里保留用户约束的方式，能不能减少压缩后的约束违背？

MiniMax Code 的压缩实现已经有工具输出归档、checkpoint，以及程序附加近期状态等机制。这次只改约束的保留方式，其他提示词、归档阈值、模型和预算保持一致。几处一起改，即使效果好了，也很难判断是哪处起了作用。

这个实验我会分两层做。先检验局部机制：等工具调用结算、后台写入停止，在压缩前保存一份共同状态，让基线和候选分别从这里继续。观察用户约束是否还在、早先的证据能否读回，以及后面有没有重复劳动、能否完成任务。

这份状态不能只有 messages。工作区、会话、压缩状态和后续会引用的归档产物都要恢复；依赖数据库或外部服务的任务，还要恢复那些资源。归档文件在原机器上能读到，换了目录之后引用失效，也会影响实验。公开 CLI 目前不能直接一键完成这套分叉，需要另做触发压缩和恢复状态的测试接口。

然后从任务起点再跑端到端实验，用实际部署的上下文容量和触发策略。候选版本可能更早触发压缩，也可能少读几次文件、换一种工具调用顺序。这些变化都是完整策略的效果，要算进去。

![压缩评测，要做两层实验：局部机制检验与端到端检验](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/eval-compaction.jpg?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=b75812fd0900680a382cfead970858d0)

*两类实验分开报告：局部实验比较同一起点后的行为，端到端实验观察整个任务。*

有些运行可能根本没有触发压缩。它们仍然属于端到端结果，只需标记“未触发”。如果事后只挑发生过压缩的任务比较，就有了选择偏差：候选策略本身可能改变触发概率，两边留下的已经不是同一批情况。想解释压缩这一步的因果作用，还是要回到预先规定触发条件的局部实验。

出题时也得让压缩真的有影响。比如早期提出的兼容性限制，到后面的代码修改时仍需遵守；早期工具输出里的证据，后面还要用。长任务再覆盖多次压缩。单纯塞一大段无关文字，可以测试长输入下的行为，却很难回答 Agent 会不会忘掉有用信息。

## 06　分数之外，要留下哪些记录

某道题退步了，我希望能找到它读过什么、调用过哪些工具、在哪一步偏离了要求。评分器改了，也应该能拿旧产物重新验收。这是评测里做可观测性的实际用途。

记录可以按用途分开存。运行清单保留版本与实验条件，轨迹保留模型和工具事件，产物目录保存最终文件、环境快照与验收输出。重新评分时给出新的 grade revision，关联同一个冻结产物，不覆盖旧分数。

运行清单里只写模型名字不够。还需要模型配置和能拿到的服务版本、Harness commit、展开后的 prompt 与工具 schema 指纹，以及任务、评分器版本。权限策略、资源与预算、实验组和重复编号也要能查到。服务端版本固定不了，就记录运行时间窗口，把这个限制带进分析。

MiniMax Code 的 eval reporter 已有模型调用前快照、工具调用与结果、usage 和回合结束等采集接口。采集失败不会中断 Agent 的正常运行，这个取舍适合产品；放进评测之后，还得补上证据完整性标记。日志里没有某次调用，可能只是没采到。

用量也会缺失。`ExecResult` 里的 `usageSource` 和 `usageIncomplete` 就是为这类问题保留的信息；失败、压缩等场景下，账目可能不完整。算成本时，未知部分保留未知，能确认的费用记作下界。把缺失填成零会低估成本；把可能重叠的缓存、推理和总 token 字段直接相加，则可能多算。

失败怎么处理，也要提前定。下面这张表是一种可用的约定：

| 观察到的情况 | 结果处理 | 是否重试 |
| - | - | - |
| 环境启动前，镜像拉取失败 | 调度基础设施错误，保留记录 | 可按预定上限重新启动 |
| Agent 因循环或昂贵操作用尽预算 | 任务失败，进入通过率分母 | 不因失败而补跑到成功 |
| 候选触发已声明的内存上限 | 该资源约束下的运行失败 | 按任务规则处理 |
| 评分器自身崩溃 | 暂无有效评分，不能记为通过 | 对同一冻结产物重评分 |
| 缺少压缩事件，但产物验收完整 | 可保留任务结果，机制诊断不可用 | 标记证据缺口 |
| Agent 实际提出需要人工回答的问题 | 按无人值守或交互任务协议判定 | 不进行临时人工兜底 |

用尽预算和机器故障看起来都可能是“进程没了”，需要靠事件与资源记录区分。每次重试保留原 trial、原因和新的 attempt ID。报告里同时给出基础设施错误率和任务覆盖率，否则删掉几次失败，分数就好看了。

补跑达到上限仍没有有效评分，就报告缺失和它对结论的影响。模型调用失败也不能一律归为外部故障：如果这次评测要考察 Harness 的恢复能力，它本来就在考题里。哪些情况排除，按实验开始前的约定处理。

## 07　怎样比较两个版本

A/B 两组先对齐任务、模型配置和预算，在同一时间窗口内随机交错运行。并发度、限流、冷暖缓存也要一致。一组上午跑、一组晚上跑，服务波动就可能混进版本差异。

资源分配本身也要控制。Anthropic 的[基础设施噪声研究](https://www.anthropic.com/engineering/infrastructure-noise)讨论过资源配置对 Agent 编程评测的影响。所以 CPU、内存、网络和时限都应和模型配置一起记录。

每道任务跑多少次，在开始前约定。先算同一道任务在两组中的通过比例，再比较差值。第 i 个任务的通过比例记为 pᴀ,ᵢ 和 pʙ,ᵢ；任务等权时，整体差值是 Δ = (1/N) Σᵢ(pʙ,ᵢ − pᴀ,ᵢ)。如果想按真实使用分布加权，提前定好权重。某道题多跑了几遍，不应因此在总分里更重要。

![怎样证明一次改动真的更好：同任务 A/B 对照、按任务汇总差值、独立留出集](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/eval-ab.jpg?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=d084a7919d784281b34a564c0c350553)

*先比较每道任务，再汇总差值和不确定性；最后用独立留出集验收冻结的候选。*

同一道题重复十次，能看出运行有多不稳定，但覆盖的仍然是一种场景。估计对新任务的收益时，可以按任务做配对的 cluster bootstrap，重采样时保留 A/B 关系。如果多道题来自同一个仓库、彼此高度相关，就按仓库或任务家族聚类。任务少时，区间也未必可靠，不如把逐题结果一起列出来。

我会特别看候选新引入了哪些失败。总通过率上升，也可能掩盖某类任务的明显退步。完整性违例和人工介入要单列，成本则把失败尝试也算进去。“本组所有尝试的总费用 / 成功任务数”可以表示每完成一项任务的成本；成功数为零，或用量不完整时，这个估计需要标明无法计算或不完整。

延迟报告也要保留超时。列出所有尝试的运行时长和超时比例，成功样本的延迟另算。跑到截止时间被杀掉，不能算作刚好在那一秒完成。如果产品允许多次尝试取最好的结果，就把尝试次数和预算一起报告，别拿它和单次运行直接比较。

接受候选的门槛最好在开跑前写下来：质量允许退步多少、希望提高多少、费用能增加多少，完整性检查有什么硬要求。具体阈值由产品目标决定。看到分数以后再调门槛，很容易给自己想合入的改动找理由。即便这次没观察到违例，也只能说明这批运行里没有出现。

## 08　别把评测集调成了开发集

把真实失败收进回归集很有用。但一直盯着同一批题改 Harness，我们也会越来越熟悉这些题，分数上涨未必代表新任务做得更好。

开发集拿来复现和调参，验证集用来选候选，最终留出集等候选冻结以后再用。切分按仓库、问题家族或时间段做，防止同一道题换个名字出现在两边。留出集看得多了、拿来改策略了，就应当承认它已经是开发集的一部分。

压缩实验可以有定向任务集，但还要跑常见任务的回归，检查副作用，并定期补充新任务。只收失败案例，会让困难场景占得过多；只收适合演示的任务，又会把系统想得过于可靠。

这套评测也不必每个 PR 全跑一遍。协议、评分器和短回归先跑；改到压缩、工具或权限时，再触发相关的行为评测。昂贵的重复实验和新任务测试按预算定期安排。源码里的 `pnpm verify` 继续检查工程正确性，真实模型的任务表现另行评测，两边各自报告。

如果现在动手，我会从一道任务开始：重置环境，启动 MiniMax Code，独立验收，留下能复查的产物。再拿几个已知好坏版本试评分器。等这些都跑通了，才增加任务数和并发。先做大规模调度，很可能只是把排查问题的难度也一起放大。

MiniMax Code 的公开源码里已经有运行入口、结构化事件和评测采集接口。想动手的话，可以接一个 Runner，也可以先贡献一道能稳定复现失败的任务，或检查评分器会不会误收坏答案。这些工作都能帮助判断下一次 Harness 改动该不该保留。

项目在 [GitHub](https://github.com/MiniMax-AI/minimax-code)。欢迎带着复现和实验来讨论；觉得这篇有用，也欢迎点个 Star。

## 实现与参考入口

源码核对版本为 `14053355f39c`。文中的任务协议、外部 Runner 和分叉实验是设计方案；本文没有运行在线模型对照实验，也不报告性能提升。

* [MiniMax Code：headless CLI 参数](https://github.com/MiniMax-AI/minimax-code/blob/14053355f39c9bc4575650ce0f48a3ae3cff9285/packages/tui/src/cli/contract.ts)
* [MiniMax Code：JSONL 事件与终态](https://github.com/MiniMax-AI/minimax-code/blob/14053355f39c9bc4575650ce0f48a3ae3cff9285/packages/tui/src/headless/events.ts)
* [MiniMax Code：结果与用量契约](https://github.com/MiniMax-AI/minimax-code/blob/14053355f39c9bc4575650ce0f48a3ae3cff9285/packages/tui/src/headless/contract.ts)
* [MiniMax Code：用量聚合与不完整标记](https://github.com/MiniMax-AI/minimax-code/blob/14053355f39c9bc4575650ce0f48a3ae3cff9285/packages/tui/src/headless/runner.ts)
* [MiniMax Code：eval reporter 接缝](https://github.com/MiniMax-AI/minimax-code/blob/14053355f39c9bc4575650ce0f48a3ae3cff9285/packages/local-runtime-v2/src/service/turn-system/agent-host/runner/eval-reporter.ts)
* [MiniMax Code：checkpoint 与状态保留](https://github.com/MiniMax-AI/minimax-code/blob/14053355f39c9bc4575650ce0f48a3ae3cff9285/packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/checkpoint-format.ts)
* [Harbor：任务结构](https://docs.harborframework.com/core-concepts/tasks/overview)
* [Harbor：独立评分环境](https://docs.harborframework.com/core-concepts/tasks/separate-verifier)
* [Anthropic：基础设施对 Agent 评测的影响](https://www.anthropic.com/engineering/infrastructure-noise)
