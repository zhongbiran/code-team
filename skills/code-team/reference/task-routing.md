# 任务方向选择指南

> 什么时候用哪个方向、方向里的 skill 从哪来、拿不到插件怎么办。
> 映射表本体在 `config/team.json` 的 `routing.directions`，**不在这里**——
> 改映射只改配置，不改文档、不改脚本。

## 为什么要分方向

角色基础 skills（`roles.*.skills`）是**方法论**：先写测试再实现、宣称做完前必须跑验证。
方向 skill 是**专业能力**：前端视觉怎么调、跨端功能怎么分层。

两者互不占用。方向 skill 每包最多附 **2 个**，角色基础 skills 不占这 2 个位置。

## 现有方向

| 方向 id | 命中场景 | 专业 skill（按优先级） |
|---|---|---|
| `frontend` | 前端视觉与交付 | `frontend-design:frontend-design`、`senior-fullstack-developer:frontend-dev` |
| `fullstack` | 跨端功能（前后端 + 接口） | `senior-fullstack-developer:fullstack-dev` |
| `notion-spec` | Notion 规格转实现 | `notion:notion-spec-to-implementation` |

**先取本包主能力，确有第二种交付需要时再加一个。** 一个包不要同时挂前端和全栈。

## 谁来选

**Coder 只读选择任务方向。** 主会话不判断方向（它只有执行级模型，判断力不如 Coder）；
Overmind 在 brief 里已标明方向时，按方向机械解析，不必再叫 Coder。

已标明方向的包，直接照 brief 走。

## 怎么用

```bash
# 1) 取本包要附的专业 skill（需要会话可见清单）
node scripts/skills-for.mjs worker --direction frontend --visible-file <会话清单.json>

# 2) 或者直接拿整份派工参数（含 model/effort 与附件）
node scripts/dispatch-params.mjs worker --direction frontend --visible-file <会话清单.json>
```

输出形状固定：

```json
{
  "role": "worker",
  "specialty": {
    "direction": "frontend",
    "skills": [{ "fullName": "frontend-design:frontend-design", "visibleName": "frontend-design:frontend-design" }],
    "skipped": [{ "fullName": "senior-fullstack-developer:frontend-dev", "reason": "not-visible" }]
  }
}
```

`skipped[].reason` 三种：

| reason | 含义 |
|---|---|
| `not-visible` | 会话清单里有，但这个 skill 不可见（插件没装 / 本会话没加载） |
| `visibility-unknown` | 拿不到会话清单，可见性无法确证 |
| `limit` | 可见，但排在第 3 个以后（每包最多 2 个） |

## 可见名 ≠ 完整名

方向里写的是**完整名** `<插件>:<skill>`（区分大小写）。
交给执行者的是**可见名**——宿主可能把同一个 skill 暴露成裸名。
脚本按 `fullName` 精确匹配，把对应的 `visibleName` 给执行者，别自己拼。

## 降级：插件没装怎么办

方向里的插件**不一定装了**（比如 `frontend-design`、`notion` 都不在默认安装里）。

- 能力缺失时仍可用**角色基础能力**完成工作——方向 skill 是加分项，不是前提。
- 缺少**不可替代的数据访问**（比如必须读某个 Notion 库）才报告具体阻塞。
- 工具明确返回 `Tool not found` 时，本任务内记为不可用，**不换参数重试**。

所以：`--direction frontend` 在前端插件没装时不会失败，只是 `specialty.skills` 为空、
`skipped` 里标 `not-visible`。执行者照常用角色基础能力干活。

## 和 model / effort 的关系

方向只管 **skill 附件**；`model` / `effort` 走 `scripts/dispatch-params.mjs`，
两者互不影响。

已保存的 `model`/`effort` 必须真的进入派工参数，不能只显示在页面上。
取不到宿主证据时，脚本报 `CAPABILITY_UNKNOWN` 并把原值留在 `requested` 里
供页面展示，**不伪造"已生效"、也不在调用时静默丢弃**。
