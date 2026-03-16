---
title: Feishu Long Connection (WebSocket) Mode for OpenFang
date: 2026-03-16
status: draft
tags: [feishu, websocket, long-connection, channel]
---

# Feishu 长连接模式 Brainstorm

## What We're Building

将飞书渠道适配器从当前的 **Webhook HTTP 推送模式** 升级为支持 **长连接（WebSocket）模式**。

长连接模式下，OpenFang 主动向飞书建立 WSS 连接，无需公网 IP/域名，本地开发即可直接收发消息——与 OpenClaw 的行为完全一致。

---

## Context: Why This Matters

当前 `feishu.rs` 启动一个 Axum HTTP Server 监听 `webhook_port: 8453`，飞书将事件 POST 到这个端口。这要求：
- 服务器有公网 IP 或域名
- 防火墙放行端口

长连接模式：OpenFang 主动出站连接飞书的 `wss://` 端点，和 DingTalk Stream 模式完全类似。

---

## How OpenClaw Does It (参考实现)

OpenClaw 使用官方 `@larksuiteoapi/node-sdk`，核心流程：

### Step 1: 获取 WSS 连接 URL
```
POST https://open.feishu.cn/callback/ws/endpoint
Body: { AppID: "...", AppSecret: "..." }
Response: { URL: "wss://...?device_id=x&service_id=y", ClientConfig: { PingInterval, ReconnectCount, ... } }
```

### Step 2: 建立 WebSocket
```
connect_async(URL)  →  WebSocket 全双工通道
```

### Step 3: 帧协议（关键差异）
飞书使用 **Protobuf 帧**（非 JSON），格式 `pbbp2.Frame`：
```protobuf
message Frame {
  repeated Header headers = 1;
  uint64 service = 2;
  uint32 method = 3;   // 0=control(ping/pong), 1=data(event)
  uint64 seq_id = 4;
  uint64 log_id = 5;
  bytes payload = 6;   // JSON-encoded event data inside
}
message Header { string key = 1; string value = 2; }
```
Payload 内部是 base64/JSON 的事件数据。

### Step 4: Keepalive
- 每 120s（服务端可动态调整）发送一个 `FrameType.control` ping 帧
- 服务端回 pong，可下发新的 ping 间隔

### Step 5: 自动重连
- 服务端返回 `ReconnectCount=-1`（无限）、`ReconnectInterval=120s`、`ReconnectNonce=30s`（随机抖动）
- WebSocket `close` 事件触发重连

---

## OpenFang 现有模式（可复用）

DingTalk Stream (`dingtalk_stream.rs`) 已实现完全相同的外层架构：
1. HTTP 获取 token → 获取 WSS endpoint → `connect_async`
2. 外层重连循环 + 内层 `tokio::select!` 消息循环
3. 指数退避：`backoff(attempt)` 上限 60s
4. `tokio::sync::watch` shutdown 信号
5. 返回 `Box::pin(ReceiverStream::new(rx))`

**唯一的差异：** DingTalk 帧是 JSON，飞书帧是 **Protobuf**。

---

## Approaches

### 方案 A：添加 `prost` 解码 Protobuf 帧 ⭐ 推荐

在 `openfang-channels/Cargo.toml` 添加 `prost`，定义 `pbbp2.proto` schema，用 prost 解码/编码飞书帧。

**优点：**
- 类型安全，与飞书协议完全匹配
- prost 是 Rust 生态标准选择，成熟稳定
- 未来如飞书更新 proto schema，只需改 `.proto` 文件

**缺点：**
- 新增依赖（prost + prost-build）
- 需要了解 protobuf field ID（从 OpenClaw SDK 逆向可得）

---

### 方案 B：手动解码 Protobuf 二进制

不引入 `prost`，手写一个简单的 varint/length-delimited 解码器，直接处理飞书帧的二进制。

**优点：** 零新依赖

**缺点：**
- 脆弱，维护难度高
- Protobuf 编码细节容易出错（varint、wire type）
- 不推荐：代码复杂度远高于 prost

---

### 方案 C：保留 Webhook 模式，新增长连接模式（双模式）

`FeishuConfig` 增加 `connection_mode: "webhook" | "websocket"`（默认 `websocket`），两种模式共存，`start()` 根据配置分支。

**优点：**
- 已有 webhook 用户不受影响
- 适配有公网的部署场景

**缺点：**
- 代码量翻倍，需要维护两套逻辑

---

## Why Approach A (+ C) Is Recommended

- **方案 A** 解决核心协议问题（prost 解码 Protobuf）
- **方案 C** 的双模式作为 A 的补充，向后兼容已有 Webhook 配置

最终推荐：**实现 A，同时支持 C 的双模式开关**。

---

## Key Decisions

1. **帧协议**：用 `prost` 解码 Protobuf，payload 内部是 JSON
2. **连接模式**：`FeishuConfig` 增加 `connection_mode` 字段，默认 `websocket`
3. **重连策略**：复用 DingTalk 的指数退避模式，初始参数使用飞书服务端返回值
4. **ping 管理**：`tokio::time::interval` 驱动，间隔来自服务端 `ClientConfig.PingInterval`
5. **现有 webhook 兼容**：config 里没有 `connection_mode` 时默认 `websocket`（与 OpenClaw 一致）

---

## Resolved Questions

- **Q: 要不要删掉 webhook 模式？** → 保留，双模式共存
- **Q: prost 还是手写解码？** → prost，更安全

## Open Questions

- **proto schema 的完整 field ID** 需要从 OpenClaw SDK 源码进一步确认（尤其是 Header 的具体 key 名称）
- **飞书事件订阅** 是否需要在开发者控制台手动开启 `im.message.receive_v1` 权限？

---

## Sources

- OpenClaw 实现：`~/.nvm/.../openclaw/extensions/feishu/src/`
- 飞书文档：https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
- 参考实现：`crates/openfang-channels/src/dingtalk_stream.rs`
