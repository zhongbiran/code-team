# 调用 Codex 的正确姿势

## 为什么必须走脚本

本机 WebSocket 到 ChatGPT 不通。裸跑 `codex exec` 会先空转 5 次重连（约 120 秒）才降级到 HTTPS，白烧一轮请求。

`scripts/codex-team.mjs` 做了三件事：
1. 用自定义 provider 覆盖，`supports_websockets = false`，直接走 HTTPS（实测 122s → 12s）
2. 统一注入模型、档位、只读沙箱
3. 解析 `--json` 输出里的 usage，累加到额度账本

## 用法

```bash
# 规划（Overmind / Coder）
node scripts/codex-team.mjs plan --prompt-file <需求文件> --role overmind
node scripts/codex-team.mjs plan --prompt-file <需求文件> --role coder

# 续聊同一线程（省 token：复用前缀缓存）
node scripts/codex-team.mjs plan --prompt-file <增量文件> --role overmind --resume <thread_id>

# 看额度账本
node scripts/codex-team.mjs budget
```

## 模型与档位

在 `config/team.json` 里改，脚本读它：

```json
{
  "overmind": { "model": "gpt-6.2-astra", "effort": "medium" },
  "coder":    { "model": "gpt-6.2-sol",    "effort": "medium" }
}
```

**模型可以随时换**，改配置即可，不用动脚本。换模型前用
`codex debug models | grep slug` 确认新模型在目录里（网关会改名，旧 id 可能静默失效）。

档位对应成本：
- `medium`：默认档。够用的方案规划用这个。
- `high`：只在多方案取舍、跨模块契约变更时用。
- `low` / `xhigh` / `max` / `ultra`：非必要不用，`ultra` 还带自动委派，和本工作流冲突。

## 输出格式

默认用 `--output-schema` 要结构化 JSON，含 `summary`、`steps`、`risks`、`openQuestions`。
不要结构化时用 `--plain`，输出纯 Markdown。

## 硬边界

- 规划阶段 `--sandbox read-only`，Codex 不许改文件
- 不要用 `--dangerously-bypass-approvals-and-sandbox`
- 不要把密钥写进 prompt
- 需求文件里不要塞无关的大段上下文（烧 token 且稀释注意力）
