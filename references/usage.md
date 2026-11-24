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
派工时用 `node scripts/skills-for.mjs <role>` 取当前角色的 skill 提示，原样贴进 Task prompt 末尾。

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

# 自我提升与发布把关
node scripts/lessons.mjs record "<纠正内容>"
node scripts/lessons.mjs list
node scripts/lessons.mjs promote <ID> "<检查脚本名>" "<描述>"
node scripts/lessons.mjs check        # 发布把关总入口
node scripts/lessons.mjs list-checks  # 只列将要跑的检查，不执行
```

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
| `invocationId` | 本次派工的标识，记事件时带上，便于把派工参数与事件对上 |
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
