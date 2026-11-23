# 架构：决策权归属

> 2026-11-23 按用户纠正重构。主会话是执行级模型（M3.1 Flash），不能承担决策。

## 决策权分配

| 决策 | 归谁 | 为什么 |
|---|---|---|
| 这活值不值得规划 | Overmind | 主会话只有执行级模型，判断"值不值得"需要判断力 |
| 需求怎么理解、隐含条件是什么 | Overmind | 主会话容易按字面执行，漏掉隐含约束 |
| 方案选哪个、放弃什么 | Overmind | 决策要连代价一起给，主会话给不出 |
| 怎么拆包、每包边界 | Overmind | 拆包涉及文件归属，错了会冲突 |
| 每个包的 brief | Overmind | brief 里的 Hypothesis 是派工前的预判，只有决策者有 |
| 代码方向：接口设计、实现取舍 | Coder | 代码决策与代码上下文强相关 |
| 怎么实现 | Worker | 执行 |
| 改动对不对 | Verifier | 独立验收 |

## 主会话只做四件事

1. 把用户需求**原样**转交 Overmind
2. 把 Overmind 的方案、拆包、brief **原样**转发给执行者
3. 用户追加问题时，**原样**追加给 Overmind（`--resume`，不重开）
4. 向用户汇报结果

主会话自己动手写实现代码 = 偏离工作流。

## 为什么 brief 不能由主会话写

两个原因，都可验证：

1. **判断力**：主会话是执行级模型，它的"拆包"和"验收标准"不如决策者准。
2. **Hypothesis 失去意义**：Hypothesis 是**派工前**的预判，用来在结果出来后做对比。
   主会话在派工时并未对结果做过预判，填出来的 Hypothesis 是编的。

2026-11-23 的对照实验（见 `agent-brief-experiment.md`）还发现：
brief 的 Done 栏如果写成"必须覆盖 A/B/C 三个场景"，worker 就只测这三个。
**Done 只给"一条命令 + 期望输出"**，测什么由执行者判断。
这条要求写进了 Overmind 契约，Overmind 产出的 brief 已经符合。

## 后端可插拔

Overmind / Coder 的执行后端由 `config/team.json` 的 `backend` 字段决定：

| backend | 怎么跑 | 换的时候注意 |
|---|---|---|
| `codex-cli` | `scripts/codex-team.mjs` 调本机 Codex CLI | 换模型前用 `codex debug models` 确认 id 有效（网关会改名，旧 id 静默失效） |
| `mcode-agent` | Task 工具调 MCode 自身的子代理 | 模型必须在本机 `config.yaml` 里真实存在 |

**主会话的行为不随后端改变**——它只管转交和转发。

### 本机实际可用的模型（2026-11-23 核实）

| 模型 id | 池 | 备注 |
|---|---|---|
| `MiniMax-M3` | minimax | 512K context，支持思考 |
| `MiniMax-M3.1-Flash` | minimax | 主会话当前用的 |
| `GLM-5.3-Flash` | 超算中心 | 自定义 provider |
| `iceman-contributor-free` | opencode-go | 免费档，不计任何额度 |

注意两点：

- `mcode:strategist` 声明的 `opencode-go/kimi-k3.1-pro` **在本机 config.yaml 里没有配置**，
  用它会失败。
- opencode-go 的**月度档当前已 100% 限额**（看板实测），依赖该池的模型近期不可用。
  滚动窗口和周档是 0%，说明限额按自然月累计。

## Overmind 契约（实测有效）

`scripts/codex-team.mjs` 会给 Overmind 追加一段契约，要求它额外产出四段：

1. **决策记录** —— 每个决定的理由、放弃了哪些方案、代价
2. **拆包** —— 按文件归属不重叠拆
3. **每包的 brief** —— 完整七字段，Done 只给命令 + 期望输出
4. **需要 Coder 的部分** —— 指明哪几包需要代码方向决策

### 实测验证（2026-11-23）

给一个真实的 Node CLI 加 `--json` 模式，Overmind 实跑输出：

- 决策记录 5 条，每条带理由、放弃方案、代价
- 拆成 3 包：`src/cli.js` / `test/cli.test.js` / `README.md`，文件归属不重叠
- 每包 brief 完整，Done 全是可跑命令
- 明确指明"A 需要 Coder 介入，负责核对参数识别顺序、数据流及输出流归属"，
  B、C 可直接交 Worker
- **它真的跑了命令核实现状**：`node src/cli.js --json a b` 的真实输出、
  `--help --json` 的优先级、`npm test` 的 pass 1

从决策记录里能看到它做的取舍都是真的取舍，例如：
放弃"任意位置识别开关"、放弃"引入 `--` 分隔符"、放弃"裸数组输出"，
并写明各自代价。这不是套话，是读过代码后的判断。
