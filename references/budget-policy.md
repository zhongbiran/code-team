# 额度纪律（Plus 订阅，5 小时窗口）

## 为什么要立规矩

Plus 订阅的额度是滚动 5 小时窗口。规划期是最容易浪费的阶段：反复叫 Codex 改方案、
开一堆子代理却没人真正写代码，额度烧完问题一个没解决。

## 三条硬规则

### 1. 规划不重复
一次任务 Overmind 至多 1 次。要改方案就用 `--resume` 续聊同一线程（复用前缀缓存），
不要重新起线程重发全部上下文。

### 2. 规划要有产出物
Overmind 必须写出文件（问题定义 / 方案 / 执行顺序 / 验收标准）。没有落盘的计划不算数。

### 3. 执行期不再问 Codex
Worker 在实现过程中遇到已规划范围内的问题，自己解决；只有超出方案范围或方案本身错了，
才回 Overmind（用 resume，不是新开）。

## 额度账本

`scripts/codex-team.mjs budget` 输出最近窗口的用量：

| 指标 | 含义 |
|---|---|
| Codex 调用次数 | 规划调用了多少次 |
| input tokens | 总输入（含缓存命中部分） |
| cached tokens | 其中命中缓存的部分，命中率高说明复用做得好 |
| output tokens | 模型实际产出量 |
| reasoning tokens | 思考量，档位越高这项越大 |

## 5 小时窗口内的建议配比

按 OpenAI 侧限流的经验配比（不是硬标准，按实际账本调整）：

| 阶段 | 占比 | 说明 |
|---|---|---|
| Overmind 规划 | ≤ 15% | 一次成型，别反复 |
| Coder 方向规划 | ≤ 10% | 只在真需要时开 |
| Worker 实现 | ≤ 50% | 主力，别省 |
| Explore / Verifier | ≤ 25% | Verifier 只做一次 |

## 什么时候不要开 Codex

- 任务 1-2 次工具调用能做完
- 方案唯一、改动 ≤ 3 个文件、现有命令能判验收
- 只是要查一个符号在哪（用 Explore）
- 只是要审一遍已完成的工作（用 Verifier）

## 执行侧真实用量（2026-11-25 起）

账本 `config/events.jsonl` 里 mcode-agent 侧的 `usage` 字段 100% 为 null，
它只能证明「派过几个包」，证明不了「花了多少」。真实计量在本机官方插件
`mcode-trajectory-studio` 的只读投影里，派工守卫读的就是它。

### 口径

| 字段 | 来源 | 说明 |
|---|---|---|
| `inputTokens` | 记录级 `usage.inputTokens` | 本轮新读的输入 |
| `cacheReadTokens` | 记录级 `usage.cacheReadTokens` | 缓存命中 |
| `decodeTokens` | 记录级 `usage.outputTokens` | Studio 会话汇总里叫 decodeTokens |
| `totalTokens` | 记录级 `usage.totalTokens` | = input + output + cacheRead |
| `toolCalls` | 记录级 `toolCallCount` 求和 | = 会话级 `toolCalls` |

2026-11-25 对 P9 实跑对账（脚本 `scripts/trajectory-usage.mjs`，fixture 见
`test/fixtures/trajectory-usage/`）：

| 层级 | 工具调用 | token |
|---|---|---|
| P9 首跑子会话第一个 turn | 231 | 23,109,952 |
| P9 首跑子会话合计 | 380 | 66,935,410 |
| P9 续派子会话 | 433 | 40,636,353 |
| P9 逻辑包合计（跨尝试） | 813 | 107,571,763 |

逐条记录求和与 Studio 会话汇总逐项相等（同一次读取、同一个口径）。

### 聚合规则

- **去重**：同一会话内按 `msgId` 去重，同一条记录只保留最新；同一子会话被
  `task_append` 续派复用时，在逻辑包内只计一次。
- **归属**：Task 调用键 → 子会话 → turn；逻辑包跨尝试汇总唯一记录。
- **窗口**：5 小时窗口逐记录按记录时间归属，区间是 `[asOf-5h, asOf)`，
  上界不含；窗口外的记录不进窗口用量，但进包的累计用量。
- **覆盖**分三档：
  - `complete` = 目标 turn 真的存在、该次尝试的记录齐全、每条助手记录的 usage 四个关键字段
    （inputTokens / outputTokens / cacheReadTokens / totalTokens）都在；
  - `partial` = 测到了但不全（分页截断、统计警告、某条记录缺关键 usage 字段）；
  - `unknown` = 没测到（读取失败、会话不存在、**指定的目标 turn 一条记录都没有**、
    **某条记录缺 `toolCallCount`**、**有一次尝试没绑定到子会话**）。
  已知下界已经越阈值时仍然要求拆分。

- **缺值不是 0**：记录缺 `toolCallCount` 时调用次数记为 `null`（未知），不能当 0 记账；
  合计里出现缺值也保持缺值（`null` 不参与累加）。
- **逐尝试核对**：同一逻辑包有多次尝试时，每一次都要有绑定且计量完整；
  有一次没绑定 ⇒ 该包覆盖降为 `unknown` ⇒ 拒签（不能因为另一次绑上了就放行）。

### 单包成本闸

| 条件 | 结论 |
|---|---|
| 工具调用 > 200 | split（拆包） |
| token > 60,000,000 | resplit（重新拆包） |
| 两项同时越界 | resplit |
| 恰好等于阈值 | 不触发 |
| 计量缺失或覆盖不完整 | unknown（**拒签**） |

### 放行与拒签判定（放行依据只有一条：真实计量）

**「应有计量的场景」= 该包已有历史尝试**（账本 `config/events.jsonl` 里有它的派工/尝试记录，
`kind` 为 `call` / `dispatch` / `dispatch-result` / `dispatch.started` / `dispatch.settled`，
`role=worker`）。判定按包逐个来：

| 情形 | 结论 |
|---|---|
| 该包尚无任何尝试（第一次派工，用量尚未产生） | 不属于未知 → 正常放行 |
| 该包已有尝试或已绑定，但拿不到完整计量（缺绑定、缺目标 turn、关键 usage 字段缺失、读取失败/超时） | **拒签**（unknown） |
| 计量完整，但工具调用 > 200 | **拒签**（split，拆包） |
| 计量完整，但 token > 60,000,000 | **拒签**（resplit，重新拆包） |
| 计量完整且未越阈值 | 放行 |

「查不到」与「用量为零」必须分开：绑定了目标 turn 却一条记录都没有 → `unknown`，
不得报 `complete`，也不得给出「可继续」这种放行结论。

经验并发数（`近 5 小时派工包数 / 12`）**只作分批参考，不是放行依据**；
放行结论只能来自上表的真实计量判定。

#### 绑定字段别名（读取侧）

宿主回执里子会话/turn 的真字段是 `sub_session_id` / `sub_turn_id`
（宿主归档 `local-task.js`），插件自己写过 `childSessionId` / `child_turn_id`。
`readBindings()` 同时认：`childSessionId`、`child_session_id`、`sub_session_id`、`subSessionId`；
turn 同理；并在事件及其嵌套回执（`tool_response` / `result`）里一起找。
认不到绑定 = 拿不到计量 = 拒签，所以读取侧必须兼容多组别名。

#### CLI 用法与退出码

```powershell
node scripts/dispatch-guard.mjs --plan <包数> [--budget] [--pkg <包名>] [--bind <包>=<子会话ID>]
```

- `--pkg`：点名本次计划涉及的包（第一次派工也要点名，否则闸门不知道该判谁）。
- `--bind`：绑定执行会话，读该包的真实计量。
- 退出码 `0` = 可以按计划开；`2` = 拒签（单包越界 / 计量未知 / 建议降并发）。
- 输出里的「判定依据」逐条写明放行或拒签是因为哪一条规则。

### 读法与边界

- `node scripts/dispatch-guard.mjs --plan <包数> [--budget] [--pkg <包名>] [--bind <包>=<子会话ID>]`
  打印窗口实测用量、单包成本结论与逐条判定依据。
- 账本里派工记录有两种 kind 拼法（`call` 与 `dispatch`），窗口包数两种都算；
  只认一种会把后写入的派工事件漏掉，窗口占用被低估。
- `scripts/trajectory-usage.mjs` 导出 `readUsage()` 与 `evaluatePackageCost()`，
  宿主接线在新计量的执行检查点与续派前调用（接线归包 A）。
- **并发建议仍是包数经验值**（`近 5 小时派工包数 / 12`），没有套餐余量分母，
  不要把它当用量读。
- **没有套餐剩余百分比**：宿主侧只有 `fiveHour.remainingPercent`，没有证据表明它
  与 Studio token 同单位，也没有供插件使用的已验证配额接口，所以不显示、不折算。
- 计量读不到时输出「未知」，不用经验值兜底，也不签发基于虚假用量的放行结论。
- **读取带 deadline**：MCP 读取到期必须中止 —— 拒掉在途请求、清掉 pending、杀掉 server 子进程、
  拆掉管道；无响应的 server 不许把调用挂住（父进程仍要能自然退出，不留孤儿 server 进程）。
