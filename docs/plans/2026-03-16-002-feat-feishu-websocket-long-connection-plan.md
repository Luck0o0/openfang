---
title: "feat: Feishu WebSocket Long Connection Mode"
type: feat
status: completed
date: 2026-03-16
origin: docs/brainstorms/2026-03-16-feishu-long-connection-brainstorm.md
---

# feat: Feishu WebSocket Long Connection Mode

## Overview

Upgrade the Feishu channel adapter from **Webhook-only HTTP push mode** to support **WebSocket long-connection mode**, enabling OpenFang to receive Feishu events without a public IP or domain — identical to how DingTalk Stream works today.

**Key insight:** The Feishu developer console requires an active WebSocket connection to be established *before* it allows saving the "long connection" configuration. As long as OpenFang only starts an inbound HTTP server (the current behavior), the Feishu console will show "未检测到应用连接信息" indefinitely.

## Problem Statement

`crates/openfang-channels/src/feishu.rs` currently launches an Axum HTTP server on `webhook_port: 8453` and waits for Feishu to POST events inbound. This requires:

- A publicly reachable IP or domain
- Firewall/port-forwarding setup
- Cannot be used in local development

The Feishu platform supports a **client-initiated outbound WebSocket** mode (`长连接`) that eliminates all three requirements. OpenFang does not implement this mode.

## Proposed Solution

Implement WebSocket long-connection mode modeled after `crates/openfang-channels/src/dingtalk_stream.rs` (see brainstorm: `docs/brainstorms/2026-03-16-feishu-long-connection-brainstorm.md`).

The structural difference from DingTalk Stream is that Feishu frames are **Protobuf binary** (`pbbp2.Frame`), not JSON. We will use the `prost` crate for type-safe decode/encode.

A `connection_mode` config field allows both modes to coexist — webhook users are unaffected.

## Technical Approach

### Architecture

```
FeishuConfig.connection_mode = "websocket" (default)
    │
    ▼
start_websocket_loop()
    │
    ├─ POST /callback/ws/endpoint { AppID, AppSecret }
    │       → { URL: "wss://...", ClientConfig: { PingInterval, ... } }
    │
    ├─ connect_async(URL)  →  WsStream
    │
    ├─ connect_async(URL)  →  WsStream.split() → (sink, stream)
    │        │
    │        ├─ mpsc::channel(64) → write_tx / write_rx
    │        │        │
    │        │        ├─ tokio::spawn(writer_task(sink, write_rx))   ← sole owner of sink
    │        │        │
    │        │        ├─ tokio::spawn(heartbeat_task(write_tx.clone(), ping_interval))
    │        │        │
    │        │        └─ message loop (stream)
    │        │               │
    │        │               ├─ Binary(bytes) → prost::decode::<Frame>(bytes)
    │        │               │       ├─ method=0 (control) → write_tx.send(pong_frame)
    │        │               │       └─ method=1 (data)    → decode payload → ChannelMessage
    │        │               │                              → write_tx.send(ack_frame)
    │        │               │
    │        │               └─ Close / Error → break → reconnect with backoff
    │
    └─ reconnect loop (exponential backoff, capped 60s)
```

### Proto Schema (extracted from OpenClaw SDK)

```proto
// crates/openfang-channels/proto/feishu_frame.proto
syntax = "proto3";
package pbbp2;

message Frame {
  uint64 seq_id         = 1;   // varint
  uint64 log_id         = 2;   // varint
  uint64 service        = 3;   // varint
  uint32 method         = 4;   // 0=control, 1=data
  repeated Header headers    = 5;
  string payload_encoding    = 6;
  string payload_type        = 7;
  bytes  payload             = 8;
  string log_id_new          = 9;
}

message Header {
  string key   = 1;
  string value = 2;
}
```

**Header keys of interest:**
- `type` → message type: `"event"`, `"card"`, `"ping"`, `"pong"`
- `message_id` → for deduplication
- `biz_rt` → business routing tag
- `handshake-status` / `handshake-msg` / `handshake-autherrcode` → auth handshake on connect

**ACK response frame** (sent after processing a `data` frame):
```json
{ "code": 200, "data": "<base64-of-message_id>" }
```
Encoded as protobuf `Frame` with `method=1`, headers `[{key:"type", value:"ack"}]`.

### WSS Endpoint Request/Response

```
POST https://open.feishu.cn/callback/ws/endpoint        (CN region)
POST https://open.larksuite.com/callback/ws/endpoint    (INTL region)

Body:   { "AppID": "...", "AppSecret": "..." }

200 OK: {
  "code": 0,
  "data": {
    "URL": "wss://…?device_id=x&service_id=y",
    "ClientConfig": {
      "PingInterval":    120,
      "ReconnectCount":  -1,
      "ReconnectInterval": 120,
      "ReconnectNonce":  30
    }
  }
}
```

Non-zero `code` (e.g. `401`, `403`) → fatal, do not retry immediately (see gap #5).

### Implementation Phases

#### Phase 1: Add `prost` dependency and generate proto types

**Files to change:**
- `crates/openfang-channels/Cargo.toml` — add `prost = "0.13"`, `prost-build = "0.13"` (build-dep)
- `crates/openfang-channels/proto/feishu_frame.proto` — create with schema above
- `crates/openfang-channels/build.rs` — create to call `prost_build::compile_protos`
- `crates/openfang-channels/src/feishu_proto.rs` — `include!(concat!(env!("OUT_DIR"), "/pbbp2.rs"));`

```rust
// crates/openfang-channels/build.rs
fn main() {
    prost_build::compile_protos(&["proto/feishu_frame.proto"], &["proto/"])
        .expect("prost codegen failed");
}
```

**Verify:** `cargo build -p openfang-channels` compiles without errors.

#### Phase 2: Extend `FeishuConfig` with `connection_mode`

**File:** `crates/openfang-types/src/config.rs`

Add to `FeishuConfig` struct:
```rust
/// Connection mode: "websocket" (long-connection, no public IP required) or
/// "webhook" (legacy HTTP push, requires public IP).
/// Default: "websocket".
#[serde(default = "default_connection_mode")]
pub connection_mode: String,
```

Add helper:
```rust
fn default_connection_mode() -> String { "websocket".to_string() }
```

Add to `Default` impl:
```rust
connection_mode: default_connection_mode(),
```

**Verify:** `cargo build --workspace --lib` compiles; existing webhook tests unaffected.

#### Phase 3: Implement `start_websocket_loop()` in `feishu.rs`

This is the core phase. Modeled directly on `dingtalk_stream.rs` outer loop.

**New structs needed (in `feishu.rs`):**
```rust
#[derive(Deserialize)]
struct WssEndpointResp {
    code: i32,
    data: Option<WssEndpointData>,
    msg: Option<String>,
}
#[derive(Deserialize)]
struct WssEndpointData {
    #[serde(rename = "URL")]
    url: String,
    #[serde(rename = "ClientConfig")]
    client_config: ClientConfig,
}
#[derive(Deserialize)]
struct ClientConfig {
    #[serde(rename = "PingInterval")]
    ping_interval: u64,
    #[serde(rename = "ReconnectCount")]
    reconnect_count: i64,
    #[serde(rename = "ReconnectInterval")]
    reconnect_interval: u64,
    #[serde(rename = "ReconnectNonce")]
    reconnect_nonce: u64,
}
```

**`start_websocket_loop()` skeleton:**
```rust
async fn start_websocket_loop(
    app_id: String,
    app_secret: String,
    region: String,
    tx: mpsc::Sender<ChannelMessage>,
    mut shutdown: watch::Receiver<()>,
) {
    let mut attempt = 0u32;
    loop {
        tokio::select! {
            _ = shutdown.changed() => { break; }
            result = connect_once(&app_id, &app_secret, &region, &tx) => {
                match result {
                    Ok(()) => { attempt = 0; }
                    Err(FatalError) => { break; }         // auth error → stop
                    Err(RetryableError) => {
                        let delay = backoff(attempt);
                        attempt += 1;
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
    }
}
```

**`connect_once()` steps:**
1. HTTP POST to WSS endpoint URL (retry-able if network error, fatal if 401/403)
2. Parse `ClientConfig`
3. `connect_async(url)` → `WsStream.split()` → `(sink, stream)`
4. 创建内部写通道：`let (write_tx, write_rx) = mpsc::channel::<Message>(64)`
5. Spawn writer task：`tokio::spawn(writer_task(sink, write_rx))` — **sink 所有权移入，无锁**
6. Spawn heartbeat task：`tokio::spawn(heartbeat(write_tx.clone(), ping_interval))`
7. Message loop 消费 `stream`，ACK / pong 通过 `write_tx.send(...)` 非阻塞发送
8. On loop exit: abort heartbeat + writer task handles ← **critical: prevent task leak**

```rust
// writer_task: sink 的唯一所有者，串行化所有写操作，无需任何锁
async fn writer_task(
    mut sink: SplitSink<WsStream, Message>,
    mut rx: mpsc::Receiver<Message>,
) {
    while let Some(msg) = rx.recv().await {
        if sink.send(msg).await.is_err() {
            break;
        }
    }
    let _ = sink.close().await;
}
```

**Gap fixes baked in:**

| Gap | Fix |
|-----|-----|
| Concurrent sink writes | Writer task 独占 `sink`；heartbeat + ACK 通过 `mpsc::Sender` 投递，**零锁争用** |
| Heartbeat task leak | Store both `JoinHandle`s, call `.abort()` on loop exit |
| ClientConfig ignored | Parse from endpoint response, drive `PingInterval` |
| 401/403 fast-retry | Return `FatalError` variant, stop reconnect loop |

#### Phase 4: Implement frame codec helpers

**File:** `crates/openfang-channels/src/feishu.rs` (or `feishu_ws.rs`)

```rust
/// Encode a Frame to binary for sending over the WebSocket.
fn encode_frame(frame: &Frame) -> Vec<u8> {
    let mut buf = Vec::new();
    frame.encode(&mut buf).expect("prost encode");
    buf
}

/// Decode a Frame from a WebSocket binary message.
fn decode_frame(bytes: &[u8]) -> Result<Frame, prost::DecodeError> {
    Frame::decode(bytes)
}

/// Build an ACK frame for the given seq_id and message_id.
fn build_ack(seq_id: u64, message_id: &str) -> Frame {
    Frame {
        seq_id,
        method: 1,
        headers: vec![Header { key: "type".into(), value: "ack".into() }],
        payload: serde_json::json!({"code": 200, "data": message_id})
            .to_string().into_bytes(),
        ..Default::default()
    }
}

/// Build a pong frame in response to a control ping.
fn build_pong(seq_id: u64, ping_interval: u64) -> Frame {
    Frame {
        seq_id,
        method: 0,
        payload: serde_json::json!({"PingInterval": ping_interval})
            .to_string().into_bytes(),
        ..Default::default()
    }
}
```

#### Phase 5: Parse Feishu event payload → `ChannelMessage`

The event payload inside `Frame.payload` is JSON. Feishu event schema:

```json
{
  "schema": "2.0",
  "header": { "event_type": "im.message.receive_v1", ... },
  "event": {
    "message": {
      "message_id": "om_...",
      "message_type": "text",
      "content": "{\"text\":\"hello\"}",
      "chat_id": "oc_...",
      "chat_type": "p2p"
    },
    "sender": { "sender_id": { "open_id": "ou_..." } }
  }
}
```

This schema is the same for both webhook and WebSocket modes — reuse existing `parse_feishu_event()` logic already in `feishu.rs`.

**Key:** Strip the outer `Frame` layer → JSON payload → existing parser. No duplication needed.

#### Phase 6: Message deduplication

Current webhook mode uses `Arc<DedupCache>` on `FeishuAdapter` (ring-buffer, max 1000 entries, `feishu.rs:147`). The WebSocket loop runs in a separate async task and needs access to the same dedup cache.

**Fix:** Pass `Arc<DedupCache>` into `start_websocket_loop()` and into `connect_once()`. No new type needed — reuse the existing struct directly.

#### Phase 7: Wire dual-mode `start()`

**File:** `crates/openfang-channels/src/feishu.rs`

```rust
async fn start(&self, ...) -> Box<dyn Stream<Item = ChannelMessage>> {
    let (tx, rx) = mpsc::channel(256);
    match self.config.connection_mode.as_str() {
        "websocket" => {
            tokio::spawn(start_websocket_loop(
                self.app_id.clone(),
                self.app_secret.clone(),
                self.config.region.clone(),
                tx,
                shutdown_rx,
            ));
        }
        "webhook" | _ => {
            // existing Axum HTTP server logic (unchanged)
            tokio::spawn(start_webhook_server(...));
        }
    }
    Box::pin(ReceiverStream::new(rx))
}
```

## System-Wide Impact

### Interaction Graph

```
FeishuAdapter::start()
    └─ connection_mode == "websocket"
           └─ start_websocket_loop(...)
                  ├─ HTTP reqwest → Feishu WSS endpoint URL
                  ├─ tokio-tungstenite connect_async → WsStream
                  ├─ writer_task (sole sink owner) ← write_tx channel
                  ├─ heartbeat task → write_tx.send(ping_frame)
                  └─ message loop
                         └─ decode Frame → parse_feishu_event()
                                └─ tx.send(ChannelMessage)
                                       └─ openfang-runtime ChannelAdapter stream consumer
```

Nothing in `openfang-runtime` needs to change — it consumes `Box<dyn Stream<Item = ChannelMessage>>` regardless of transport.

### Error Propagation

| Error | Handling |
|-------|----------|
| Endpoint HTTP 401/403 | Fatal: log error, stop reconnect loop, do NOT retry |
| Endpoint HTTP 5xx / network timeout | Retryable: exponential backoff |
| WebSocket `close` frame | Retryable: reconnect immediately (attempt=0), then backoff |
| `prost::DecodeError` on frame | Log + skip, do not ACK |
| `tx.send()` channel closed | Loop owner dropped → stop gracefully |
| `shutdown` signal | Break outer loop, abort heartbeat handle |

### State Lifecycle Risks

- **Heartbeat task leak**: If `connect_once` returns while the heartbeat is sleeping, the task lingers until its next wakeup. **Fix:** `handle.abort()` at start of reconnect cleanup.
- **Dedup cache growth**: `DedupCache` ring-buffer 上限 1000 条，满后自动淘汰最旧的 500 条（`feishu.rs:107`）。内存占用有界，无需额外处理。
- **No duplicate ACK**: If the same message arrives twice before dedup fires, two ACKs are sent. Feishu ignores duplicate ACKs — safe.

### API Surface Parity

No API surface change. `FeishuAdapter` implements `ChannelAdapter` — callers use the stream interface only.

Config surface change: `FeishuConfig` gains `connection_mode` field with `#[serde(default)]`. Existing TOML files without this field default to `"websocket"` — compatible.

### Integration Test Scenarios

1. **Happy path**: Mock Feishu WSS server sends `data` frame with text event → `ChannelMessage` appears on stream with correct `user.id` and `text`.
2. **Ping/pong**: Mock server sends `control` frame with `ping` → verify pong frame sent within 1s.
3. **Reconnect after close**: Mock server closes connection after first message → verify second connection attempt within 5s.
4. **Auth failure (401)**: Endpoint returns `code=401` → verify no reconnect attempt, adapter terminates.
5. **Concurrent writes**: Heartbeat and data frame ACK arrive simultaneously → verify both frames delivered via writer task channel without loss or panic.

## Acceptance Criteria

### Functional Requirements

- [ ] `FeishuConfig` has `connection_mode` field defaulting to `"websocket"`
- [ ] `FeishuAdapter::start()` branches on `connection_mode`: websocket path calls `start_websocket_loop`, webhook path calls existing Axum server
- [ ] `start_websocket_loop` POSTs to correct region endpoint (`open.feishu.cn` for CN, `open.larksuite.com` for INTL)
- [ ] WSS URL and `ClientConfig` are parsed from endpoint response
- [ ] `prost` decodes `pbbp2.Frame` binary frames
- [ ] `method=0` (control / ping) → ACK with pong frame sent back
- [ ] `method=1` (data / event) → payload decoded → `parse_feishu_event()` called → `ChannelMessage` emitted
- [ ] ACK frame sent after every processed data frame
- [ ] Heartbeat task sends ping every `ClientConfig.PingInterval` seconds
- [ ] On WebSocket close/error → reconnect with `backoff(attempt)` (same function as DingTalk)
- [ ] `code != 0` from endpoint with 401/403 → no reconnect, adapter stops
- [ ] Shutdown signal → heartbeat task aborted, connection closed cleanly

### Non-Functional Requirements

- [ ] Zero `cargo clippy` warnings
- [ ] All existing Feishu webhook unit tests continue to pass
- [ ] `cargo test --workspace` passes (1744+ tests)
- [ ] Build time increase < 10s (prost codegen is fast)
- [ ] No `unsafe` code

### Quality Gates

- [ ] New unit tests for `encode_frame` / `decode_frame` round-trip
- [ ] New unit test: `build_ack` produces correct header `type=ack`
- [ ] New unit test: `build_pong` produces correct `method=0`
- [ ] Integration test: mock WS server → verify message received on stream (optional, may skip for MVP)

## Dependencies & Prerequisites

| Dependency | Action | Notes |
|------------|--------|-------|
| `prost = "0.13"` | Add to `openfang-channels/Cargo.toml` | Runtime dep |
| `prost-build = "0.13"` | Add to `openfang-channels/Cargo.toml` build-deps | Build-only |
| `tokio-tungstenite` | Already in `openfang-channels` | No change |
| `futures` | Already in `openfang-channels` | No change |
| `serde_json` | Already in `openfang-channels` | No change |
| Feishu developer console | Manual: enable long-connection event subscription | Out of scope |

## Risk Analysis & Mitigation

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Proto field IDs wrong (reverse-engineered from OpenClaw) | Low | Test against live Feishu endpoint; compare raw bytes with OpenClaw output |
| `prost` codegen increases compile time significantly | Low | prost-build is fast; use `cargo build --timings` to verify |
| Mutex contention on sink (heartbeat + many ACKs) | N/A | **已消除**：writer task 模式，heartbeat + ACK 通过 `mpsc::Sender` 投递，无任何锁 |
| Feishu changes WSS endpoint URL | Low | URL is fetched dynamically per connection; no hardcoding |
| Dedup cache not cleared between reconnects | Medium | Cache is `Arc<DashMap>` — persists across reconnects (correct behavior) |

## Future Considerations

- TTL eviction for `seen_messages` dedup cache (prevents memory growth on long-running deployments)
- Expose `ClientConfig.ReconnectCount` as a hard stop (currently ignored, matching OpenClaw behavior)
- Structured metrics: WebSocket reconnect count, message latency histogram

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-16-feishu-long-connection-brainstorm.md](../brainstorms/2026-03-16-feishu-long-connection-brainstorm.md)
  Key decisions carried forward: (1) `prost` for protobuf decode, (2) dual connection_mode config field with websocket as default, (3) DingTalk Stream `backoff()` function reused verbatim

### Internal References

- `crates/openfang-channels/src/dingtalk_stream.rs` — structural template for WebSocket loop, reconnect, backoff
- `crates/openfang-channels/src/feishu.rs` — existing webhook impl to preserve; `parse_feishu_event()` reused
- `crates/openfang-types/src/config.rs:2381` — `FeishuConfig` struct to extend
- `crates/openfang-channels/Cargo.toml:21` — `tokio-tungstenite` already present

### External References

- [Feishu Long Connection Docs](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)
- [prost crate docs](https://docs.rs/prost/latest/prost/)
- [prost-build docs](https://docs.rs/prost-build/latest/prost_build/)
- OpenClaw SDK source: `~/.nvm/.../openclaw/extensions/feishu/src/` — proto schema reverse-engineered from this

### Related Work

- Previous plan: `docs/plans/2026-03-16-001-feat-user-session-isolation-channel-admin-plan.md`
