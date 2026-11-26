# agent-brief 谁写、怎么写：实测记录

> 实验时间：2026-11-23。同一任务、同一模型、两个独立工程目录，只差"派工前有没有 brief"。
> 结论来自实际跑出来的两份产出，不是推测。

## 实验设计

| 组 | 派工内容 |
|---|---|
| **对照组**（无 brief） | 任务描述 + 验收标准 + "完成后返回你的结论" |
| **实验组**（有 brief） | 官方 agent-brief 卡片：Stakes / Hypothesis / Goal / Out of scope / Done / Mode / When done |

任务：给 src/tokens.js 加 dedupeTokens(tokens)，保持首次出现顺序、只保留非空字符串、
大小写敏感，并补测试。基线 1 个测试通过，验收 = npm test 全绿且 exit code 0。

两个工程目录完全独立，避免两个 worker 改同一批文件。

## 实测结果

**两组都真的做出来了**：两个目录 npm test 都是 tests 4 / pass 4 / fail 0。
README.md 和 package.json 两组都没动。**功能上无差别**。

代码差异只有三处：

| 差异点 | 对照组（无 brief） | 实验组（有 brief） | 谁对 |
|---|---|---|---|
| 引号风格 | 双引号（跟项目现有代码一致） | 单引号（跟 brief 卡片里的例子一致） | **对照组** |
| 测试覆盖 | 多测了非字符串入参（null/undefined/1/{}） | 严格按 brief 只测三个场景 | **对照组** |
| 输出顺序 | 先结论，命令输出在后 | 命令输出在前，摘要在后（按 brief 要求） | 按需 |

## 三个结论

### 1. brief 的价值不在"让输出有结构"

worker agent 自带的 system prompt 里已经写死了输出格式：

    Return:
    - Result
    - Changes made, with file paths
    - Validation run and observed results
    - Assumptions
    - Blockers / remaining risks

所以**不带 brief，输出也已经是三段式的**。brief 在"格式"这一层是冗余的。

brief 真正带来的差别只有两处：**输出顺序**（命令在前）和**决策记录更细**
（实验组明确说明了"已排除 sort 去重和 Map 保留最后一次"）。

### 2. brief 由主会话写，不是子代理写

子代理拿不到主会话的上下文——方案、取舍理由、已知坑都在主会话脑子里。
让子代理"先写 brief 再干"，它写出来的只能是任务复述，没有信息增量。

主会话手上有 Overmind 的方案和自己在写 hypothesis 时想清楚的东西，
**只有它知道这个包为什么存在**。所以 brief 是主会话的**产出物**，是派工的输入。

### 3. Done 写太死会削弱 worker 的判断（本次最有价值的发现）

实验组的 brief 里写了"新增测试必须覆盖：首次出现顺序、空串过滤、大小写敏感这三个场景"，
worker 就**只测了这三个**——尽管它同时实现了一个非字符串过滤逻辑，
多测一个 null/undefined 入参更稳，它没测。

对照组没有这个约束，反而自己多测了非字符串入参。

**教训**：Done = (tangible check) 应该给**一条命令 + 期望输出**，
而不是穷举"该测什么"。前者是验收线，后者是替 worker 做技术判断。

这一条在官方 agent-brief 原文里是 "Pick something we can check later"——
强调的是"可检查"，不是"穷举"。我的第一版模板把"可检查"写成了"穷举"，是我的设计失误。

## 因此模板改成什么样

    Stakes: low | high
    Hypothesis: <主会话对结果的预判，派工前写>
    Goal / users / out of scope: ...
    Done = (tangible check): <一条命令 + 期望输出>
    Mode: think with me | do it for me
    When done: show commands run and their output first, then the summary,
    then the decisions and assumptions you made.

变化：
- Done 从"必须覆盖 A/B/C 三个场景"改成"跑 npm test，退出码 0 且 pass 数 = 4"
- 明确标注 Hypothesis 由主会话在派工前填
- 明确 Out of scope 要写，但别写死"不许做什么测试"

## 没有验证的部分

- **只跑了一次**。官方 harness-experiment 要求每道题跑多次看噪声，这里没做。
  两次结果的差异有可能来自随机性而非 brief。
- **只测了一个任务类型**（加函数 + 补测试）。brief 在重构、调研、紧急修复上的表现没测。
- **没测 Stakes: high 与 Mode: think with me 的效果差异**。
- 两组用的是同一个 worker 定义、同一模型，但没有固定随机种子。
