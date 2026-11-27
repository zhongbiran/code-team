---
name: rust-hardware-protocol
description: Rust 与硬件设备对接（串口、USB/HID、BLE、TCP/UDP 二进制协议、FFI/嵌入式）的专业开发与验收技能。强制字节序与帧解析测试、异步断连恢复、unsafe 审查与硬件 Mock 隔离。
---

# Rust Hardware Protocol（Rust & 硬件对接铁律）

**适用时机**：编写或审查 Rust 代码，特别是涉及串口、USB/HID、BLE、CAN、二进制协议编解码、FFI 或与硬件外设交互时必须激活。

## 1. 先查真文档，绝不猜 crate API
- 引入或升级异步/硬件 crate（如 `tokio`, `tokio-serial`, `serialport`, `btleplug`, `rusb`, `bytes`, `nom`, `thiserror`, `tracing`）前，优先通过 `context7-mcp` 拉取当前 `Cargo.toml` 锁定版本的真实 API 文档。

## 2. 协议与内存安全硬约束
1. **二进制帧解析**：
   - 显式声明字节序（`from_be_bytes` / `from_le_bytes`），严禁依赖宿主默认端序或未对齐强转。
   - 必须使用增量状态机 / `BytesMut` 正确处理**半包、粘包、坏帧重同步与长度越界**。
   - 校验和 / CRC 必须有来自协议手册的真实字节向量（Golden Test Vector）单元测试。
2. **错误处理与 `unsafe` 红线**：
   - 生产代码路径**严禁裸 `.unwrap()` / `.expect()`**，统一返回结构化错误枚举（`thiserror`）并附带上下文。
   - 每一处 `unsafe` 块或 FFI 边界必须紧跟 `// SAFETY: ...` 说明所有前置不变量，且封装在最小安全抽象内。
3. **异步 I/O 与硬件韧性**：
   - 所有读写必须带显式超时（`tokio::time::timeout`），支持设备拔插/断连后的指数退避重连与优雅取消（Cancellation Safety）。
   - 严禁在异步执行器线程上跑阻塞 I/O 或持 `std::sync::Mutex` 跨 `.await`。

## 3. 硬件隔离红线与必跑编译闸
- **绝不在自动化单测中直连现场真实硬件**：协议与驱动逻辑必须通过 `Transport` trait 抽象，用虚拟字节流 / 录制的报文回放完成 100% 离线确定性测试。
- **验收 Done 命令最低门槛**：
  ```bash
  cargo check --all-targets && cargo clippy --all-targets -- -D warnings && cargo test
  ```
  *(如涉及交叉编译，必须额外运行对应 `--target <triple>` 的 `cargo check`。)*
