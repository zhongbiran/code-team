---
name: contract-first-architect
description: 跨前端、后端与 Rust 硬件项目的“契约先行”架构技能。在多模块并行派工前，强制先落盘机器可校验的接口与协议真源，防止并行 Worker 各写各的导致联调返工。
---

# Contract-First Architect（契约先行）

**适用时机**：任何涉及 ≥2 个异构层（前端 / 后端 / Rust 硬件通信 / 持久化存储）的任务，在 Overmind 拆包或 Coder 定锚阶段必须激活。

## 强制步骤
1. **建立单一真源（Single Source of Truth）**：
   - **前后端 HTTP/WebSocket**：先落盘 OpenAPI YAML、JSON Schema 或共享 TypeScript 类型文件（`contracts/*.ts` / `openapi.yaml`）。
   - **后端 ↔ Rust 硬件协议**：先落盘协议规范与 Rust 类型定义（帧头、长度、字节序 Big/Little Endian、校验和/CRC 算法、错误码枚举、超时与状态机转换表）。
2. **明确版本与兼容策略**：标注破坏性变更（Breaking Change）与向后兼容方案，列出所有调用方清单。
3. **落盘“会红的”契约测试骨架**：
   - 在派发业务 Worker 前，至少准备 1 个序列化/反序列化或接口契约校验测试（初始运行必须失败），让下游 Worker 以“让契约测试变绿”为锚点。
4. **口径 / 枚举 / 类型扩展六处全覆盖铁律**：
   - 凡涉及新增或修改状态码、类别枚举（kind/type/status），一个包必须一次性对齐全部 6 处，缺一不可：
     `① 枚举/Schema 定义` → `② 映射表` → `③ 读路径（查询/回读）` → `④ 写路径与校验` → `⑤ 存量数据兼容` → `⑥ 前端契约`。
5. **契约冻结与变更协议**：
   - Worker 并发开工期间契约视为只读；若任一 Worker 发现契约无法落地，必须回报 `BLOCKED` 由 Coder 统一修订契约并同步受影响包，严禁单方面私改字段名或字节偏移。
