---
name: code-team
description: 多 Agent 协作工作流入口。决策权在 Overmind（后端可配，现为 Codex CLI + gpt-6.2-astra）：它出方案、拆包、写每个包的 brief；代码方向决策交 Coder（gpt-6.2-sol）；执行由 worker/explore/verifier 并行完成。主会话只做侧边转交，不参与决策。含额度守卫与可替换模型/后端配置。Use when starting a multi-step engineering task that needs planning plus parallel execution, or when the user asks for a work team / 团队协作 / 并行开工.
---

# Code Team：Overmind 决策 + Coder 代码方向 + 三个执行子代理

## 角色分工

**决策权在 Overmind，不在主会话。** 主会话是侧边会话——转交需求、转发结果、追加用户的问题，不做判断。

所有角色的后端与模型都在 `config/team.json` 里配，**控制台可改**。

| 角色 | 类型 | 后端 | 模型 | 职责 |
|---|---|---|---|---|
| **主会话** | 侧边 | 当前会话 | 当前会话模型（**执行者，非决策者**） | 转交需求、转发结果、追加用户问题 |
| **Overmind** | 决策 | `codex-cli` | `gpt-6.2-astra`（medium/high） | **所有决策**：问题定义、方案选项、拆包、每个包的 brief |
| **Coder** | 决策 | `codex-cli` | `gpt-6.2-sol`（medium/high） | **代码方向决策**：接口设计、实现取舍、核心问题定位 |
| **Worker** | 执行 | `mcode-agent` | `minimax/MiniMax-M3.1-Flash` | 按 brief 执行，可多开并行 |
| **Explore** | 执行 | `mcode-agent` | `minimax/MiniMax-M3.1-Flash` | 只读取证 |
| **Verifier** | 验收 | `mcode-agent` | `minimax/MiniMax-M3.1-Flash` | 独立验收，只做一次 |

后端两种：`codex-cli`（本机 Codex CLI）或 `mcode-agent`（MCode 自身子代理）。
**换后端或模型改 `config/team.json` 即可，不用改流程。**

向用户回复时用显示名（Overmind / Coder / Worker / Explore / Verifier）；`agent_name` 只用于 Task 工具参数。

### 主会话的权限边界（关键）

主会话**不做**这些判断，因为主会话用的是执行级模型（现为 M3.1 Flash）：

- 不判断任务该不该开 Overmind —— **一律开**
- 不决定怎么拆包 —— Overmind 拆
- 不决定每个包的目标/验收/brief —— **Overmind 写，你原样转发**
- 不决定要不要开 Coder —— **Overmind 指明哪几包需要**
- 不自己补需求的隐含条件 —— 需求里没写的，Overmind 决定怎么理解，你只转达你的追加问题

主会话**只做**四件事：

1. 把用户需求**原样**转交 Overmind
2. 把 Overmind 的方案、拆包、brief **原样**转发给对应执行者
3. 用户追加问题时，**原样**追加给 Overmind（用 `--resume` 续聊，不重开）
4. 向用户汇报结果

主会话自己动手写实现代码 = 偏离工作流。

**方法论来源**：本机的 `mcode` 插件就是官方 mcode-stack 的 ronny 栈（含 agent-brief、
subagent-split-check、evidence-first-review、review-capacity-check 等）。
Code Team 是**编排层**，不复制这些 skill，只在流程里调用它们。提纯对照见
`references/official-stack-distilled.md`。

## 第 0 步：后端就绪检查（首次或换项目时做一次）

Overmind / Coder 的后端可以是 Codex CLI，也可以是 MCode 自身的子代理
（见 `config/team.json`）。**换后端只需改配置，主会话不用改任何代码。**

用 Codex CLI 作后端时，Codex 是全新环境——它只认 `~/.codex/AGENTS.md`、
项目级 `AGENTS.md` 和 `~/.codex/skills/`，不先同步它看不到项目的验收命令与已知坑：

```bash
node scripts/codex-bootstrap.mjs <项目根目录> sync   # 同步角色约定与项目 skill
node scripts/codex-bootstrap.mjs <项目根目录> report # 只看当前状态
```

同步是幂等的：已有的同名 skill 不覆盖，`~/.codex/AGENTS.md` 用标记块**整块更新**（不重复写）。

---

## 执行流程

### 1. 开 Overmind（主会话无脑开，不做判断）

读 `references/budget-policy.md`。**主会话不做"该不该开"的判断**——一律开，
让 Overmind 自己在内部决定这件事是"照做"还是"值得规划"。

```bash
node scripts/codex-team.mjs plan --prompt-file <需求文件> --role overmind
```

需求文件写用户原话即可。**不要替用户改写、补全、或"优化"需求措辞**——
你对需求的理解不如 Overmind 准（你只有执行级模型）。用户没说的，
让 Overmind 去问、去假设，并在方案里标出来。

**一次任务里 Overmind 至多开 1 次。** 用户追加问题时用 `--resume` 续聊同一线程
（复用前缀缓存），不重开。

### 2. 转发 Overmind 的结果

Overmind 会返回：方案与理由、拆包、每包的 brief、哪几包需要 Coder。

**原样转发，不要改写、不要替它补充。** 你的判断力不如它，改了反而变差。

若 Overmind 判定"这活不值得规划"，按它说的做，不要坚持开 Codex。

#### 拆包的规模判据（2026-11-24 实测）

Overmind 拆包时优先按**编译影响面**切，不按功能切。判据：

- **单包首跑超过 30 分钟就是包太大**，拆细。两个实测反例：模拟引擎包（引擎+量程+并发+Redis 写入+UI 分组编辑）
  首跑 3.5 小时后撞额度被杀；WebAdmin 历史包（分页测量+历史三链+契约+端点+跨月分表）同样 3.5 小时被杀。
  同期只改一个枚举规则的包 32 分钟收工。
- **改动共享层（Application 层公共文件）的包要单独成包**，且不与其它包并行。
- **调研与实现要分开**：先派 Explore 只读取证（一个包只查一个主题，塞 5 个主题进去会让它输出循环卡死），
  证据落盘后再派实现。实测：一次把 5 个主题塞进一个 Explore，它复读同一句话 256 行后被杀。
- **不要三层重复读同一批代码**：Overmind 已给 file:line 级别的裁定，Coder 又抄一遍行号，主会话再抄一遍给 Worker。
  brief 里带裁定结论即可，不必重复粘贴大段源码。

### 3. 需要 Coder 时（由 Overmind 指明）

只有 Overmind 明确指明哪几包需要代码方向决策时，才开 Coder：

```bash
node scripts/codex-team.mjs plan --prompt-file <文件> --role coder
```

Coder 只读代码、给接口设计与取舍结论，**不写业务代码**。实现仍由 Worker 做。
**一次任务里 Coder 至多 2 次。**

### 4. 后端可配：换模型、换 CLI、换成 MCode 自身

`config/team.json` 里每个角色有 `backend` 字段：

```json
{
  "overmind": { "backend": "codex-cli", "model": "gpt-6.2-astra", "effort": "medium" },
  "coder":    { "backend": "codex-cli", "model": "gpt-6.2-sol",    "effort": "medium" }
}
```

- `backend: "codex-cli"` —— 走 `scripts/codex-team.mjs` 调本机 Codex CLI。
- `backend: "mcode-agent"` —— 走 Task 工具调 MCode 自身的子代理
  （`mcode-agent-backend` 段里有现成配置，模型用本机 `config.yaml` 里真实存在的）。

换 codex 模型前先确认 id 有效：`codex debug models`。网关会改名，旧 id 可能静默失效。

**后端换了，主会话的行为不变**——它只管转交和转发。

### 5. 用户追加问题 → 原样给 Overmind

用户中途补充或改主意时，**不要自己消化，也不要重开 Overmind**：

```bash
node scripts/codex-team.mjs plan --prompt-file <追加内容.md> --role overmind --resume <thread_id>
```

用 `--resume` 续聊同一线程，复用前缀缓存，也保留 Overmind 之前的全部上下文。
追加内容写用户原话，不要改写。

### 6. 按 Overmind 的拆包并行派工

按 Overmind 的执行顺序拆包，每包一个明确交付物。派工时：
- 用 Task 工具，`agent_name="worker"`（可多开并行，改动文件必须互不重叠）
- 只读取证用 `agent_name="explore"`
- brief 必须写死：目标、已有事实、精确到文件的改动清单、验收命令、文件归属
- 单包控制在 20 分钟内；超过就拆细

**每个 worker 包的 prompt 必须同时带这两个标记（缺一个就被 hook 拒绝）：**

```
code-team-plan: <计划版本>
code-team-package: <包号>
```

- `code-team-plan` 给出**批次边界**：归属互斥只在同一个 plan 内比较，
  没有 plan 标记就不知道跟谁算同批，等于绕开闸 2。
- `code-team-package` 给出**包号**：没有包号就无法识别「同一个包的重派」，
  也会拿不到这个包的真实用量（计量闸）。
- 这两个标记是 Code Team 派工的识别特征：普通（非 Code Team）的 worker 派工不受影响。
- **Code Team 的 worker 首派还必须带 `code-team-brief-ref`（产物引用）**：
  正文由 Overmind 发布、宿主按引用核对后装进去。手写正文一律退 2 —— 
  少这一行就是「绕过 Overmind 原文」，hook 不会替你猜正文对不对。
- Worker 在**别的目录**干活时（多 worktree 仓库），prompt 里加一行
  `code-team-worktree: <工作树绝对路径>`：hook 在派工时记下这棵树的**基线提交**，
  撞墙续派按「基线..HEAD」取证 —— 否则干净树上的已提交变更会被当成「零落盘」。
- 续派（`task_append`）宿主真实入参只有 `{task_id, content}`，没有 agent_name；
  hook 靠账本里这个 task_id 的记录还原角色/包号/失败证据，所以**先派过 task 才谈得上续派**。
  认不出归属（账本里没有这个 task_id）就退 2，不兜底放行。

#### 派工前的三道闸（2026-11-24 实测教训，缺一条就会返工）

**这三道闸现在由宿主 hook 自动执行，你不用记得跑脚本。**

2026-11-25 复盘的结论：闸门写在事故之后、而且只是「需要人记得跑的脚本」，
三次撞额度事故时闸门一次都没生效。现在闸门挂在宿主 `PreToolUse` 上，
`task` / `task_append` 每次派工前自动判一次，不合格直接拒绝，Task 不会被创建。

- 判定脚本：`scripts/dispatch-hook.mjs`（注册在 `hooks/hooks.json`）
- 手跑核对：`node scripts/lessons.mjs check [--briefs <本轮 brief 目录>]`
- 排障时临时关闭：环境变量 `CODE_TEAM_GATE=off`（别常开）
- 派工被拒**不要自己绕过**：把拒绝原因原样带回 Overmind（`--resume`），让它改 brief
- 同一个包重派时在 prompt 里带 `code-team-package: <包号>` 标记，
  否则 hook 认不出是同一个包，可能把重派当成归属冲突拒掉
- 验收派工（`agent_name=verifier`）带 `code-team-verification-key: {"planId":…,"criteriaRevisionId":…}`，
  同一验收口径第二次派工会被拒（状态落盘，`PLUGIN_DATA/verification-state.json`）
- 验收者的结论里必须带 `code-team-verification-evidence: {"outputRefs":[…]}`；
  判 FAIL 时还要带 `commands` 与 `exitCodes`（否则执行者自证永远判无效）。
  **没有证据引用的结论不落盘**（空引用 = 无效结果）
- 撞墙续派（`task_append`）带 `code-team-retry: {…}` 与
  `code-team-continuation: {"persistedWork":…,"remainingWork":…}`（续派书两段缺一不可）
- 续派的失败证据（机器码 / 失败时刻 / attempt / 原并发 / 批次 / 原 Worker 工作树）
  **只认派工账本**，提示词里写的不算 —— 提示词只能做交叉校验，写错反而会被拒
- 执行者交自证时带 `code-team-self-evidence: {…}`（挂在同一条验收记录上，不重派 Verifier）
- 某个闸的模块缺失或报错时，hook 会**按模块降级**：与本次派工相关的闸降级 = 直接拒绝并写明
  「该闸未生效：<模块> <原因>」；不相关的闸降级只记进事件，不影响这次派工

**闸 1 · 编译闸**：brief 的验收段必须包含**编译**，不能只有静态检查。
- `-ChecksOnly` 是**纯静态检查，不编译**。Worker 拿它当"编译通过"的证据，就会交付编译不过的代码。
- 实测：有两个包分别交付了 CS0101（同名类型重复）和 CS0120（静态方法访问实例成员），两包都"静态检查通过"，各返工一轮。
- brief 必须写死：`dotnet build <工程> -p:OutputPath=$env:TEMP\... → 0 个错误` **且** 专项测试全绿。
- 判定：宿主 hook 自动跑 `checks/brief-requires-compile-gate.mjs`（用真实事故样本验过会红）。
- 适用范围：只管 .NET 项目；非 .NET 项目的 brief 不受这条约束。

**闸 2 · 文件归属互斥**：每份 brief 都要有「文件归属」段，且**两份 brief 的归属清单不得有交集**。
- 实测：两个包都改了同一个 Application 层 Helper 文件，后者收尾时把前者的实现打乱，
  直接产生 10 条编译错误，最后要另起一个集成包收尾——而集成包本身又是一次派工成本。
- 共享文件（公共契约、公共配置、csproj、验证脚本）**只归一个包**，其余包通过接口消费，不直接改。
- 判定：宿主 hook 自动跑 `checks/brief-file-ownership-disjoint.mjs`（用真实事故样本验过会红）。
- 归属段两种写法都认：`## 文件归属（只改这些）` 下面跟列表，或 `文件归属：A.cs、B.cs` 一行写完。

**闸 3 · 额度余量**：真实用量闸（B 的 `readUsage` / `evaluatePackageCost`）已接进宿主 hook——
同一包累计越界会自动要求拆包 / 重拆。守卫脚本还能跑，但它数的是「近 5 小时派了几个包」，不是真实 token
（2026-11-25 复盘：它数的不是 token，所以原理上不知道额度快满了），只当保守并发度参考：

```bash
node scripts/dispatch-guard.mjs --plan <包数> --budget
```

- 退出码 0 = 可以按计划开；退出码 2 = **按它给的建议并发度分批派**，不要硬开。
- 并发放大额度消耗：同批 9 个 Worker 并行时，后 3 个撞上 Token Plan 上限被杀。
- 撞上限的包要续跑，等于同一份活干两遍，比慢更贵。
- 额度中断的包**不重派同一个 brief**，先 `git status` 核查它落盘到哪一步，
  续派任务书必须写明"已落盘什么 / 没做什么"，否则新 Worker 会从零重写或覆盖已有实现。

**闸 4 · 隔离红线（写进 brief）**：Worker 的测试**不得连生产库 / 现场 Redis / 现场数据库**。
- 实测：有个包为跑测试连了现场服务器的 Redis 写测试数据（用了自定义 key 前缀隔离、测完删了，
  生产 key 零改动，但仍是越界）。测试必须走仓库自带的隔离机制（如 `TestIsolation.cs` 的进程级环境变量）。


**派工前后各记一条事件**（这是"哪些任务、哪些 skill 调用了多少次、耗时多少"的唯一来源）：

```bash
# 派工前
node scripts/record-event.mjs record --kind dispatch --role worker --backend mcode-agent \
  --model <该 agent 的模型> --project <项目名> --session <主会话 id> \
  --task <任务名> --skill <用到的 skill> --plugin code-team

# 派工后（补耗时与结果）
node scripts/record-event.mjs record --kind dispatch-result --role worker --backend mcode-agent \
  --project <项目名> --session <主会话 id> --task <任务名> --elapsed-sec <秒> --ok true|false
```

归因维度怎么填：
- `--project`：当前工作目录的仓库名（项目根目录名）
- `--session`：**主会话 id**（从 `<agent-context>` 的 YOUR SESSION ID 取，形如 `mvs_xxx`）。
  Codex 调用会自动带 threadId；派工要手动带这个，两者才能归到同一个会话。
- `--task`：Overmind 给的包的标题，一句话
- `--skill`：这次派工用到的 skill 名（没有就填 `code-team`）
- `--plugin`：固定 `code-team`

**不要跳过这一步。**没有它，控制台就统计不出"消耗集中在哪些项目、哪些任务"，也查不出该验收的没验收。

**brief 来自 Overmind，主会话只转交产物引用，不转写正文。**

Overmind 的 brief 由 `scripts/codex-team.mjs` 发布成产物（`briefs/<planRevisionId>/…`），
主会话拿到的是**引用**，不是正文。派工时把引用交给宿主 hook，hook 按引用取回并核对产物，
再用**核对过的原文**装进 Worker 的 prompt：

```
code-team-package: <包号>
code-team-plan: <计划版本>
code-team-brief-ref: {"planRevisionId":…,"packageId":…,"artifactId":…,"sha256":…,"byteLength":…}
```

- 校验口径：**sha256 + planRevisionId + packageId 为准**——正文一致性由 sha256 保证，
  版本与包一致性由产物清单核对保证。
- 引用还必须**绑定同一项目**：同一个计划版本不得在另一个项目里复用（hook 按账本里
  该计划版本的绑定记录判定）。发布方给的 `projectKey` 是项目名、宿主按 cwd 算的是路径，
  两者不同源，不直接硬比 —— 跨项目复用靠账本绑定拦住。
- 引用取不回或核对不过 → hook 直接拒绝这次派工，不会派出一个拿得到但被改过的 brief。
- 注入按工具实际的正文键：`task` 装进 `prompt`，`task_append` 装进 `content`
  （续派契约里没有 `prompt` 键，hook 不会自己加一个）。
- **你一个字都不要改 brief**——包括不要补"我觉得还该测什么"。
  更不要自己转写正文：复盘根因 C 就是主会话转写 brief，把候选原因改写成实现要求，
  一次就制造了 95M token 的返工链（2026-11-25 复盘 §四根因 C）。

主会话不写 brief，两个原因：

1. 主会话只有执行级模型（M3.1 Flash），判断力不如 Overmind。
2. brief 里的 Hypothesis 是**派工前**的预判——主会话在派工时没对结果做过预判，
   填出来的 Hypothesis 是编的，失去意义。

实测教训（见 `references/agent-brief-experiment.md`）：brief 的 Done 栏如果写成
"必须覆盖 A/B/C 三个场景"，worker 就只测这三个，哪怕多测一个更稳。
**Done 只给"一条命令 + 期望输出"**，测什么由执行者判断。
Overmind 知道这一点，所以契约里明确要求它这么写。

如果你发现 Overmind 的 brief 明显有问题（比如验收命令跑不通），
**不要自己修**——用 `--resume` 把问题反馈给 Overmind，让它改。

### 7. 验收（只做一次）

全部包完成后派 `agent_name="verifier"` 一次，`run_in_background=false`。
不要自己先验一遍再让 Verifier 验一遍。

Verifier 只拿三样东西：diff、需求说明、测试结果。不给作者的对话过程。

**证据链（官方 evidence-first-review 的做法，主会话自己也要走一遍）：**

1. **先看它跑过的命令和输出，再看它的总结**。"全部测试通过"是主张，不是证据。
2. 每个绿色检查要说得出两件事：它**证明了**什么、它**没证明**什么。
   填不出右列 = 还没理解这个检查，别急着接受。
3. 要它交出**默默做的决定**（选了哪些默认、哪些留在了范围外、两处需求打架时怎么 reinterpret 的）。
4. 问一句"什么会让这个结论是错的"，然后自己验那一件事。

**连续三轮 blocking 仍不过 → 停下来重新想，不要让 agent 再多转几轮。**

### 8. 收尾

- 核对 Verifier 结论与真实 diff
- 更新计划文件状态
- 向用户汇报：做了什么、验证了什么、什么没验证
- 同一条纠正出现两次 → 写成测试 / lint / hook / CI（官方 taste-to-checks）
- 会话太长写交接文档，新会话直接读它接着干（官方 handoff-doc）

## 第 9 步：把重复的纠正变成检查（收尾必做）

同一句纠正出现两次，就是我们的错。**不要把它记成"以后注意"**——记在脑子里的话，
下次会话还是会被跳过。要把它变成会自己跑的东西。

```bash
node scripts/lessons.mjs record "<纠正内容>"   # 记录一次纠正
node scripts/lessons.mjs list                    # 看哪些纠正已出现 ≥2 次
node scripts/lessons.mjs promote <ID>            # 升级为检查（写到 checks/ 下）
```

**升级门槛：同一条纠正出现 ≥2 次。** 一次性的怪癖不升级。

升级时按官方 `taste-to-checks` 的强度阶梯选落点，**越靠上越可靠**：

| 规则形态 | 落到哪 | 可靠性 |
|---|---|---|
| 要禁止的代码模式 | lint / grep 检查 | 最高，会自己失败 |
| 必须成立的行为 | 测试（先在坏版本上失败） | 高 |
| 每次编辑/提交都要发生 | hook | 高 |
| 需要上下文、无法机械化 | AGENTS.md / 本 skill | 最低，会被跳过 |

**落点优先级：`checks/` 下的脚本检查 > 测试 > hook > 写进本文件。**
写进本文件是最后手段，不是首选——AGENTS.md 和 skill 里的规则"读了有时会被忽略"，
一个失败的检查不会。

每条检查必须**先在造成过问题的旧现场验证它会失败**，再确认当前代码能过。
没失败过的检查不算数。

---

## 硬规则

- Codex 调用一律走 `scripts/codex-team.mjs`，不要直接裸跑 `codex exec`（裸跑会撞上本机 WebSocket 不通，每次白等 120 秒）
- 换 Overmind / Coder 的模型或后端：改 `config/team.json`。换 codex 模型前用 `codex debug models` 确认新 id 在目录里（网关会改名，旧 id 可能静默失效）。换 MCode 后端时模型必须在本机 `config.yaml` 里真实存在
- **主会话不得替 Overmind 做决策**：不判断该不该开、不拆包、不改 brief、不自己补需求隐含条件。用户追加的问题原样 `--resume` 给 Overmind
- Overmind 的方案和 brief 原样转发，不要"优化"措辞
- 每次派工都要记事件（`record-event.mjs`），必须带 `--project`、`--session`、`--task`、`--skill`，否则统计断链、也查不出该验收没验收
- 派工前的闸门由宿主 hook 自动执行：不要靠「记得跑脚本」，也不要改 hook 配置去绕过拒绝
- 规划阶段 Codex 一律 `--sandbox read-only`
- Worker 与 Codex 不同时改同一批文件
- 重要状态（计划、决定、验收结论）落盘，不只活在对话里
- 每条结论要么有证据，要么标注是假设
- 方法论判据用官方 mcode-stack 的 skill（已装在 `mcode` 插件里），别自己重写一套
- Codex 规划期不写实现代码；实现只由 Worker 做
