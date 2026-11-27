# Code Team 全生命周期总结（2026-11-23 → 11-26）

> 一句话：**Code Team 从"一个想法"长成了一个带硬闸门、真实计量、跨后端统计的插件，
> 已经合入 GitHub `main`（`c16f2b1`）并可正常使用；但正式验收通道因两个宿主侧接线缺陷仍不通。**
>
> 本文回答四个问题：**怎么做的 / 犯了哪些错 / 怎么修的 / 现在能做什么。**
> 证据来源：插件仓库 git 历史、`config/events.jsonl`、`trajectory_studio` 运行时投影、
> `references/lessons-2026-11-24-rc-dustfall.md`、`references/lessons-2026-11-25-postmortem.md`、
> `references/acceptance-2026-11-25.md`。

---

## 一、时间线：23 条提交里的四个阶段

| 阶段 | 时间 | 关键提交 | 做了什么 |
|---|---|---|---|
| **① 立骨架** | 11-23 | `165616f` → `9604a6b` | 插件 + 控制台初版；仓库根改为插件根；根 `plugin.json`（Agent Plugins v1.0.0）+ `.minimax-plugin/plugin.json`（MiniMax）双清单并存 |
| **② 二期主线** | 11-24 | `6f13c38` → `747e9ed` | 控制台 MiniApp 拆独立仓库（两份清单不能共存）；跨机自举；双决策后端；角色→skill 路由；隔离开关统一到 session-start |
| **③ 复盘改造** | 11-25~26 | `e0a8438` | 按复盘六条硬规则改造插件，48 文件；三轮独立验收（FAIL 7 → FAIL 8 → 收窄定点） |
| **④ 合并发布** | 11-26 | `15beba1` → `c16f2b1` | 上下文窗口纪律（512k）；与二期主线合并成双亲提交，走 PR #1 合入 `main` |

**当前状态**：`main` = `c16f2b1`（父 `747e9ed` + `a26fe84`），发布树 `61acecde` 与已验树逐字节一致。

---

## 二、怎么做的：三个可复用的方法

### 1. 决策权外置（整个体系的地基）

初版最大的结构性错误是"主会话什么都能干"。改法不是加检查，而是**改权责边界**：

| 决策 | 归谁 |
|---|---|
| 值不值得规划 / 需求怎么理解 / 方案取舍 / 怎么拆包 / 每包 brief | **Overmind**（codex-cli · gpt-6.2-astra） |
| 接口设计、实现取舍、核心问题定位 | **Coder**（codex-cli · gpt-6.2-sol） |
| 怎么实现 | **Worker**（mcode-agent · M3.1-Flash） |
| 只读取证 / 独立验收 | **Explore** / **Verifier**（各只做一次） |
| —— | 主会话**只做四件事**：原样转交需求、原样转发 brief、追加问题用 `--resume`、汇报 |

为什么非如此不可：主会话用的是执行级模型（M3.1 Flash），让执行者自己验收自己，
等于把唯一能约束它的环节交给了它自己。

### 2. brief 由决策者落盘，主会话一个字不改

对照实验（`references/agent-brief-experiment.md`）发现两条：
- Done 栏写"必须覆盖 A/B/C 三个场景"，Worker 就只测这三个 → **Done 只给"一条命令 + 期望输出"**；
- 主会话转写 brief 时会偷偷补"我觉得还该测什么" → **补进去就等于改写，改写就绕过决策权边界**。

### 3. 重复纠正 → 会自己跑的检查

用户 11-23 定下的机制：**同一条纠正出现 ≥2 次才升级**，落点优先级
`checks/` 脚本 > 测试 > hook > 写进 SKILL.md（下策：skill 里的规则会被忽略，失败的检查不会）。
每条检查必须**先在旧现场验证它会红**，再确认当前能过。
事故样本故意留在 `briefs/*.md.bak`——它们就是"坏版本"的证据。

---

## 三、犯了哪些错，怎么修的

### 3.1 真实账：4.58 亿 token 里 41% 是返工

| 项 | 实测 |
|---|---|
| 总 token | **457,935,895** |
| cacheRead 占比 | **96.9%**（443,669,336） |
| tool 调用 | 5,644（失败 151，2.7%） |
| tool 等待 | 50,992 秒（14.2 小时） |
| 撞 5h 限额 | **3 次**，受害 5 个包 |
| 主会话跨度 | 27.6 小时 |

| 浪费 | token | 占比 |
|---|---|---|
| S1→F1 伪需求返工链（P10 + Verifier×2 + P11×2 + P12×2） | 94.7M | **20.7%** |
| 重跑（同一份活再干一遍：P2/P5/P9 首跑被杀） | 51.0M | **11.2%** |
| 有效交付 | ~312M | 68% |

**单包最贵**：P9 两轮 = 107.5M（23.5%），一个"分页 + 历史入口"的包。

### 3.2 四个根因 → 六条硬规则 → 具体修法

#### 根因 A · 闸门写得比事故晚，而且没人会跑

| 闸门写入时间 | 撞墙时刻 |
|---|---|
| `brief-requires-compile-gate.mjs` 11-25 05:25 | — |
| `brief-file-ownership-disjoint.mjs` 11-25 05:27 | — |
| `dispatch-guard.mjs` 11-25 10:01 | — |
| SKILL.md 三道闸 11-25 10:02 | — |
| **撞墙 ×3** | **11-24 16:00 / 11-25 02:01 / 11-25 07:01** |

三次撞墙**全部发生在闸门写好之前**——闸门一次都没在真实派工里生效过。
更要命的是 `checks/` 必须被显式调用才跑；在已经 547 步、上下文 1M 的会话里，
"记得跑一下检查"是不可靠的。

**修法（硬规则 1：闸门必须是 hook / CI）**：
- 闸门挂到宿主 hook：`hooks/hooks.json` 注册 SessionStart / PreToolUse / PostToolUse / SubagentStop；
  判定在 `scripts/dispatch-hook.mjs`，**派工前自动判一次，不合格直接拒绝，Task 不会被创建**。
- 四道闸现在的口径：

| 闸 | 内容 | 判定脚本 |
|---|---|---|
| 闸 1 | 编译闸：验收段必须含**编译**（`-ChecksOnly` 只是静态检查，不编译） | `checks/brief-requires-compile-gate.mjs` |
| 闸 2 | 文件归属互斥：两份 brief 的归属清单不得有交集 | `checks/brief-file-ownership-disjoint.mjs` |
| 闸 3 | 额度余量：读真实 usage，越界自动要求拆包/重拆 | `scripts/trajectory-usage.mjs` + `scripts/dispatch-guard.mjs` |
| 闸 4 | 隔离红线：测试不得连生产库 / 现场 Redis / 现场数据库 | 接线在 hook |

- 发布把关总入口：`node scripts/lessons.mjs check`（随包检查 + 台账已升级检查，**合并去重**；台账为空也照跑随包检查；台账引用缺失就报错，不静默跳过）。

> "两次编译都不过就交付"的直接原因：brief 的验收命令写的是 `verify.ps1 -ChecksOnly`，
> **那是纯静态检查，不编译**，Worker 拿它当编译证据。是主会话 brief 的缺陷，不是 Worker 的。

#### 根因 B · 撞墙后用同样方式重来

11-24 16:00:46 三个包（P2/P5/P9）同时被杀 → **16:01:42 同一分钟内重开 3 个续派**。
零分析、零降并发、零落盘核查。P9 续派又跑了 4,900 秒。

**修法（硬规则 3：撞墙后禁止同分钟重派同规模任务）**：
强制三件套 —— ①降并发 ②`git status` 核查落盘深度 ③续派书写明"已落盘什么 / 没做什么"。
并在 `scripts/retry-policy.mjs` 里固化为可判定逻辑（按 taskId / attemptId / 项目 / 计划关联宿主权威记录，
不再按"包号或主会话兜底"猜——那是串错任务的来源）。

#### 根因 C · 主会话同时扮演三个角色

实际执行：主会话亲手写 9 份 `brief-*.md`、自己修 F3、自己跑全量 verify、派了 **2 轮** Verifier。
结果 `Overmind 写 brief` 被架空 → brief 把**候选原因**写成**实现要求** → 直接制造 S1 事故 → 触发 95M 返工链。

**修法（硬规则 4 + 5）**：
- brief 由 Overmind 落盘，主会话原样转发，一个字都不改；
- 验收只做一次：首轮 FAIL 后由**执行者自证修复**，Verifier 不复验第二遍（除非改动了验收口径本身）；
- 主会话写实现代码 = 偏离工作流。

#### 根因 D · 成本模型指错了方向

旧教训文件写"MiniMax 侧没有前缀缓存"——**被实测证伪**：cacheRead/total = 96.9%。
真正的问题是**缓存读取同样计费**，且每次调用重发整个累积上下文。

`cacheRead ≈ toolCalls × 平均上下文长度`：
- P9 首跑：380 次调用 × ~171K = 65M
- P12 首跑：573 次调用 × ~61K = 35M

**杠杆是"少轮次、少读文件、早停"，不是"提高缓存命中率"。**

**修法（硬规则 2 + 6）**：
- 守卫读**真实 usage**（`trajectory_studio` 的 cacheRead / decode / toolCalls），不再用"包数 / 12"这种经验值；
- 成本闸看 toolCalls：**单包 > 200 次调用 = 拆；> 60M token = 重拆**；
- 覆盖度分三档 `complete / partial / unknown`，**缺值不是 0**：缺 `toolCallCount` 记 `null`，不参与累加；
- **逐尝试核对**：同一逻辑包多次尝试，每次都要有绑定且计量完整，有一次没绑 ⇒ 覆盖降为 unknown ⇒ 拒签；
- **上下文窗口 512k**（`config.yaml` 的 `defaultModelContextWindow` 从 1M 降下来）——窗口越大，
  每次调用重发越多，token 账会被放大到"跑很久产出为零"的量级。

### 3.3 三轮独立验收挖出来的真实缺陷

验收记录在 `references/acceptance-2026-11-25.md`。这不是走过场：

| 轮次 | 结果 | 典型缺陷 |
|---|---|---|
| 轮 1 | **FAIL 7 条** | 续派闸可被 `task_append` 绕过；计量 unknown 仍放行；单换验收口径 ID 就能再派 Verifier；brief 发布端与 hook 读取端默认目录不一致 |
| 轮 2 | **FAIL 8 条** | 续派能借用**别的任务**的失败证据；**预留被当成完成**；手写正文冒充 Overmind brief 能过；坏 JSON 退出 0 |
| 轮 3 | 收窄定点 | 8 条全部部分修好，剩余为窄边角反例 |

每条都带置信度、源码行号、复现样本和"什么证据能推翻它"。

### 3.4 本轮（发布阶段）犯的错

| 错 | 后果 | 修法 |
|---|---|---|
| `git init` 建了仓却**没配 remote** | "推不上去"，且差点误删远端独有文件 | `git remote add origin` + fetch 比对；仓库一直是 `zhongbiran/code-team`（public） |
| 不知道远端 main 已经更新（二期主线） | 以为本地是最新 | fetch 后比对，发现本地安装副本是旧快照 |
| 合并基线选错 | 差异过大 | 实测选 `d1c6334`（共有文件差异最小的一档） |
| 差点用整目录覆盖远端 | 会丢二期文件 | 定死"**单侧文件一律取来源方**"，冲突文件先放 main 版本，再逐个处理 |
| 用 squash/rebase 合并 | 丢双亲关系，两端历史断链 | 最终用**双亲提交 + merge commit**（父 `747e9ed` + `a26fe84`） |
| 正式验收被拒后想绕过 | 违反"不绕过"红线 | 把拒绝原话带回 Overmind（`--resume --plain`，46s），裁定"只认宿主受支持入口" |

### 3.5 三个取证出来的宿主侧缺陷（尚未修）

1. **worker 包永远没有终态回执** —— `hooks/hooks.json` 的 SubagentStop matcher 只匹配 `verifier`，
   后台派工宿主不补 worker 结算 ⇒ 账本里 pkg-a/pkg-b 只有 requested/reserved/started，无 `dispatch.settled`
   ⇒ E 闸整批验收永远被拒（`验收派工被拒：包未全部完成（缺 pkg-a、pkg-b）`）。
2. **宿主从 `plugin-hook-cache` 内容快照执行 hook** —— `ROOT` 变成缓存目录，
   `resolveRuntimeDataDir()`（固定 `resolve(ROOT,"..","..")`）找不到 `D:\.minimax`，
   MCP 数据根落到旧的 `C:\Users\biran\.minimax` ⇒ 读不到轨迹 ⇒ B 计量闸永远 `unknown`。
   **同一读取在本地脚本里 coverage=complete、386ms、退出 0**。
3. **宿主按会话开始时的插件快照执行 hook** —— 会话内改插件代码不生效（加的调试埋点在
   `%TEMP%` 与插件数据目录都无日志可证）。**修复后必须新会话才生效。**

---

## 四、现在能做什么

### 4.1 能跑的完整闭环

```
主会话（转交） → Overmind gpt-6.2-astra（决策/拆包/brief 落盘）
                 → Coder gpt-6.2-sol（接口方向，只读代码）
                 → worker / explore / verifier（M3.1-Flash，可并行）
                 → 事件流 events.jsonl（后端无关）→ 控制台 code-team-board
```

命令入口：

```bash
node scripts/codex-bootstrap.mjs <项目根> report        # 换机/换项目的后端就绪自检
node scripts/codex-team.mjs plan --prompt-file 需求.md --role overmind
node scripts/codex-team.mjs plan --prompt-file 需求.md --role coder
node scripts/codex-team.mjs plan --prompt-file 追加.md --role overmind --resume <thread>
node scripts/codex-team.mjs budget                      # 看用量
node scripts/skills-for.mjs <role> [--direction <id>]    # 取该角色的方法论附件
node scripts/dispatch-params.mjs <role>                  # 取已保存的 model/effort/agent，Task 参数照抄
node scripts/record-event.mjs record --kind dispatch ... # 派工前后各记一条
node scripts/dispatch-guard.mjs --plan N --pkg <包名> [--bind 包=子会话] --budget
node scripts/lessons.mjs check [--briefs <本轮 brief 目录>]   # 发布把关总入口
node scripts/rebuild-from-codex.mjs --days 7             # 从 Codex 会话回填事件流
```

### 4.2 能力清单

| 能力 | 现状 |
|---|---|
| 决策外置 | Overmind/Coder 走 `codex-cli`，模型与后端**可插拔**（`config/team.json` 改配置，不改流程） |
| brief 产物化 | 计划 → 严格 schema 校验 → 发布为**带 sha256 的产物文件**，读取时核对 sha256/字节数 |
| 硬闸门 | 编译闸 / 文件归属互斥 / 真实用量闸 / 隔离红线，**派工前 hook 自动拒签** |
| 真实计量 | 读 `trajectory_studio` 投影：input / cacheRead / decode / toolCalls，complete/partial/unknown 三档 |
| 自我提升 | `lessons.mjs record → list → promote → check`，重复纠正自动变成会跑的检查 |
| 跨后端统计 | 统一事件字段（backend/model/project/task/skill/plugin），换后端统计不改；控制台读同一份事件流 |
| 上下文纪律 | 执行侧子代理统一 **512k**，不开 1M；额度纪律：Overmind ≤1 次、Coder ≤2 次、追加问题走 `--resume` |
| 离线可测 | `node --test` 五文件 **182 tests / 181 pass / 0 fail / 1 skipped**（跳过项为环境性 MCP），不连生产库 |
| 发布把关 | `lessons.mjs check` 全绿 + `checks/workflow-contract.mjs` 全绿 + `codex-team.mjs budget` 退出 0 |
| 跨端安装 | 仓库根即插件根，Agent Plugins v1.0.0（Mac 导入认根 `plugin.json`）+ MiniMax 双清单 |

### 4.3 现在不能做什么（边界，必须知道）

1. **正式验收通道不通**。上面的 182 tests 是**候选树冒烟闸**，不是正式验收；
   **正式验收（verifier 一次）执行次数 = 0**，原因是根因 3.5 的 ①②③，不在本轮发布的代码里。
   修它需要另起包，且**改完必须新会话**。
2. **并发建议仍是经验值**（近 5h 派工包数 / 12），只作分批参考；放行结论只来自真实计量。
3. **没有套餐剩余百分比**：宿主只有 `fiveHour.remainingPercent`，与 Studio token 不同源，
   所以不显示也不折算——不拿不确定的数字当额度依据。
4. **Code Team 不替代 MCode 内置 Agent Team**。它多出来的是"决策权在外部、后端可换、统计跨后端"；
   普通单任务不要用它，派一个子代理就够。
5. `scripts/codex-team.mjs` 的 plan 阶段 Codex 一律**只读**；实现只由 Worker 做。

### 4.4 遗留项

| 项 | 状态 |
|---|---|
| 修 worker 终态回执缺失 + `resolveRuntimeDataDir()` 向上逐级探测数据根 | 待另起包（新会话才生效） |
| 清理插件目录 5 个 `tmp-probe-*.mjs` 探针文件（未跟踪，有被误提交风险） | 待清理（删除命令被安全策略拦截，需手工或 trash） |
| 控制台 `code-team-board` 独立仓库 | 独立演进，不在本仓库 |

---

## 五、一句话复盘

Code Team 这一轮真正的产出不是"多 Agent 编排"，而是**把三条教训从"写进文档"升级成"会自己跑的检查"**：
①闸门必须挂在 hook 上而不是靠人记得跑；②守卫必须读真实 usage 而不是拍脑袋的经验值；
③brief 的归属权必须从主会话手里交出去。
三件事都在 `e0a8438` 落成了代码，在 `c16f2b1` 合进了 main。

剩下没做完的只有一件：**宿主侧的两处接线缺陷让正式验收通道仍然关闭**——
这一条已经写在 PR #1 正文里，没有被藏起来。
