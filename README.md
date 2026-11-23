# Code Team

多 Agent 协作工作流：**决策权在 Overmind，不在主会话**。

```
主会话（侧边转交） → Overmind（决策） → Coder（代码方向） → Worker / Explore / Verifier（执行）
                                          ↓
                              事件流 events.jsonl（后端无关）
                                          ↓
                              Code Team 控制台（MiniApp）
```

## 为什么这样分工

主会话用的是执行级模型（M3.1 Flash）。让执行级模型做决策，等于让执行者自己验收自己。
所以决策全部交给 Overmind：值不值得规划、需求怎么理解、方案取舍、怎么拆包、每包的 brief。
主会话只做四件事：转交需求、转发结果、追加用户问题、汇报。

## 仓库结构

| 路径 | 是什么 |
|---|---|
| `plugin/` | Code Team 插件本体（流程、角色、埋点、检查） |
| `miniapps/code-team-board/` | Code Team 控制台（MiniApp：诊断 + 统计 + 配置） |
| `docs/` | 调研与设计文档 |
| `research/` | MiniMax Code 官方博客原文（12 篇） |

## 安装

### 1. 插件

把 `plugin/` 整个目录复制到 MiniMax Code 的本地插件目录，然后打开 `/plugins` 按 `Ctrl+R` 刷新，
找到 Code Team 按空格启用。**重开一个会话**，skill 才会出现在可用列表里。

Windows 上的默认位置是 `%USERPROFILE%\.minimax\plugins\code-team`。

### 2. 控制台（可选）

控制台的 MiniApp 包在 `miniapps/code-team-board/`。它读的是插件目录里的事件流，
所以**必须先装插件**，控制台才有数据。

在 MiniMax Code 里对 Agent 说「把这个目录做成 Mini App」，
或者用 `/miniapp-creator` 指向该目录。

## 角色配置

全部在 `plugin/config/team.json`，控制台的「配置」页可以直接改并写回。

| 角色 | 类型 | 默认后端 | 默认模型 | 职责 |
|---|---|---|---|---|
| Overmind | 决策 | codex-cli | gpt-6.2-astra | 方案、拆包、每个包的 brief |
| Coder | 决策 | codex-cli | gpt-6.2-sol | 接口设计、实现取舍、核心问题定位 |
| Worker | 执行 | mcode-agent | MiniMax-M3.1-Flash | 按 brief 实现，可并行 |
| Explore | 执行 | mcode-agent | MiniMax-M3.1-Flash | 只读取证 |
| Verifier | 验收 | mcode-agent | MiniMax-M3.1-Flash | 独立验收，只做一次 |

后端两种：`codex-cli`（本机 Codex CLI）或 `mcode-agent`（MCode 自身子代理）。
**换后端或模型改配置即可，不用改流程。**

## 用法

```bash
cd <插件目录>

# 规划（Overmind / Coder）
node scripts/codex-team.mjs plan --prompt-file 需求.md --role overmind
node scripts/codex-team.mjs plan --prompt-file 需求.md --role coder

# 追加问题（复用同一线程，省 token）
node scripts/codex-team.mjs plan --prompt-file 追加.md --role overmind --resume <thread_id>

# 看用量
node scripts/codex-team.mjs budget

# 跑自动检查
node scripts/lessons.mjs check
```

在对话里直接说「用 Code Team 做 X」也可以，主会话会转交 Overmind。

## 两个必须知道的坑

### 1. Codex 调用必须走封装

本机 WebSocket 到 ChatGPT 不通。裸跑 `codex exec` 会先空转 5 次重连（约 120 秒）才降级 HTTPS。
封装脚本用自定义 provider 关掉 WebSocket，实测 122 秒 → 12 秒。
`checks/no-bare-codex-exec.mjs` 会拦住绕过封装的调用。

### 2. 派工必须记事件

每次派工前后各记一条事件，带 `--project`、`--session`、`--task`、`--skill`。
不记的话控制台统计不出"消耗集中在哪些项目、哪些任务"，也查不出该验收没验收。

## 持续自我提升

同一条纠正出现两次，就是我们的错。把它变成会自己跑的检查，而不是记在脑子里。

```bash
node scripts/lessons.mjs record "<纠正内容>"    # 记一次
node scripts/lessons.mjs list                   # 看哪些到了 2 次
node scripts/lessons.mjs promote <ID> "<脚本名>" # 升级成检查
node scripts/lessons.mjs check                  # 跑所有检查
```

落点优先级：`checks/` 脚本 > 测试 > hook > 写进 SKILL.md。
最后一项是下策——skill 里的规则"读了有时会被忽略"，一个失败的检查不会。

每条检查必须**先在旧现场验证它会失败**，再确认当前代码能过。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/架构.md](docs/架构.md) | 决策权归属表、后端可插拔、Overmind 契约 |
| [docs/使用手册.md](docs/使用手册.md) | 怎么调用、换模型、典型节奏 |
| [docs/mcode-最佳使用方案.md](docs/mcode-最佳使用方案.md) | 从官方博客提炼的使用原则 |
| [docs/mcode-stack-提纯.md](docs/mcode-stack-提纯.md) | 官方 skill 到本工作流的映射 |
| [docs/agent-brief-实测记录.md](docs/agent-brief-实测记录.md) | brief 的对照实验与结论 |
| [docs/市场对比分析.md](docs/市场对比分析.md) | 与 MiniMax 插件市场的对比、差距与提升点 |

## 许可

MIT
