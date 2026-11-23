# 怎么用 Code Team

## 一句话

在对话里说"用 Code Team 做 X"。**决策不在你手里**——主会话只转交和转发，
所有判断由 Overmind 做。

## 首次启用

插件在 `D:\.minimax\plugins\code-team`。插件目录**不是热加载**的：

1. 打开 `/plugins`
2. 按 `Ctrl+R` 刷新
3. 找到 Code Team，按空格启用

启用后重开一个会话，skill 才会出现在可用列表里。

## 你的角色：侧边会话

主会话用的是执行级模型（M3.1 Flash），**它不做决策**。你只需要：

- 把需求告诉它，它会转交 Overmind
- 看 Overmind 的方案和拆包
- 中途要补充或改主意，它会 `--resume` 追加给 Overmind
- 看最终结果

**你不需要替它做技术判断，也不需要帮它写 brief。**

## 三种用法

### 1. 显式点名

    用 Code Team 实现用户导出功能
    Code Team 规划一下这个重构，然后并行做

### 2. 交半截需求

    这个功能要改 5 个模块

Overmind 自己会判断值不值得规划、怎么拆、要不要开 Coder。

### 3. 只要某个角色

    让 Overmind 只出方案，别动代码
    让 Coder 看看这个接口该怎么设计

## 中途追加问题

直接说就行，主会话会用 `--resume` 追加给 Overmind（复用缓存，不重开）。
**不要指望主会话自己消化你的补充**——它会转给 Overmind。

## 手动调用命令

```bash
cd D:\.minimax\plugins\code-team

# 规划（Overmind / Coder）
node scripts/codex-team.mjs plan --prompt-file 需求.md --role overmind
node scripts/codex-team.mjs plan --prompt-file 需求.md --role coder

# 追加问题（复用同一线程）
node scripts/codex-team.mjs plan --prompt-file 追加.md --role overmind --resume <thread_id>

# 看 Codex 额度账本
node scripts/codex-team.mjs budget

# 跑自动检查
node scripts/lessons.mjs check

# 同步 Codex 侧环境（换项目时做一次）
node scripts/codex-bootstrap.mjs <项目根目录> sync
```

## 换模型 / 换后端

改 `config/team.json`：

```json
{
  "overmind": { "backend": "codex-cli", "model": "gpt-6.2-astra", "effort": "medium" },
  "coder":    { "backend": "codex-cli", "model": "gpt-6.2-sol",    "effort": "medium" }
}
```

后端可以是 `codex-cli`（本机 Codex）或 `mcode-agent`（MCode 自身的子代理）。
换 codex 模型前先确认 id 有效：

```bash
codex debug models | findstr slug
```

网关会改名，旧 id 可能静默失效——这一步不能省。

## 典型节奏

```
你：给设备加个导出 CSV 功能，用 Code Team

主会话：把需求原样转交 Overmind（主会话不判断该不该开）
Overmind：真跑命令核实现状 → 决策记录（理由/放弃的方案/代价）→ 拆包 → 每包 brief → 指明哪几包要 Coder
主会话：原样转发
Coder：按 Overmind 指明介入 A 包，给参数识别顺序和数据流结论
主会话：原样转发 brief 给 Worker ×N（并行，文件不重叠）
Worker：按 brief 执行，只改自己那几个文件，自测
主会话：派 Verifier 一次（干净 context）
主会话：核对 → 汇报
```

## 常见问题

**Q：为什么不让主会话直接判断该不该开 Codex？**
主会话是执行级模型，判断"值不值得"需要判断力。实测证明 Overmind 拿到的方案质量
远高于主会话自己编的——它会真跑命令核实现状、给出带代价的取舍。

**Q：Overmind 和 Coder 有什么区别？**
Overmind 做所有非代码决策（方案、拆包、brief）；Coder 只做代码方向决策
（接口设计、实现取舍、核心问题定位）。两者都不写实现代码。

**Q：额度怎么控制？**
Overmind 一次任务至多 1 次、Coder 至多 2 次；追加问题用 `--resume` 复用缓存；
账本看 `budget`。

**Q：Codex 调用很慢？**
本机 WebSocket 不通，裸跑会白等 120 秒。脚本已封死这条路——
`no-bare-codex-exec.mjs` 检查会拦住绕过封装的调用。

**Q：能不能不用 Codex，用 MCode 自己当 Overmind？**
可以，`config/team.json` 里把 `backend` 改成 `mcode-agent`。
但注意本机只有 4 个模型可用，且 `opencode-go` 月度档当前已限额——详见
`references/architecture.md`。
