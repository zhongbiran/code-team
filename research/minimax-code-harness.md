> ## Documentation Index
> Fetch the complete documentation index at: https://agent.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# MiniMax Code 正式开源：拆解 Coding Agent 背后的 Harness 架构

> 沿着一次任务的执行路径，拆解 MiniMax Code 如何装配每轮能力、管理上下文、执行工具、提交历史，以及在多 Agent 协作中确认子任务结果。

![MiniMax Code：Inside the Harness](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/harness-cover.jpg?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=9578bc5bea05b08b84cb21c3049600ea)

9 月 18 日，我们在[《MiniMax Code CLI 正式开源》](https://mp.weixin.qq.com/s/aZTOlQUnULqptBgGGKZXEg)中发布了 v0.4.12，并以 MIT 协议开放源代码。MiniMax Code CLI 是 MiniMax Code 客户端的核心组件，这次也把它背后的 Harness 实现交给了社区。

> [!NOTE]
>
> GitHub 仓库：[github.com/MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code)

![MiniMax Code CLI 启动界面](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/harness-cli.jpg?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=5cb42d40c6a972f357b6b2cdaa931991)

发布文中引用了一轮基于 FrontierHarness Eval 的评测：MiniMax Code v0.3.2 搭配 Kimi K3，30 道任务通过 23 道，通过率为 76.7%，成功任务耗时中位数为 4 分 33 秒。[评测报告](https://github.com/frontier-harness-eval/eval/pull/13)保留了结果和比较口径。

![FrontierHarness Eval：通过率与成功任务耗时中位数](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/harness-eval-speed.png?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=90271465f3d466be6418c6769aabd3e2)

![FrontierHarness Eval：通过率与每次通过的记录成本](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/harness-eval-cost.png?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=f30e0857c829e85544d38a39e755df16)

这篇接着讲代码。比如，工具改好文件后，进程在历史提交前退出，会话恢复时还能否知道刚才发生了什么？模型已经读过工具说明，插件却在执行前更新了，又该用哪个版本？这些问题要沿着 runtime 的状态和调用顺序去查。

开源发布时，我们提到希望开发者能审视工具调用和权限处理。下面就从整体架构开始，具体看每轮能力如何装配、工具什么时候获准执行、上下文如何压缩，以及历史和子任务结果何时完成确认。

## 1. 一个任务进入 MiniMax Code 后，发生了什么

假设我们交给 MiniMax Code 一个任务：修复某个函数的边界条件，检查相关调用方，再运行测试。模型可能先搜索代码，读取几个文件，提出修改，最后根据测试结果决定是否继续。一次用户请求会经过多次模型推理和工具执行。

MiniMax Code 的三个入口，交互式 `mcode`、适合脚本的 `mcode exec` 和面向兼容客户端的 `mcode acp`，都经由 `CliService` 和 local applications 使用同一套进程内 runtime。CLI 启动时，`createEmbeddedRuntimeHost()` 创建本地 host，等待 ready 后取得 `CliService`，无须经过 Desktop HTTP 服务。模型请求和部分工具仍会访问远端。

![MiniMax Code runtime 执行架构](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/harness-runtime.jpg?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=286bf4c7a29138ecb5ada8a55c3260da)

任务进入后，Session 保存跨轮次的工作状态，包括对话历史、会话配置和任务关系。runtime 接纳本次执行，创建有独立身份、取消信号和最终状态的 Turn。模型请求和工具 step 都发生在这个 Turn 内部。

这轮执行由 `LocalAgentHost` 组织。它准备本轮运行环境，通过 `agent-runtime` 装配能力，再交给使用 Pi 组件的 `PiTurnRunner` 驱动模型与工具循环。Session 系统负责历史存储与恢复。

循环开始时，runtime 准备当前模型请求。模型如果提出工具调用，runtime 就检查并执行，把结果提交到历史，供后续请求使用。示例任务里的搜索结果、文件内容和测试输出，会在这个过程中逐步进入上下文。模型返回最终答复或执行被中断后，Host 还要处理历史和 Turn 状态的收尾。

因此，一次 Turn 可以包含多次模型请求；Session 又可以跨越多个 Turn。`PiTurnRunner` 本身可以复用，但每次 `runTurn()` 都会新建 Agent、事件桥、事件队列和历史游标。本轮的可变对象随本轮创建，需要留给下一轮的信息由会话层保存。

后面几章就沿这条循环展开：先看每次请求模型前如何准备输入，再看模型提出的操作怎样被执行和记录，最后把同一套过程扩展到子 Agent。

## 2. 每次请求模型之前，Harness 要准备什么

为了修复示例中的函数，模型需要读到任务要求和已有调查结果，也需要知道可以用哪些工具。随着执行推进，这份输入会不断变化：刚读出的文件要加进来，测试日志可能很长，插件配置也可能在任务运行期间更新。

这里有两项约束需要同时满足：输入中的工具说明必须与本轮实际使用的能力匹配；整份请求必须放得进模型窗口。MiniMax Code 分别通过能力装配和上下文管理处理它们。

### 先固定本轮能力，再构造请求

扩展 Registry 的正常状态流转是 `new → initializing → ready`，初始化失败则进入 `failed`。扩展通过带 owner 归属的接口注册能力，而且只能在自己的初始化窗口内注册。初始化没有完成的 registry 不能按正常可用的 registry 使用。

进入 `assembleTurn()` 后，Registry 会在第一个 `await` 之前同步快照扩展的启用状态。中途调用 `setEnabled()`，要等下次装配才生效。每轮 hooks 用本轮 `ctx` 创建独立闭包，防止并发装配时串用上下文。

插件能力则按版本租用。Turn capability lifecycle 为新接纳的执行取得一份带 revision 的能力视图，里面包括 plugins、skills、runtime tools 和 hooks。捕获视图与登记在途执行之间没有 `await`，两步在同一个 JavaScript 同步临界段内完成；执行结束后再释放引用。

这样，模型读过某一版工具说明后，插件更新不会把本轮能力悄悄换成另一版。新版本供后续接纳的 Turn 使用。固定的是能力视图，工具访问的文件和远端服务仍会变化。

工具说明本身也占上下文。MCP 披露策略会先检查开关、模型白名单和有效窗口，再估算已配置 MCP 工具的说明体积。达到阈值时，候选工具进入搜索索引和延迟调用 registry，其他工具继续直接暴露。默认阈值是窗口的 15%，实际是否启用还受模型门槛和配置覆盖影响。

延迟披露省下了整批工具说明的空间，但模型要多做一步发现工具的操作，能否找到合适工具也取决于检索质量。

### 文件和测试输出越来越多，下一次请求还能否发出

能力准备好后，还要把本轮历史转换成模型输入。MiniMax Code 的本地 footprint measurer 连同 system prompt、工具定义一起估算 token，并计算这份请求表示的 UTF-8 序列化字节数。本地估算与 provider 对最终 wire payload 的精确计数可能有差异。

预算要为输出和后续执行留出空间。设上下文窗口为 `C`，输出上限为 `O`，预留量为 `R`，安全余量为 `S`。当前共享默认值为 `R = 16,384`、`S = 2,048`。

当 `C − O − S ≥ R` 时，预算计算使用完整输出量 `O`；否则使用 `min(O, R)`，记为 `O_eff`。输入上限为：

`L = max(1, min(floor(0.95 × C), C − R, C − O_eff − S))`

自动触发压缩的阈值设在更早的位置：

`T = min(L, max(1, C − min(2 × R, floor(C / 4))))`

例如，窗口为 `131,072`、输出上限为 `16,384` 时，代入默认值可得 `L = 112,640`、`T = 98,304`。这意味着还没顶到输入上限，就要开始处理上下文。换模型或配置后，需要重新计算。

示例任务如果读入大量源码和测试日志，runtime 装配的 `ToolResultArchiver` 会根据输出水位、候选大小、近期轮次保护和预期收益选择归档对象。它先生成不改动状态的计划，再实际归档。有 `read` 工具时，较大的旧输出可以换成归档凭据，原文保留在本地供后续读取。

归档候选要经过检查：token 或字节体积至少有一项减少，token 落在输入预算内，字节数也满足限制。没有显式字节上限时，候选的序列化体积不能超过归档前。

归档候选无法直接满足条件时，再走 LLM checkpoint 路径。生成的 checkpoint 要经过校验，替换历史后重新测量请求。最终仍超限，就返回 `POST_ADMISSION_FAILED`。因此，判断压缩是否完成，要看包含 prompt 和工具定义的下一次请求是否满足限制。

![准备下一次模型请求：归档、checkpoint 与完整请求校验](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/harness-context.jpg?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=cd7f7d81e09ca963ed46ce9b74d52abd)

生成 checkpoint 的请求本身也可能太长。输入降级路径会尝试处理工具输出、媒体和中间历史；缩减历史时按工具交互闭包处理，保留 tool call 与 result 的对应关系。即使体积符合限制，压缩仍可能丢失任务信息，评估时需要检查模型是否漏掉约束或重复调查。

为辅助判断何时压缩，进程内还有 usage anchor：从符合条件的 assistant usage 建立锚点，加上后续增量估算，再与当前本地估算取较大值。锚点绑定会话范围、provider、API、model、system prompt／tools 指纹、history epoch 和锚定消息身份；换模型、改工具或替换历史后，要重新校验它是否适用。

压缩前后候选的比较仍使用 fresh estimate 分别测量。历史锚点可以辅助触发判断，不能替代当前候选的验证。处理完这些内容，runtime 才能带着本轮能力和当前上下文继续请求模型。

## 3. 模型提出操作后，Harness 如何执行并记录结果

现在，模型读完代码，决定调用工具修改文件。接下来有两个需要分别确认的事实：这个操作此刻能否执行，执行结果是否已经进入下一步可用的历史。工具返回了输出，只回答了其中一部分。

### 工具开始前，重新检查执行资格

工具控制链先检查本轮是否有重复的 tool-call ID。对于带 host `tool_ref` 的委派调用，还要解析实际执行目标，再经过 safety／plugin 前置逻辑、工具策略和扩展 hooks，进入权限判断。后续检查拿到实际目标，避免权限只查了包装工具。

假设工具正在等用户批准，用户却先取消了任务。批准结果回来时，即使权限允许，原来的 Turn 也可能已经结束。因此，控制链在权限通过后还要尝试 `openToolResultTail()`，只有匹配的活动 Turn 仍处于 `running` 阶段才会成功。

Turn 控制器会核对 `sessionId`、`turnId`、`leaseId`、接纳序列、执行原因和 signal 身份。同一会话可以先后运行多轮，旧轮次的回调不能接管新一轮。这里的 lease 用于拒绝当前 runtime 内的过期执行。

实际文件系统和网络访问还受启用的 sandbox 后端约束。当前 V2 默认注册 macOS `srt-macos` 后端，其他平台的隔离能力需要看对应后端是否支持。

### 工具返回后，把结果提交成正式历史

文件修改成功后，模型还要知道修改结果，才能继续运行测试。如果进程在历史提交前退出，磁盘上的文件与恢复后读到的历史就可能不同。MiniMax Code 因此把运行中的执行事件与 canonical history 分开：前者描述正在发生的过程，后者是继续执行时使用的正式历史。

正式历史由 Session 系统存储和恢复。Host 通过统一的 committed-history writer 处理普通追加、替换、压缩和 reconcile。历史提交发生在执行过程中；上一章讨论的压缩也使用这套提交路径。

一次提交按以下顺序进行：

1. 捕获语义快照，校验会话、轮次和 operation identity。
2. 执行 durable mutation，在同一会话操作 lane 中回读正式历史。
3. 校验回读结果，取得已提交的 revision。
4. 等待必需的 `HistoryCommitted` 投影；涉及压缩时，还要完成压缩生命周期。
5. 向调用方返回 acknowledgement。

快照防止调用方在异步提交期间改动待提交对象。回读让后续组件使用存储已经确认的版本，而非调用方准备写入的那份数组。

![历史何时完成确认：提交顺序与 Turn 收尾](https://mintcdn.com/agent-cn/9Jt1IxBuE3KvgTyO/images/techblog/harness-commit.jpg?fit=max\&auto=format\&n=9Jt1IxBuE3KvgTyO\&q=85\&s=34a00b410a5a115c77dacf5a30300e31)

重试时，writer 用 `sessionId + operationId` 标识操作，再比较语义指纹。身份与内容都相同，才复用对应执行；相同身份携带不同内容，会触发冲突处理。这份 replay registry 有容量限制，保存在进程内，不提供跨进程或外部服务的 exactly-once 保证。

工具结果携带追加输入时，同样要区分取走与确认：控制链先 claim，等历史提交后再 ack。如果 Turn 收尾时仍有输入正在被消费，关闭就要暂缓。尚未消费的用户 steer 有重新排队的路径，已经交付的机器输入也不能在收尾时直接丢掉。

必需的状态投影完成后，正式历史才能确认。用量统计和诊断按 best effort 处理，失败会记录，但不会阻断历史确认。外部副作用则需要单独处理：例如远端写入成功但响应丢失，仍需要目标服务的幂等键或业务补偿，本地历史无法自动撤销它。

工具结果提交后，循环回到上一章：准备包含新结果的上下文，再请求模型。示例任务会这样继续修改、运行测试，直到可以结束。本轮退出时，Host 确认 runner 终态，处理历史 reconcile，运行 `turn_end` handlers，最后提交并确认 Turn 终态。模型停止生成后，Host 可能仍在完成这些工作。

## 4. 任务交给多个 Agent 后，这套流程怎么扩展

同一个修复任务也可以拆开：主 Agent 修改函数，子 Agent 检查调用方或补充调查。子 Agent 有自己的会话和执行过程，主 Agent 需要在合适的时机取得它的结果。前面讲的输入准备、工具执行和历史确认，仍然要在各自的执行中成立。

MiniMax Code 为后台任务记录独立 task ID、所属会话、父任务、状态和输出引用。状态包括 queued、running、stopping、succeeded、failed、canceled 和 lost，TUI 按父子会话关系展示被委派的 Agent。

协作多出的问题是：子任务完成以后，主任务什么时候算用过这份结果？完成、通知送达和读取结果可能发生在不同时间；主任务也可能读完结果后失败。

`deliveredAt` 记录交付状态，自动完成通知不会将其设置为已消费。当前 Host 只有在成功读取终态任务输出后，才记录消费候选；读取 running 任务的进展，不会抑制后续完成通知。等主任务这一轮以 completed 结束，并完成终态提交，Host 才确认候选已被消费。

例如，子 Agent 完成了调用方调查，主 Agent 用 `task_output` 读到结果，却在后续执行中失败。如果读取返回时就永久标记已消费，下次继续执行可能失去再次收到提醒的机会。把确认推迟到 Turn 完成提交后，可以让这次读取与主任务的完成状态对应起来。

这里延续了上一章的提交顺序，也保留了两步之间的失败可能：Turn 已经提交，消费确认或后续 settlement 才可能失败。此时记录诊断，不会回头把已提交的 Turn 改成失败；它们没有组成覆盖所有组件的原子事务。

runtime 重启后还会检查任务的执行者。找不到有效执行者的任务会结算为 `lost`，不再一直显示 running。主任务可以根据恢复的会话历史继续工作，但已经消失的子任务执行进程需要另行处理。

## 写在最后

一次代码任务要顺利完成，需要模型拿到合适的上下文，也需要工具执行、历史提交和子任务交付按约定衔接起来。MiniMax Code 开源了这些环节的实现，希望让更多开发者能看懂其中的取舍，并在自己的场景里使用、检验和改进它。

> [!TIP]
>
> 如果你对 Agent Harness 感兴趣，欢迎来 [GitHub](https://github.com/MiniMax-AI/minimax-code) 看看，给 MiniMax Code 点个 Star。也欢迎试用、提 Issue，感谢大家的支持！
