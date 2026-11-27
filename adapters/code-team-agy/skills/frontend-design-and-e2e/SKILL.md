---
name: frontend-design-and-e2e
description: 高质量前端设计系统与浏览器真实渲染验收技能（适配 Antigravity 内置 browser 子代理与 Microsoft Edge Playwright）。拒绝廉价 AI 模板风，强调设计 Token、交互完整度与真实页面零报错验收。
---

# Frontend Design & E2E（设计美学 + 真实渲染闭环）

**适用时机**：前端页面、组件库、可视化仪表盘、交互动效开发或前端 Verify 验收时激活。

## 1. 视觉与交互设计铁律
- **先查框架真文档**：使用新版 React / Vue / Next.js / Tailwind / 状态库 API 前，按需通过 `context7-mcp` 核对当前锁定版本写法。
- **拒绝廉价模板风**：
  - 严禁无脑堆砌默认紫蓝渐变、无层次的白底卡片墙或毫无目的的装饰徽章。
  - 先建立精简的 **Design Tokens**（语义色板、字体层级、间距标尺、圆角与阴影层次），保持视觉克制、信息密度与对齐精准。
- **全状态完备**：每个核心界面必须覆盖 **Loading（骨架屏/占位）、Empty（空状态引导）、Error（可重试错误态）、Responsive（桌面/窄屏无溢出）** 四种状态。
- **可访问性与键盘可用**：表单、弹窗、菜单具备合理语义标签、焦点状态与对比度。

## 2. 真实渲染与 E2E 验收（无需 Chrome，原生适配 Edge）
1. **构建闸**：先跑通真实类型检查与生产构建（如 `npm run typecheck && npm run build`，静态 lint 不算构建）。
2. **交互与视觉实测（两级闭环）**：
   - **日常快速验收（首选，零依赖）**：启动本地开发服务器后，直接调用 Antigravity **内置 `browser` 子代理** 打开页面，执行核心用户流并核查：
     - 视觉布局无截断/重叠；
     - Console **零未捕获异常 / 零 React Hydration 报错**；
     - Network **无意外 4xx / 5xx 请求**。
   - **自动化回归测试（CI / 本地命令行）**：统一使用 **Playwright 驱动本机 Microsoft Edge**（`channel: 'msedge'`），避免强制依赖 Chrome：
     ```ts
     // playwright.config.ts
     use: { channel: 'msedge', headless: true }
     ```
3. **交付附证**：验收报告必须写明实际跑通的构建命令、验证过的页面路由及检查结果。
