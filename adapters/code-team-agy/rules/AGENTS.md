# Code Team (Antigravity) Always-On Guardrails

1. **三档自适应**：1~2 个文件的轻量改动由当前会话直接完成，不启动多 Agent 团队；仅在用户点名 Code Team、涉及跨端/多模块并行、或需要异构模型攻坚/验收时加载 `code-team-agy` Skill。
2. **决策与执行分离**：启动 Code Team 后，主会话只负责需求转交、原样转发带 sha256 的 brief、汇总汇报与风险提示；**严禁改写 Overmind 落盘的 brief**，严禁把未验证假设写成实现需求。
3. **硬闸门不可绕过**：所有派工与验收必须遵守四道闸——① 真实编译闸（静态检查不算编译）；② 文件归属白名单互斥；③ 真实用量与单包步数/上下文软上限守卫；④ 生产环境/现场硬件隔离红线（单测严禁连生产库、现场 Redis 或现场真实硬件）。
4. **领域技能按需挂载**：
   - 跨前后端/硬件接口设计 → 加载 `contract-first-architect`
   - Rust / 硬件通信协议开发 → 加载 `rust-hardware-protocol` + `context7-mcp`
   - 前端界面开发与视觉验收 → 加载 `frontend-design-and-e2e`（优先内置 `browser` 子代理 / Edge Playwright）
   - 后端数据与隔离 → 加载 `backend-data-isolation`
   - 疑难 Bug 排查与 2 轮熔断升级 → 加载 `root-cause-and-escalation` + `systematic-debugging`
   - 并行开发合入 → 加载 `worktree-safe-merge`
   - 派工路由与配额核算 → 加载 `dual-backend-router`
5. **汇报必须透明记录 Skill**：每次 Code Team 任务结束，必须明确列出本轮实际激活使用的 Skill 清单、消耗的后端配额池及验收命令真实输出。
