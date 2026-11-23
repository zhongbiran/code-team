> ## Documentation Index
> Fetch the complete documentation index at: https://agent.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# MCode 工程笔记 04｜一条 bash 命令该等多久：从前台阻塞到后台任务

> Agent 跑一条 bash 命令，要不要等它跑完？从前台阻塞一路推到后台任务，以及随之而来的通知、防轮询、回收和压缩后的提醒。

> [!NOTE]
>
> 先想一个问题：Agent 跑一条 bash 命令，要不要等它跑完？

顺着这个问题往下推，会牵出一串连锁反应，我们按 MiniMax Code（下文简称 MCode）里的实际思路，一步一步讲。

![一条 bash 命令该等多久：从前台阻塞到后台任务](https://mintcdn.com/agent-cn/46XSQ0l9oVgoId9L/images/techblog/mcode-notes-04-bash-background/cover.png?fit=max\&auto=format\&n=46XSQ0l9oVgoId9L\&q=85\&s=aa496a0ecbc4a63ad9d5473b6a376b51)

## 一个大家都见过的场景

让 agent 帮你「把服务跑起来看看」，它敲下 `npm run dev`，然后就没有然后了。dev server 本来就不会退出，agent 就一直等在那里。

这不是个别现象。X 上有人列 agent 最常见的几种翻车方式，第二条就是它：[「卡住的进程。一个永远不返回的 dev server 或 watcher，循环就干坐在那儿。」](https://x.com/Vibecodepipe/status/2109482595822240216)

最直观的做法是等命令结束，把输出塞回去，模型接着想。为了不卡死，再加一个超时。这条路在 MCode 里一直都在，现在是兜底：默认超时 120 秒，最多 300 秒。

对 `ls`、`git status` 这种几百毫秒的命令，这就是最优解。但 dev server、全量测试、完整构建，要么不会结束，要么要跑好几分钟。超时一到就杀掉，等于白跑一趟。

## 别人是怎么做的

主流做法已经很一致了：**让长命令去后台跑。**

以 Claude Code 为例，它的[文档](https://code.claude.com/docs/en/interactive-mode#background-bash-commands)写得很清楚：后台命令会立刻返回一个任务 ID，输出写进文件，Claude 之后再去读；用户可以按 `Ctrl+B` 把正在跑的命令挪到后台（有人在 X 上把这个快捷键[专门整理过](https://x.com/johnnynelai/status/2113898788716716322)）；命令跑到超时还没结束，会自动转到后台，而不是被杀掉。

这回答了「dev server 怎么办」：它去后台跑，agent 继续干活。但还有一个问题没回答：

> [!NOTE]
>
> **一条命令跑 3 分钟、能正常结束，为什么不干脆把超时调长，老老实实等它？**

## 为什么不能干等：缓存会过期

![图 1：前台干等时没有新请求，命令跑过 5 分钟，下一次请求就要整段重新预填充；转后台后模型继续干活，每次请求都给缓存续期](https://mintcdn.com/agent-cn/46XSQ0l9oVgoId9L/images/techblog/mcode-notes-04-bash-background/fig1.png?fit=max\&auto=format\&n=46XSQ0l9oVgoId9L\&q=85\&s=efc3acc851670be4e6c3f704483bc6fc)

干等的代价有两层。第一层是看得见的：用户等着，agent 什么也没干。第二层看不见，但更贵：**提示词缓存会过期。**

命令在前台跑的时候，模型那边没有任何新请求。而缓存是有寿命的：

* Anthropic 默认缓存 [5 分钟](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)，每次命中会续期。寿命从请求**开始**算，模型生成的时间也算在里面。另有 1 小时档，但写入价是普通输入的 2 倍。
* OpenAI 的缓存时长按模型不同，[从闲置 5–10 分钟到更长的档位都有](https://developers.openai.com/api/docs/guides/prompt-caching)。

一条命令前台跑了 6 分钟，等它返回时，前面几万 token 的上下文多半已经不在缓存里了。下一次请求要整段重新预填充，首 token 更慢，钱也更贵。

X 上已经有人在算这笔账。有人[专门提醒](https://x.com/ZypherHQ/status/2110706531888984078)：agent 等构建、等测试等太久，缓存就过期了；他的办法是换一台更快的机器，把构建时间压下来。还有一个团队[实测了一次 2.3 小时的会话](https://x.com/wallabytoken/status/2109269380580397226)：在他们的网关上缓存闲置 5 分钟就过期，结果 49% 的花费来自 6 次调用，每次都紧跟在 5 分钟以上的停顿之后。他们管这叫「停顿税」。他们自己也说了，这只是单次会话的观察。

换机器是一种解法。我们想的是另一条路：**别让模型干等。**

## MCode 的做法：前台等一会儿，等不到就转后台，不重跑

和 Claude Code 一样，MCode 的 bash 有 `run_in_background` 参数：模型觉得命令会很久，就让它在后台跑，立刻拿回一个 `task_id`。

光靠这个不够，因为模型经常**预判不准**。它以为几秒的事，结果跑了十分钟。所以我们又加了一层「自动转后台」。关键实现只有一点：**每条前台命令从一开始就作为后台任务启动，前台只是陪它等一会儿。**

![图 2：从头到尾一个进程，前台最多等 60 秒，没跑完就返回同一个 task\_id，总超时 3600 秒含前台时间、不重置（时间轴不按比例）](https://mintcdn.com/agent-cn/46XSQ0l9oVgoId9L/images/techblog/mcode-notes-04-bash-background/fig2.png?fit=max\&auto=format\&n=46XSQ0l9oVgoId9L\&q=85\&s=b84de75849f023f3510a5b0e777baa9f)

转后台不需要杀掉重来，进程从头到尾就一个。工具说明里也明确告诉模型：拿到 task\_id 后，这条命令还在后台跑，不要再启动一遍。

我们的理解是，绝大多数命令一分钟内都能跑完，前台直接拿结果最省事；60 秒又远小于 5 分钟的缓存寿命，给模型生成留足了余量。

还有一个细节是超时的算法。自动转后台的命令，总超时默认也是上限，即 3600 秒，**前台等的那段时间也算在里面**。转了后台、读了几次输出，截止时间都不会重置。不然模型可以靠反复转后台，让一条卡死的命令永远跑下去。

到这里，「别干等」解决了。但命令不再和这一轮绑在一起，原来同步模型里天然成立的东西，现在都要自己补上。

![图 3：转了后台，同步原本白送的东西都要自己补：完成通知、防轮询、输出预算、停止与回收、压缩后的提醒，以及转后台的前提](https://mintcdn.com/agent-cn/46XSQ0l9oVgoId9L/images/techblog/mcode-notes-04-bash-background/fig3.png?fit=max\&auto=format\&n=46XSQ0l9oVgoId9L\&q=85\&s=c68899f059179288576bc3f6084d73b6)

## 下一个问题：跑完了，模型怎么知道？

后台命令跑完后，运行时会往会话里塞一条隐藏消息 `<background-task-finished>`，把会话唤醒。这条消息只带 task\_id、状态、描述和结束时间，**不带输出**。模型要看结果，得自己调 `task_output`。

这么做有两个原因。

一是通知要短：每批最多 32 个任务、8 KiB，描述超过 256 字节会截断。

二是通知是**追加在末尾**的新消息，不会改动已经缓存的前缀。

如果一个会话里同时有很多任务在完成，通知也要限流：每个会话 60 秒内最多唤醒 3 次，超出的会延后。投递失败按 1、2、5 秒重试，之后退避到 60 秒，最长 5 分钟。

## 再下一个问题：模型会不会自己一直问？

会，而且很贵。有了 task\_id，模型很容易写出这样的循环：查一下，还没完，再查一下……每查一次都是一次完整的模型请求，带着整段上下文。

这件事别家也踩过。有人在 X 上转述过另一个开源 agent 的一次修复：[一个重度用户的 agent 一个月里对一个安静的后台进程反复发了约 1,900 次等待调用，每次都是一轮二十多万 token 的请求；改成自动通知后，小模型的 token 消耗降了 45%](https://x.com/jus_eng_njainam/status/2112044595026837991)。

> [!NOTE]
>
> 方向和我们的判断一致：**要让结果自己回来，而不是让模型去问。**

我们从三处堵这件事：

* 工具说明直接写明：完成后会自动通知，不要频繁轮询。
* `task_output` 可以带 `wait_ms` 阻塞等新输出，但最多 30 秒，超了按 30 秒算。
* 如果模型连续两次读到的状态和偏移量都没变，返回结果里会附一句提示：要等新输出就带上 `wait_ms`，别反复立刻检查，先去干别的，等完成通知。

## 读回来的东西太大怎么办？

前台返回给模型的输出有 24 KiB 的预算，超了就保留开头和结尾，中间省略，并附上完整日志的位置。后台任务的输出写进日志文件，`task_output` 按字节偏移量增量读，模型可以只读新增的部分。日志如果没写全，也会单独告诉模型，不让它把不完整的输出当成全部。

## 没人管的后台任务，谁来停？

后台任务最怕没人管。用户对这一点的感受很直接。X 上有 Claude Code 用户直接喊话：

[「停掉主 agent 的时候，能不能把后台任务和子 agent 一起停掉」](https://x.com/7izzyx/status/2108019058973237447)。

用户按了停，就是希望一切停下来；但用户只是离开一下，又不希望长任务被白白杀掉。我们按场景分开处理：

* **看门狗**：显式后台命令如果没给超时，默认最多跑 1 小时。这个值在公开代码里从 30 分钟调到过 1 小时。
* **用户按 Esc 停止**：会连带取消这个会话拥有的后台 bash 和子 agent（[#381](https://github.com/MiniMax-AI/minimax-code/pull/381)）。被停掉的任务结束时，不会再把会话唤醒。结果仍然留着，下一轮会通过提醒告诉模型。
* **`/clear` 或切换会话**：只停当前这一轮，后台任务继续跑。用户离开不等于用户不要了。
* **headless 单次执行退出时**：会把这个进程里的后台 bash 全部回收，否则一个长循环会让 CLI 一直挂着不退。
* **进程重启**：启动时会把上一个进程留下、已经没有主人的任务标记为 `lost`，不会让它们永远显示「运行中」。

别家的取舍也类似。Claude Code 的文档写的是：退出时自动清理后台任务；在终端里交互使用时后台命令没有时限，无人值守的会话会在时限到了之后停掉。

## 上下文被压缩之后，还记得有结果没看吗？

上下文太长时，compaction 会把早期历史压成摘要。如果「有个后台任务完成了还没看」只记在历史里，压缩一次就丢了。

我们的做法是：未读结果的事实来源是任务表，不是历史。每轮准备请求时，运行时从任务表里查有没有已结束但没读过的任务，有就补一条 `<background-task-completion-reminder>`，列出最早的几个。有新任务结束时会立刻提醒，否则模型每干 15 步提醒一次。模型一旦成功读过 `task_output`，这一轮就不再提醒。

## 最后一个前提：读不了结果，就别转后台

只有这一轮的工具里有 `task_output`，bash 才允许转后台。否则就退回开头那种纯前台模式（默认 120 秒，最多 300 秒），连 `run_in_background` 参数都不出现在 schema 里。转了后台，模型却没有办法把结果拿回来，那还不如老老实实等。

## 回头看

![图 4：前台负责快，后台负责久，中间用同一个进程衔接](https://mintcdn.com/agent-cn/46XSQ0l9oVgoId9L/images/techblog/mcode-notes-04-bash-background/fig4.png?fit=max\&auto=format\&n=46XSQ0l9oVgoId9L\&q=85\&s=d172cdb3644b5922c22d184a10fbea5e)

一句话总结：**前台负责快，后台负责久，中间用同一个进程衔接。**

后台多出来的那些机制，本质上都在补「同步」原本免费提供的东西：结果怎么回来、什么时候结束、谁来清理、压缩后还记不记得。

还要说清楚一点：转后台并不能让缓存永远热着。如果模型手上没有别的活，这一轮结束，二十分钟后任务跑完再唤醒，那次请求照样可能缓存失效。

转后台真正省下的，是「明明有别的事可做，却在干等」的那部分时间。

## 给做 agent 的几条自查

| 检查项 | 自问 |
| - | - |
| 前台上限 | 前台最多等多久？和你用的模型服务的缓存寿命比，留够余量了吗？ |
| 不重跑 | 从前台转后台，是同一个进程，还是杀掉重来？ |
| 超时口径 | 转后台、读输出之后，截止时间会不会被重置？ |
| 结果回流 | 后台跑完，模型靠通知知道，还是靠自己轮询？ |
| 通知位置 | 通知是追加在末尾，还是改动了已缓存的前缀？ |
| 防轮询 | 有没有限制阻塞等待时长，并对重复读取给出提示？ |
| 输出体积 | 大输出是截断、落盘，还是整段塞回上下文？ |
| 回收 | 用户停止、进程退出、进程重启时，后台任务各由谁清理？ |
| 压缩之后 | 「有结果没看」这件事，压缩后还找得回来吗？ |
| 前提 | 当前环境如果读不了后台结果，还会允许转后台吗？ |

这些都在 [MiniMax Code 的公开仓库](https://github.com/MiniMax-AI/minimax-code)里，主要在 `packages/local-runtime/src/background-task/` 和 `packages/agent-tools/src/desktop/` 下面。

> [!TIP]
>
> 也想听听大家：你们的 agent 遇到长命令是怎么处理的？

***

## 参考资料

* Vibecodepipe（@Vibecodepipe），[agent 常见翻车方式：永不返回的 dev server](https://x.com/Vibecodepipe/status/2109482595822240216)
* Claude Code 文档，[Background Bash commands](https://code.claude.com/docs/en/interactive-mode#background-bash-commands)
* johnnynelai（@johnnynelai），[Claude Code 的 Ctrl+B 等快捷键整理](https://x.com/johnnynelai/status/2113898788716716322)
* Anthropic 文档，[Prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
* MiniMax 开放平台，[Anthropic 兼容接口的缓存](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache)、[Prompt Caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching)
* OpenAI 文档，[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
* ZYPHER（@ZypherHQ），[等构建、等测试太久，缓存会过期](https://x.com/ZypherHQ/status/2110706531888984078)
* wallabytoken（@wallabytoken），[一次 2.3 小时会话里的「停顿税」](https://x.com/wallabytoken/status/2109269380580397226)
* jus\_eng\_njainam（@jus\_eng\_njainam），[反复等待调用与改成自动通知后的效果](https://x.com/jus_eng_njainam/status/2112044595026837991)
* 7izzyx（@7izzyx），[希望停止主 agent 时连带停掉后台任务](https://x.com/7izzyx/status/2108019058973237447)
* MiniMax Code，[PR #381：停止会话时连带停止后台任务](https://github.com/MiniMax-AI/minimax-code/pull/381)
