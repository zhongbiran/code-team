# Code Team 用法与细节

主 SKILL.md 只留入口与红线，这里放细节。插件根目录：
Windows `%USERPROFILE%\.minimax\plugins\code-team`（其他平台按各自的插件目录）。
下面的 `node scripts/xxx.mjs` **都从插件根目录执行**。

## 一、何时触发

命中任意一条才用 Code Team：

1. 用户点名「Code Team」「团队协作」「并行开工」。
2. 用户要求**可选的外部大脑**参与决策（换模型、换后端、跨 CLI）。
3. 用户要求**按后端核算**这项团队任务（用量、事件归因、验收）。

不命中就别开——普通单任务、纯问答、纯查资料，派一个子代理更快。

**与 MCode 内置 Agent Team 的边界**：Code Team 不替代它。内置团队是「在会话里组队」，
Code Team 多出来的是「决策权在外部（Overmind，可换模型/可换后端）+ 统计跨后端（事件流）」。
要换模型、换 CLI、或要按后端核算用量时，才是 Code Team 的场景。

## 二、原生模式交接

宿主命令面板里的四个模式（中文标签 / 斜杠命令）。**只使用当前会话实际暴露的入口**——
面板里的条目受权限与开关控制，没出现就是本会话没有。

| 模式 | 命令 | 用途 | 交接要点 |
|---|---|---|---|
| 计划 | `/plan` | 大量有依赖、范围未定的工作 | 只读调查 → 出计划 → 按宿主流程提交用户审阅（「计划完成，实施计划？」，可预览也可要求调整）→ 批准后才执行 |
| 目标 | `/goal` | 有清楚终点、用户要求持续做到达标 | 持续推进到达标或阻塞；目标自带预算上限与校验子会话 |
| 压缩 | `/compact` | 长会话显式压缩 | 长会话**优先用宿主自动压缩**；显式压缩前先在包交接点落盘五件事（见下） |
| 侧边对话 | `/sidechat` | 可独立调查的问题 | 不打断主线；结论回主线后继续 |

两者同时命中（既要计划又要持续做到达标）→ **先审计划，再按目标推进**。

**压缩前必须落盘的五件事**（否则压缩完接不上）：

1. 原始需求引用（用户原话）
2. 已批 brief
3. 已完成的包
4. 下一条 Done（一条命令 + 期望输出）
5. 后端线程标识（Overmind / Coder 的 threadId，用于 `--resume`）

会话没暴露某个入口时的等价替代：独立调查 → 让 `explore` 子会话去查或新建一个会话；
计划 → 让 Overmind 在 brief 里出方案再由用户审；压缩 → 落盘交接文档；
侧边对话 → 把问题交给 `explore`。**替代了要在汇报里说明用的是哪种。**

## 三、角色与 skill 名单

| 角色 | 侧 | 该用的 skill | 为什么 |
|---|---|---|---|
| Overmind | Codex | `superpowers:brainstorming`、`superpowers:writing-plans`、`planning-with-files` | 需求澄清与方案收敛靠 brainstorming；拆包前先落一份文件化计划，长上下文不靠脑内记 |
| Coder | Codex | `superpowers:systematic-debugging`、`planning-with-files` | 定位核心问题按「假设→证伪」走，别直接猜修法 |
| worker | MCode | `superpowers:test-driven-development`、`superpowers:verification-before-completion` | 先写测试再实现；宣称做完前必须跑验证命令 |
| explore | MCode | 无 | 只读取证，不需要方法论流程 |
| verifier | MCode | `superpowers:verification-before-completion`、`superpowers:requesting-code-review` | 验收要证据（跑过的命令与输出），不是读总结 |

名单在 `config/team.json` 每个角色的 `skills` 字段里，**不写死在流程里**。
派工时用 `node scripts/skills-for.mjs <role>` 取当前角色的 skill 提示（**方法论**），原样贴进 Task prompt 末尾；
model / effort / agent 走 `node scripts/dispatch-params.mjs <role>`（见第五节）。

**别限制 Overmind 用 Codex 侧 skill**：实测它会自己调用（设计类任务自动用
`writing-plans`，诊断类自动用 `systematic-debugging`），并说明这些 skill 如何影响了它的
输出结构（拆包结构、假设与反证、验收标准）——这些是决策质量的一部分，别在契约里禁用它们。
`scripts/codex-team.mjs` 每次调用都会把该角色的 skill 自动追加成一段「本次可用 skill（命中才用）」，
**主会话不用手动点名**。反过来，**主会话自己不要用这些 skill 去做决策**——它只有执行级模型。

**两侧可见名不同**：Codex 侧平铺进 `~/.codex/skills/` 的 skill 是裸名，
MCode 侧插件里的带 `插件名:` 前缀。`config/team.json` 里按角色所在侧写对应名字。

**同名 skill 并存时模型会挑旧版**，所以必须点名带前缀的完整名——点名交给脚本，不靠模型自觉。

**Codex 侧 skill 列表有上下文预算上限**（实测）：往 `~/.codex/skills/` 平铺 19 个描述较长的 skill，
可见列表从 53 条缩到 34 条，按字母序排到 `v` 就断了，`superpowers:` 整组和 `work-pets:` 全部消失。
所以 Codex 侧不要平铺大批 skill，要么走插件形式（带前缀、描述精简），要么少放。

**专业方向**（前端视觉、跨端功能、Notion 规格转实现等）由 Coder 只读选择，
每包最多附加两个专业 skill，方向清单在 `config/team.json` 的 `routing.directions`。
可选插件缺失 → 按缺插件降级，用角色基础能力完成。

## 四、命令清单

```bash
# 后端就绪（换机器 / 换项目时做一次）
node scripts/codex-bootstrap.mjs <项目根目录> report   # 只看状态
node scripts/codex-bootstrap.mjs <项目根目录> sync     # 同步 Codex 侧环境（幂等）

# 决策调用
node scripts/codex-team.mjs plan --prompt-file <需求文件> --role overmind
node scripts/codex-team.mjs plan --prompt-file <需求文件> --role coder
node scripts/codex-team.mjs plan --prompt-file <追加内容> --role overmind --resume <thread_id>
node scripts/codex-team.mjs budget                    # 看用量账本

# 派工参数
node scripts/skills-for.mjs worker                    # 该角色的 skill 提示（贴进 Task prompt）
node scripts/skills-for.mjs worker --direction <id> --visible-file <json>   # 选专业方向时的专业附件
node scripts/dispatch-params.mjs worker               # 该角色的派工参数（model/effort/agent，贴进 Task prompt）
node scripts/dispatch-params.mjs worker --direction <id> --visible-file <json>   # 派工参数 + 专业附件
node scripts/dispatch-params.mjs --capabilities       # 宿主实际支持哪些 model/effort（控制台按它渲染）

# 事件流（统计的唯一来源）
node scripts/record-event.mjs record --kind dispatch --role worker --backend mcode-agent \
  --model <模型> --project <项目名> --session <主会话 id> --task <任务名> --skill <skill 名> --plugin code-team
node scripts/record-event.mjs record --kind dispatch-result --role worker --backend mcode-agent \
  --project <项目名> --session <主会话 id> --task <任务名> --elapsed-sec <秒> --ok true|false

# 同一次调用的两条事件共用一个 invocationId（看板靠它归组成「一次调用」）
node scripts/record-event.mjs record --kind dispatch --role worker --agent worker \
  --invocation-id <invocationId> --status started --project <项目名> --session <主会话 id> --task <任务名>
node scripts/record-event.mjs record --kind dispatch-result --role worker --agent worker \
  --invocation-id <invocationId> --status succeeded --elapsed-sec <秒> --ok true --project <项目名> --task <任务名>

# 隔离事件流：CODE_TEAM_EVENTS 把写与读都指到别处
CODE_TEAM_EVENTS=<临时事件流路径> node scripts/record-event.mjs record --kind dispatch ...
CODE_TEAM_EVENTS=<临时事件流路径> node scripts/record-event.mjs list

# 自我提升与发布把关
node scripts/lessons.mjs record "<纠正内容>"
node scripts/lessons.mjs list
node scripts/lessons.mjs promote <ID> "<检查脚本名>" "<描述>"
node scripts/lessons.mjs check [--briefs <目录>] [--project <根目录>]   # 发布把关总入口
node scripts/lessons.mjs list-checks  # 只列将要跑的检查，不执行
```

**事件流的 CLI 参数**（连字符拼法；契约的 camelCase 拼法等价）：`--kind`、`--invocation-id`、
`--agent`、`--status`、`--call-mode`、`--error-code`、`--requested-model`、`--requested-effort`。
完整参数表与取值见 `references/codex-invocation.md`（§命令行记事件）——**只维护那一份**。

**`CODE_TEAM_EVENTS` 覆盖事件流路径，写与读都覆盖。**
只隔离写不隔离读是个更坑的陷阱：`list` 会把真实运行态读出来，测试结论全错。
测试与验收一律把它指到临时目录；别的隔离开关（配置、账本、schema）也在同一份文档里。

需求文件写**用户原话**。不要替用户改写、补全或「优化」措辞——
主会话的理解不如 Overmind 准，用户没说的让 Overmind 去问、去假设并在方案里标出来。

## 五、派工参数与专业方向（dispatch-params）

`node scripts/dispatch-params.mjs <role>` 产出一次内置派工的参数 JSON。
**控制台里改了 Worker/Explore/Verifier 的 model 或思考强度，必须用这个入口把它带进 Task 参数**——
只在页面上改了、调用时没带上，等于没改（`checks/task-routing.mjs` 专门盯这个症状）。

```bash
node scripts/dispatch-params.mjs worker                                  # 派工参数
node scripts/dispatch-params.mjs worker --direction frontend             # 带专业方向附件
node scripts/dispatch-params.mjs --capabilities                          # 宿主实际支持哪些 model/effort
```

输出字段：

| 字段 | 意思 |
|---|---|
| `invocationId` | 本次派工的标识；记事件时用 `--invocation-id` 带上，看板靠它把同一次调用的多条事件归成一次（参数表见 `references/codex-invocation.md`） |
| `role` / `backend` / `agent` | 角色、后端、执行角色的 agent 标识（决策角色的 `agent` 是 `null`） |
| `model` / `effort` | **已证实可下传**的值；置空表示这一项没下传 |
| `requested` | 配置里保存的原值（`model`/`effort`），即使没下传也保留在这里供展示 |
| `status` | `OK` = 全部已证实；`CAPABILITY_UNKNOWN` = 有值取不到宿主证据，未下传 |
| `capability` | 逐字段的取证结论：`state` 是 `confirmed`（可下传）或 `unknown`（不可下传），`values` 是取值域 |
| `taskArgs` | **照抄进 Task 工具的参数**（`agent_name` / `model` / `effort`）；非内置后端为 `null` |
| `attachment.specialty` | 专业方向附件（见下） |
| `notes` | 人话说明哪一项没下传、为什么 |

**能力未证实怎么办**：`status` 为 `CAPABILITY_UNKNOWN` 时，脚本**把没证实的值置空**，
`taskArgs` 里也不会有那个键，原值保留在 `requested` 里。
**不许伪造已生效**：不要手填一个 model 塞进 Task 参数，也不要静默丢弃——
按 `requested` 的原值向用户说明「这个档位本机证实不了」，让用户改配置或换模型。

取证口径（脚本自己做的，不用主会话判断）：宿主运行时配置 `config.yaml` 里装着的 model 与 effort 档位、
内置 agent 定义 `agents/<role>/agent.md` 声明的 model/effort、宿主自己的模型目录快照
`cache/models-dev-catalog.json`。取不到证据就不下传。

### 专业方向附件

命中任务方向时用 `--direction <id>` 取附件（方向 id 在 `config/team.json` 的 `routing.directions`）：

```bash
node scripts/skills-for.mjs worker --direction frontend --visible-file <会话清单.json>
```

- `--visible-file` 指向**目标会话的 skill 可见清单**，内容是
  `[{ "fullName": "插件:skill", "visibleName": "插件:skill" }, ...]`；省略它等于 null
  （拿不到清单 → 全部按 `visibility-unknown` 跳过，专业附件为空）。
- 输出 `{ role, specialty }`，`specialty` = `{ direction, skills, skipped }`：
  `skills` 每项 `{ fullName, visibleName }`（每包最多 2 个），
  `skipped` 每项 `{ fullName, reason }`，`reason` ∈ `not-visible`（清单里没有）、
  `visibility-unknown`（拿不到清单）、`limit`（可见但排不进前 2 个）。
- 未知方向 / 清单格式错 → **退出码 1**，字段路径写 stderr（如 `routing.directions.frontend`），
  stdout 不出半截结果。
- `dispatch-params.mjs --direction <id> --visible-file <json>` 把同一个 specialty 放进
  `attachment.specialty`，派工时照抄它即可。

## 六、事件流字段

- `--project`：当前工作目录的仓库名（项目根目录名）
- `--session`：**主会话 id**（从 `<agent-context>` 的 YOUR SESSION ID 取，形如 `mvs_xxx`）。
  Codex 调用会自动带 threadId；派工要手动带这个，两者才能归到同一个会话
- `--task`：Overmind 给的包的标题，一句话
- `--skill`：这次派工用到的 skill 名（没有就填 `code-team`）
- `--plugin`：固定 `code-team`

**新字段**（决策调用与派工都写）：`--invocation-id`（同一次调用共用一个）、`--agent`、
`--status`（`started` / `succeeded` / `failed`）、`--call-mode`（`new` / `resume`）、
`--error-code`、`--requested-model`、`--requested-effort`。没给的字段就不写这条事件
（老事件保持逐字节不变）。参数表见 `references/codex-invocation.md`。

**统计口径**：看板的 `totals.events` 数的是**调用次数**，不是事件条数——同一次调用
（共享 `invocationId`）的多条事件只计一次，完成状态与用量取结果事件；
**历史里没有 `invocationId` 的事件仍逐条计数**（沿用原读取逻辑）。原始事件表仍逐条展示。

不记事件，控制台就统计不出「消耗集中在哪些项目、哪些任务」，也查不出该验收的没验收。

## 七、额度与账本

- 一次任务 Overmind **至多 1 次**、Coder **至多 2 次**。
- 用户追加问题用 `--resume` 续聊同一线程，复用前缀缓存，**不重开**。
- 规划期 Codex 一律只读。
- `node scripts/codex-team.mjs budget` 看用量与缓存命中率。

## 八、缺插件 / 缺后端降级

- **目标机器没装 Codex CLI**：预检会给出阻塞项与一条可执行的下一步；不要崩，也不要假装调用成功。
- **没装某个专业插件**：按缺插件降级——用角色的基础方法论完成工作，
  只有缺不可替代的数据访问才报告具体阻塞。
- **没配可用的外部决策后端**：明示可以改用内置 Agent Team 或配另一个后端，
  **不要默默换掉 Overmind**——决策权归属是这套流程的地基。
  外部决策后端有两种：`codex-cli`（本机 Codex）与 `external-command`（用户配置的本地命令），
  配置、续问口径与一条完整示例见 `references/codex-invocation.md`。
- **会话启动快照**：插件列表在会话启动时构建，装完要 `/plugins` → `Ctrl+R` → 重开会话。

## 九、验收证据链（Verifier 交什么，主会话怎么读）

Verifier 只拿三样东西：diff、需求说明、测试结果。**不给作者的对话过程。**

主会话自己也要走一遍官方 evidence-first-review：

1. **先看它跑过的命令和输出，再看它的总结。**「全部测试通过」是主张，不是证据。
2. 每个绿色检查要说得出两件事：它**证明了**什么、它**没证明**什么。
   填不出右列 = 还没理解这个检查，别急着接受。
3. 要它交出**默默做的决定**（选了哪些默认、哪些留在了范围外、两处需求打架时怎么 reinterpret 的）。
4. 问一句「什么会让这个结论是错的」，然后自己验那一件事。

**连续三轮 blocking 仍不过 → 停下来重新想，不要让 agent 再多转几轮。**

收尾还要做：核对 Verifier 结论与真实 diff、更新计划文件状态、向用户汇报
（做了什么 / 验证了什么 / 什么没验证）；会话太长写交接文档，新会话直接读它接着干。

## 十、自我提升：把重复的纠正变成会自己跑的检查

同一句纠正出现两次，就是我们的错。记在脑子里的话下次会话还是会被跳过，
要把它变成会自己失败、自己提醒的东西。

```bash
node scripts/lessons.mjs record "<纠正内容>"    # 记一次
node scripts/lessons.mjs list                   # 看哪些到了 2 次
node scripts/lessons.mjs promote <ID> "<脚本名>" "<描述>"   # 升级成检查
```

**升级门槛：同一条纠正出现 ≥2 次。** 一次性的怪癖不升级。

落点优先级：`checks/` 脚本 > 测试 > hook > 写进 SKILL.md。最后一项是下策——
skill 里的规则「读了有时会被忽略」，一个失败的检查不会。

每条检查必须**先在造成过问题的旧现场验证它会失败**，再确认当前代码能过。

方法论来源：官方 mcode-stack（ronny 栈）的 `taste-to-checks`、`lifting-loops` 等，
提纯对照见 `references/official-stack-distilled.md`。Code Team 是编排层，不复制这些 skill。

## 十一、发布检查

总入口只有一个：

```bash
node scripts/lessons.mjs check
```

它做两件事，合并去重后一起跑：

1. **随包发布的必跑检查**：`checks/` 下的每个 `.mjs`（含两个禁止项
   `no-bare-codex-exec.mjs`、`no-hardcoded-abs-paths.mjs`，与本次新增的
   `workflow-contract.mjs`、`check-discovery.mjs`）。
2. **台账里已升级的检查**：`lessons.json` 中 `promoted` 的条目。
   台账引用缺失就报错，不静默跳过。

**空台账也必须跑随包检查**——台账为空不是「没有检查可跑」，是「随包检查还没被跑到」。

同名的检查只跑一次（台账 promote 的名字若已在 `checks/` 里，不重复跑）。
检查脚本不许再调总入口（会无限递归），总入口用 `CODE_TEAM_CHECK_DEPTH` 挡住。

## 十二、常见问题

**Q：为什么不让主会话直接判断该不该开 Codex？**
主会话是执行级模型，判断「值不值得」需要判断力。实测 Overmind 拿到的方案质量
远高于主会话自己编的——它会真跑命令核实现状、给出带代价的取舍。

**Q：Overmind 和 Coder 有什么区别？**
Overmind 做所有非代码决策（方案、拆包、brief）；Coder 只做代码方向决策
（接口设计、实现取舍、核心问题定位）。两者都不写实现代码。

**Q：Codex 调用很慢？**
本机 WebSocket 不通，裸跑会白等约 120 秒。脚本已封死这条路——
`checks/no-bare-codex-exec.mjs` 会拦住绕过封装的调用。

**Q：能不能不用 Codex，用 MCode 自己当 Overmind？**
可以，`config/team.json` 里把 `backend` 改成 `mcode-agent`。
主会话的行为不变——它只管转交和转发。

**Q：验收到底做几次？**
一次。全部包完成后派 `verifier` 一次（干净 context）。
不要「主会话自验一遍 + 再派 verifier 复核一遍」——那是重复劳动。
## 十三、派工标记与闸门（宿主自动执行）

宿主 hook 在 `task` / `task_append` 每次派工前自动判一次（注册在 `hooks/hooks.json`，判定脚本
`scripts/dispatch-hook.mjs`），不合格直接拒绝，Task 不会被创建。四道闸：

| 闸 | 判定口径 | 判定脚本 |
|---|---|---|
| 1 编译闸 | brief 验收段必须含**编译**；`-ChecksOnly` 是纯静态检查，不编译 | `checks/brief-requires-compile-gate.mjs` |
| 2 文件归属互斥 | 每份 brief 有「文件归属」段，两份归属清单不得有交集 | `checks/brief-file-ownership-disjoint.mjs` |
| 3 额度余量 | 真实用量（cacheRead / decode / toolCalls），同一包累计越界自动要求拆包 | `scripts/trajectory-usage.mjs` |
| 4 隔离红线 | Worker 测试不得连生产库 / 现场 Redis / 现场数据库 | 写进 brief，由执行者与验收各守一次 |

手跑核对（发布把关总入口，brief 参数会透传给上面两道闸）：

```bash
node scripts/lessons.mjs check                                   # 随包检查 + 台账已升级的检查
node scripts/lessons.mjs check --briefs <本轮 brief 目录>          # 用本轮样本跑编译闸 / 归属闸
node scripts/lessons.mjs check --briefs <目录> --project <项目根>   # 再指定目标项目根
```

`--briefs` 指向的目录里没有 .md brief 时，闸门**判失败**（零样本通过不算数）；不传时扫插件自带的
`briefs/` 与 `tmp/` 目录。随包检查与台账条目**按文件名合并去重**，同名只跑一次；
检查脚本不许再调总入口（递归由 `CODE_TEAM_CHECK_DEPTH` 挡住）。

派工时必须带的标记（缺一个就被 hook 拒绝）：

```
code-team-plan: <计划版本>
code-team-package: <包号>
code-team-brief-ref: {"planRevisionId":…,"packageId":…,"artifactId":…,"sha256":…,"byteLength":…}
```

- `code-team-plan` 给出**批次边界**：归属互斥只在同一个 plan 内比较。
- `code-team-package` 给出**包号**：没有包号就认不出「同一个包的重派」，也拿不到这个包的真实用量。
- `code-team-brief-ref` 是 brief 产物引用：正文由 Overmind 发布、宿主按引用核对后装进 prompt，
  **手写正文一律退 2**。校验口径 = sha256 + planRevisionId + packageId；引用必须绑定同一项目，
  跨项目复用靠账本绑定拦住。注入按工具实际的正文键：`task` 进 `prompt`，`task_append` 进 `content`。
- Worker 在别的目录干活（多 worktree 仓库）时加一行 `code-team-worktree: <工作树绝对路径>`：
  hook 记下基线提交，撞墙续派按「基线..HEAD」取证，否则干净树上的已提交变更会被当成零落盘。

续派与验收的标记：

- 续派（`task_append`）带 `code-team-retry: {…}` 与
  `code-team-continuation: {"persistedWork":…,"remainingWork":…}`（两段缺一不可）。宿主真实入参只有
  `{task_id, content}`，没有 agent_name，hook 靠派工账本还原角色与包号；认不出归属就退 2，不兜底放行。
- 续派的失败证据（机器码 / 失败时刻 / attempt / 原并发 / 批次 / 原 Worker 工作树）**只认派工账本**，
  提示词里写的不算（只能做交叉校验，写错反而会被拒）。
- 验收派工带 `code-team-verification-key: {"planId":…,"criteriaRevisionId":…}`：同一验收口径第二次
  派工会被拒（状态落盘 `PLUGIN_DATA/verification-state.json`）。
- 验收结论带 `code-team-verification-evidence: {"outputRefs":[…]}`；判 FAIL 还要带 `commands` 与
  `exitCodes`。**没有证据引用的结论不落盘。**
- 执行者交自证时带 `code-team-self-evidence: {…}`（挂在同一条验收记录上，不重派 Verifier）。

某个闸的模块缺失或报错时，hook **按模块降级**：与本次派工相关的闸降级 = 直接拒绝并写明
「该闸未生效：<模块> <原因>」；不相关的闸降级只记进事件。排障时可用环境变量 `CODE_TEAM_GATE=off`
临时关闭（别常开）。

## 十四、上下文窗口纪律（2026-11-26）

**别给执行侧子代理开 1M 上下文。** 每次模型调用都重发整段累积上下文，窗口越大，token 消耗按
累积上下文线性放大——缓存读取同样计费（实测 cacheRead 占总用量 96.9%）。本机已把
`defaultModelContextWindow` 从 1000000 降到 **512000**（模型自身上限本来就是 512000，1M 只是
标 `higher_usage` 的可选项），实测新开的 worker 会话 `contextWindowTokens = 512000`，无需重启宿主。

代价：压缩会更早发生。worker 的长任务靠 brief + 文件落盘交接，别让它把整份源码读进上下文来「记住」。

## 十五、拆包规模判据（2026-11-24 实测）

- **单包首跑超过 30 分钟就是包太大**，拆细。两个实测反例：模拟引擎包与 WebAdmin 历史包首跑
  3.5 小时后撞额度被杀；同期只改一个枚举规则的包 32 分钟收工。
- **改动共享层（Application 层公共文件）的包单独成包**，且不与其它包并行。
- **调研与实现分开**：先派 `explore` 只读取证（一个包只查一个主题；实测一次塞 5 个主题，输出循环
  卡死后被杀），证据落盘后再派实现。
- **不要三层重复读同一批代码**：Overmind 已给 file:line 裁定，Coder 与主会话不必再抄一遍，
  brief 里带结论即可。
- 额度中断的包**不重派同一个 brief**：先 `git status` 核查落盘深度，续派任务书写明「已落盘什么 /
  没做什么」，否则新 Worker 会从零重写或覆盖已有实现。

## 十六、复盘六条硬规则的出处

规则全文见 `references/lessons-2026-11-25-postmortem.md`（2026-11-25 RC.DustFall 12 项复盘：
总 token ≈ 4.58 亿，cacheRead 占 96.9%，撞 5h 限额 3 次，返工链吃掉 41%）。六条规则的落地位置：
闸门在 `scripts/dispatch-hook.mjs`，真实用量在 `scripts/trajectory-usage.mjs`，撞墙续派在
`scripts/retry-policy.mjs`，一次验收在 `scripts/verification-policy.mjs`。

## 十七、典型用法与节奏

```
你：给设备加个导出 CSV 功能，用 Code Team

主会话：把需求原样转交 Overmind（主会话不判断该不该开）
Overmind：真跑命令核实现状 → 决策记录（理由/放弃的方案/代价）→ 拆包 → 每包 brief → 指明哪几包要 Coder
主会话：原样转发
Coder：按 Overmind 指明介入 A 包，给参数识别顺序和数据流结论
主会话：原样转发 brief 引用给 Worker ×N（并行，文件不重叠）
Worker：按 brief 执行，只改自己那几个文件，自测
主会话：派 Verifier 一次（干净 context）
主会话：核对 → 汇报
```

中途要补充或改主意：直接说，主会话会 `--resume` 追加给 Overmind（复用缓存，不重开）——
**不要指望主会话自己消化你的补充**。

