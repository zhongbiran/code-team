# Code Team (Antigravity Edition · `code-team-agy`)

面向 **Antigravity** 原生设计的三池多 Agent 工程协作插件，吸收了 MCode 版 `code-team` 的硬闸门与真实计量经验，同时完全独立运行、不修改原有 `mcode` 编排。

## 三池联动编排

| 角色 | 主力模型与档位 | 配额池 | 备用 / 升级 |
| :--- | :--- | :--- | :--- |
| **主会话** | `Gemini 4 Hydrogen (Medium)` | Gemini 池 | 只调度、转发、汇报 |
| **Overmind** | `Claude Opus 5.5 (Medium)` | Claude 池 | `Gemini 4 Neon (High)` / `Carbon (Medium)` |
| **Coder** | `Claude Opus 5.5 (High)` | Claude 池 | `Gemini 4 Neon (High)` / `Carbon (High)` |
| **Worker** | `MiniMax M3.1 Flash (high, 512k)` via `mcode exec` | MiniMax 池 | `Gemini 4 Hydrogen (Medium)` |
| **Explore** | `MiniMax M3.1 Flash (lightweight, max-steps 20)` | MiniMax 池 | `Gemini 4 Hydrogen (Low)` |
| **Verify** | `Claude Sonnet 5.5 (Medium)` | Claude 池 | `Gemini 4 Neon (Medium)`（异构验收，只验一次） |

## 常用 CLI 命令

```bash
PLUGIN="/Users/biranzhong/Projects/Yu.Projects/code-team/adapters/code-team-agy"

# 1. 发布并签名 Overmind Brief（校验编译闸 + 文件归属互斥 + sha256）
"$PLUGIN/scripts/run-node.sh" "$PLUGIN/scripts/brief-publish.mjs" \
  --brief ./pkg-a.md --plan p1 --pkg pkg-a --skills rust-hardware-protocol,context7-mcp

# 2. 双后端派发 Worker（默认走 mcode exec + 独立 worktree + 512k/步数限制）
"$PLUGIN/scripts/run-node.sh" "$PLUGIN/scripts/worker-dispatch.mjs" \
  --role worker --backend auto --plan p1 --pkg pkg-a \
  --repo /path/to/repo --brief ~/.gemini/antigravity/plugin-data/code-team-agy/briefs/p1/pkg-a.md \
  --worktree --dry-run

# 3. 查看各配额池用量与 Skill 使用统计
"$PLUGIN/scripts/run-node.sh" "$PLUGIN/scripts/record-event.mjs" summary

# 4. 运行全部硬闸门与插件健康自检
"$PLUGIN/scripts/run-node.sh" "$PLUGIN/scripts/lessons.mjs" check
```
