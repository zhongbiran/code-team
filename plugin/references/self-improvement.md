# 自动提升回路

## 问题

一个 agent 插件最容易腐化的方式是：每次会话靠人肉提醒"别忘了用封装调用"，
下一会话又忘了。写在 SKILL.md 里的规则"读了有时会被忽略"——官方
`taste-to-checks` 明确说了这一点。

## 回路长什么样

```
用户纠正 ──▶ lessons.mjs record ──▶ 同一条 ≥2 次 ──▶ 写成 checks/ 下的检查脚本
                                                              │
                        每次改动后 ──▶ lessons.mjs check ──────┘（自己失败，自己提醒）
```

四个命令：

```bash
node scripts/lessons.mjs record "<纠正内容>"    # 记一次纠正
node scripts/lessons.mjs list                    # 看哪些达到升级门槛
node scripts/lessons.mjs promote <ID> "<脚本名>" "<描述>"   # 升级成检查
node scripts/lessons.mjs check                   # 跑所有已升级的检查
```

## 升级门槛：2 次

**同一条纠正出现两次才升级。** 一次性的怪癖不升级——那会把噪声固化成规则。

## 落点优先级

| 规则形态 | 落到哪 | 为什么 |
|---|---|---|
| 要禁止的代码模式 | `checks/*.mjs` 脚本检查 | 会自己失败，最可靠 |
| 必须成立的行为 | 测试（先在坏版本上失败） | 同上 |
| 每次编辑都要发生 | hook | 每次都跑 |
| 需要上下文、无法机械化 | SKILL.md / AGENTS.md | **最后手段**，会被跳过 |

## 检查脚本的硬要求

1. **必须能在旧现场失败**。造一个坏版本，确认检查变红。没红过的检查不算数。
2. **必须能在当前代码通过**。红得太宽就是噪声，噪声等于没有检查。
3. **错误信息要能指导修复**，写清改哪里、怎么改。
4. **检查本身不能有硬编码绝对路径**（`no-hardcoded-abs-paths.mjs` 会查这个）。

## 现有检查

| ID | 检查 | 防什么 |
|---|---|---|
| L-001 | `no-bare-codex-exec.mjs` | 绕过封装裸跑 codex exec（本机 WebSocket 不通，裸跑白等 120 秒） |
| L-002 | `no-hardcoded-abs-paths.mjs` | 脚本硬编码绝对路径（工作区路径会随 junction 变） |

## 和官方 skill 的关系

官方 `mcode` 插件里已经装了 `taste-to-checks`（把重复纠正变成检查）和
`lifting-loops`（找出你总在给 agent 当"人工环节"的循环）。
Code Team 这套是**同一思路的轻量本地版**：台账在插件自己的 `config/lessons.json`，
不依赖外部脚本，不扫描历史会话。

区别：
- `taste-to-checks` 是通用 skill，靠 agent 在收尾时自觉调用
- Code Team 这套有**可执行的检查脚本**，改完代码能直接跑、会直接红
- `lifting-loops` 做的是更重的事：跨会话扫描、找循环、提改造提案
