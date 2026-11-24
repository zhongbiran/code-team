# 决策调用的两种方式

决策角色（Overmind / Coder）的调用入口是 `scripts/codex-team.mjs`，派发逻辑在 `scripts/decision-backend.mjs`。
角色配置里的 `backend` 决定这次调用走哪条路：

| backend | 谁来跑 | prompt 怎么送 | 续问 |
|---|---|---|---|
| `codex-cli` | 本机 codex CLI（走自定义 provider，直连 HTTPS） | 整个 prompt 走 stdin，命令行给 `-` | 支持，`exec resume <thread_id>` |
| `external-command` | 用户配置的本地外部命令 | 整个 prompt 走 stdin | **v1 不支持** |

`backend` 缺省是 `codex-cli`。写了不认识的后端不会静默换后端，直接报 `INVALID_CONFIG`。

## 为什么 codex-cli 必须走脚本

本机 WebSocket 到 ChatGPT 不通。裸跑 codex 会先空转 5 次重连（约 120 秒）才降级到 HTTPS，白烧一轮请求。
封装做了三件事：

1. 用自定义 provider 覆盖，`supports_websockets = false`，直接走 HTTPS（实测 122s → 12s）
2. 统一注入模型、档位、只读沙箱
3. 解析 JSONL 输出里的 usage，累加到额度账本

## 用法

```bash
# 规划（Overmind / Coder）
node scripts/codex-team.mjs plan --prompt-file <需求文件> --role overmind
node scripts/codex-team.mjs plan --prompt-file <需求文件> --role coder

# 续聊同一线程（省 token：复用前缀缓存）
node scripts/codex-team.mjs plan --prompt-file <增量文件> --role overmind --resume <thread_id>

# 只看拼好的 prompt，不发请求、不记事件
node scripts/codex-team.mjs plan --prompt-file <需求文件> --role overmind --print-prompt

# 看额度账本
node scripts/codex-team.mjs budget
```

## codex-cli 后端的输入输出契约

**输入**

- 命令行：`exec`（续问是 `exec resume <thread_id>`）+ provider 覆盖 + `-m <model>` + `-c model_reasoning_effort="<effort>"` + `--sandbox read-only`（仅新调用）+ `-C <cwd>`（仅新调用）+ `--json` + `--output-schema <schema>`（非 `--plain` 时）
- stdin：整个 prompt，UTF-8。命令行上用 `-` 明确表示"从标准输入读"

**输出**

stdout 是 JSONL，每行一个事件：

- `{"type":"thread.started","thread_id":"..."}` —— 线程 ID，续问句柄就是它
- `{"type":"item.completed","item":{"type":"agent_message","text":"..."}}` —— 最终助手文本，也就是规划结果
- `{"type":"turn.completed","usage":{...}}` —— 用量

**model / effort**：命令行的 `-m` 与 `-c model_reasoning_effort=` 传，值取自角色配置的 `model` / `effort`。
模型与档位的可选值来自本机证据 `~/.codex/models_cache.json`（`codex debug models` 的本地缓存），按所选模型过滤档位。

**续问标识**：线程 ID。`--resume <thread_id>` 时，脚本会先到本地事件流里核对这个线程是不是本后端确认过的，
且提供方、后端、角色都对得上，才走 `exec resume`；对不上就报 `RESUME_MISMATCH`，一次都不启动。
输出里的线程 ID 与请求的不一致时，不记 `callMode:"resume"`。

## external-command 后端的输入输出契约

**输入**

- 程序：配置里的 `executable`（程序名或绝对路径），**不经 shell 启动**
- 参数：配置里的 `args` 数组，**按元素原样传**，不做 shell 拼接
- 占位符：`args` 里**完整等于** `{model}` / `{effort}` 的元素会被替换成角色配置里的 `model` / `effort`。
  没有对应占位元素时，这两个字段不生效（事件里记为 null）
- stdin：整个 prompt，UTF-8，写完即关

**输出**

- 退出码 0 且 stdout 非空 → **完整 stdout 就是结果**
- 退出码非 0 → `NONZERO_EXIT`，stderr 只作诊断摘要（脱敏后写进事件，不写全文）
- 退出码 0 但 stdout 为空 → `INVALID_OUTPUT`

**续问**：v1 固定 `resume: "none"`。收到续问句柄就返回 `RESUME_UNSUPPORTED`，**启动次数为 0**，
也不会失败后自动重开。需要继续时，带完整上下文重新发起一次新调用。

**支持域**：Windows 的 `.cmd` / `.bat` 不在支持域（必须经 shell 才能跑）。认证由对应 CLI 自己负责。

### 一条完整的外部命令配置示例

```json
{
  "roles": {
    "overmind": {
      "label": "Overmind",
      "kind": "decision",
      "backend": "external-command",
      "executable": "my-decision-cli",
      "args": ["--prompt", "-", "--model", "{model}", "--effort", "{effort}", "--json"],
      "model": "my-house-model",
      "effort": "high",
      "agent": null,
      "skills": []
    },
    "coder": {
      "label": "Coder",
      "kind": "decision",
      "backend": "codex-cli",
      "model": "gpt-6.2-sol",
      "effort": "medium",
      "agent": null,
      "skills": []
    }
  }
}
```

跑起来是什么样：

```
$ my-decision-cli --prompt - --model my-house-model --effort high --json < prompt.txt
{ "summary": "...", "steps": [], "risks": [], "openQuestions": [] }
```

这段命令要满足：prompt 从 stdin 收、结果打到 stdout、退出码 0 表示成功。
外部命令返回的内容要是现有规划输出（`config/plan-schema.json` 那套结构，或 `--plain` 下的 Markdown）。

## 事件流

一次尝试写一条 `kind:"call"` 事件，老的 `codex-call` 继续可读。看板按 `invocationId` 每次调用只算一次。

- `backend`：实际用的后端
- `model` / `effort`：运行端报告的实际值；外部命令没报告就填 null
- `requestedModel` / `requestedEffort`：这次请求的值
- `callMode`：`"new"` / `"resume"` / null（进程没启动时为 null）
- `status`：`"succeeded"` / `"failed"`
- `errorCode`：`INVALID_CONFIG` / `PREFLIGHT_BLOCKED` / `RESUME_UNSUPPORTED` / `RESUME_MISMATCH` / `SPAWN_FAILED` / `TIMEOUT` / `NONZERO_EXIT` / `INVALID_OUTPUT`

事件里**不含** prompt、原始命令参数、完整 stdout/stderr；错误摘要先脱敏再截断。

### 命令行记事件

`scripts/record-event.mjs record` 能写上面这整条事件，参数用连字符风格（跟 `--elapsed-sec` 一致），
落到事件里是契约的 camelCase 字段名：

| 命令行参数 | 事件字段 | 取值 |
|---|---|---|
| `--kind` | `kind` | `call`（默认）/ `dispatch` / `dispatch-result` |
| `--invocation-id` | `invocationId` | 与派工事件同一个 ID，看板靠它归组 |
| `--agent` | `agent` | 执行角色标识；决策调用为 null |
| `--status` | `status` | `started` / `succeeded` / `failed` |
| `--call-mode` | `callMode` | `new` / `resume` |
| `--error-code` | `errorCode` | 契约 1 的错误码 |
| `--requested-model` | `requestedModel` | 本次请求的模型 |
| `--requested-effort` | `requestedEffort` | 本次请求的档位 |

没给的字段就不写这条事件（不会凭空多出一堆 null）。契约里的 camelCase 拼法（`--invocationId` 等）也收，
两种拼法等价。

事件流路径用 `CODE_TEAM_EVENTS` 覆盖，默认是 `config/events.jsonl`。测试与验收务必指到临时目录：

```bash
CODE_TEAM_EVENTS=/tmp/ct-events.jsonl node scripts/record-event.mjs record --kind dispatch --role worker --agent worker --invocation-id inv-1 --status started
CODE_TEAM_EVENTS=/tmp/ct-events.jsonl node scripts/record-event.mjs list
```

## 硬边界

- 规划阶段 `--sandbox read-only`，Codex 不许改文件
- 不要用 `--dangerously-bypass-approvals-and-sandbox`
- 不要把密钥写进 prompt
- 需求文件里不要塞无关的大段上下文（烧 token 且稀释注意力）
- 外部命令不经 shell 拼参数，别指望支持管道、重定向或 `&&`

## 隔离运行（测试与验收用）

这几个环境变量能把配置、事件、账本指到别处，别名都指向隔离目录：

```
CODE_TEAM_CONFIG     配置文件路径
CODE_TEAM_EVENTS     事件流路径
CODE_TEAM_LEDGER     用量账本路径
CODE_TEAM_SCHEMA     规划输出 schema 路径
CODE_TEAM_CODEX_ENTRY  codex 的 JS 入口（测试时指向替身）
CODE_TEAM_MODELS     模型目录证据文件
```
