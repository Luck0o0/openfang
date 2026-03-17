---
title: "Feishu WebSocket Long-Connection (pbbp2 Protocol)"
category: integration-issues
date: 2026-03-17
tags: [feishu, websocket, protobuf, pbbp2, channels, rust, tokio]
status: solved
---

# Feishu WebSocket Long-Connection (pbbp2 Protocol)

## Problem

Feishu's (Lark's) "Long Connection" mode requires a persistent WebSocket connection to
`wss://msg-frontier.feishu.cn/ws/v2` using a binary protobuf frame protocol (`pbbp2`).
The existing openfang Feishu adapter only supported webhook mode (HTTP callbacks), which
requires a publicly accessible server. Many developers run locally or behind NAT and
cannot receive webhooks.

**Symptom:** No way to receive Feishu messages when developing locally or in environments
without a public IP.

## Root Cause

The WebSocket long-connection API uses a custom binary frame format (`pbbp2.Frame` protobuf)
rather than JSON or standard WebSocket text frames. Without prost + a proto file, decoding
or encoding these frames is impossible.

Additionally, the connection setup requires:
1. A two-step auth: REST call to `/callback/ws/endpoint` → get WSS URL with token
2. Sending control frames (ping/pong) for heartbeat on a 60-second cadence
3. Sending ACK for every data frame (`method=1, type=ack`)
4. Deduplicating events by `message_id` header AND `header.event_id` inside payload

## Solution

### Step 1: Add prost + proto codegen

```toml
# crates/openfang-channels/Cargo.toml
[dependencies]
prost = "0.13"

[build-dependencies]
prost-build = "0.13"
```

```proto
// proto/feishu_frame.proto
syntax = "proto3";
package pbbp2;

message Frame {
  uint64 seq_id         = 1;
  uint64 log_id         = 2;
  uint64 service        = 3;
  uint32 method         = 4;  // 0=control (ping/pong), 1=data (event)
  repeated Header headers = 5;
  string payload_encoding = 6;
  string payload_type     = 7;
  bytes  payload          = 8;
  string log_id_new       = 9;
}
message Header { string key = 1; string value = 2; }
```

```rust
// build.rs
fn main() {
    prost_build::compile_protos(&["proto/feishu_frame.proto"], &["proto/"])
        .expect("prost codegen failed");
}
```

```rust
// src/feishu_proto.rs
// Auto-generated Feishu pbbp2 protobuf types.
include!(concat!(env!("OUT_DIR"), "/pbbp2.rs"));
```

⚠️ **Requires system `protoc` binary**: `brew install protobuf` (macOS)

### Step 2: Config field for connection mode

```rust
// openfang-types/src/config.rs
pub struct FeishuConfig {
    // ... existing fields ...
    #[serde(default = "feishu_default_connection_mode")]
    pub connection_mode: String,  // "websocket" | "webhook"
}

fn feishu_default_connection_mode() -> String { "websocket".to_string() }
```

### Step 3: Writer task pattern (zero-lock)

**Do NOT use `Arc<Mutex<SplitSink>>`** — it causes contention when heartbeat + ACK try
to write concurrently.

Instead, give the sink to a dedicated writer task and use `mpsc::Sender<WsMessage>`:

```rust
let (write_tx, write_rx) = mpsc::channel::<WsMessage>(256);

// Writer task — sole owner of sink
tokio::spawn(async move {
    while let Some(msg) = write_rx.recv().await {
        if sink.send(msg).await.is_err() { break; }
    }
    let _ = sink.close().await;
});

// Heartbeat task — writes via mpsc, never touches sink directly
tokio::spawn(async move {
    let mut ticker = tokio::time::interval(ping_interval);
    ticker.tick().await; // skip first tick
    loop {
        ticker.tick().await;
        if write_tx.send(WsMessage::Binary(build_ping())).await.is_err() { break; }
    }
});
```

### Step 4: Frame dispatch (handle_ws_frame)

```rust
match frame.method {
    0 => {
        // Control frame — reply pong immediately
        let _ = write_tx.send(WsMessage::Binary(build_pong(frame.seq_id))).await;
    }
    1 => {
        let message_id = /* extract from headers */;

        // Deduplicate by message_id header
        if !message_id.is_empty() && message_dedup.check_and_insert(&message_id) {
            return;  // already seen
        }

        // Parse event JSON from payload
        let event: serde_json::Value = serde_json::from_str(payload_str)?;

        // Deduplicate by event_id inside payload
        let event_id = event["header"]["event_id"].as_str().unwrap_or("");
        if !event_id.is_empty() && event_dedup.check_and_insert(event_id) {
            return;
        }

        // Dispatch to bridge
        if let Some(msg) = parse_event(&event, bot_names, channel_name) {
            let _ = tx.send(msg).await;
        }

        // ACK every data frame — required or server will retry
        let ack = build_ack(frame.seq_id, &message_id);
        let _ = write_tx.send(WsMessage::Binary(ack)).await;
    }
    _ => {}
}
```

### Step 5: clippy too_many_arguments fix

Group WS loop parameters into a struct to satisfy clippy's 7-argument limit:

```rust
struct WsLoopArgs {
    app_id: String,
    access_token: String,
    channel_name: String,
    bot_names: Vec<String>,
    tx: mpsc::Sender<ChannelMessage>,
    shutdown_rx: tokio::sync::watch::Receiver<bool>,
    ping_interval: Duration,
    backoff_base: Duration,
    max_backoff: Duration,
}
```

### Step 6: Log observability

Without info-level logs, it's impossible to verify message flow. Add logs at every
key stage in `handle_ws_frame`:

```rust
info!("Feishu WS: data frame seq={} type={} msg_id={}", ...);
info!("Feishu WS: dispatching event to agent bridge");
info!("Feishu WS: sending ACK for seq={}", frame.seq_id);
```

## Verification

End-to-end log trace proving full pipeline works:

```
✅ Feishu adapter authenticated as openclaw-bot
✅ Feishu WS: connecting to wss://msg-frontier.feishu.cn/ws/v2?...
✅ Feishu WS: connected
✅ Feishu WS: data frame seq=631741934 type=event msg_id=028f9ddf-...
✅ Feishu WS: dispatching event to agent bridge
✅ Feishu WS: sending ACK for seq=631741934
✅ Tools selected for LLM request (9 tools)
✅ Agent loop completed iterations=2 tokens=10470
✅ (no "Failed to send response" error = reply sent successfully)
```

Total latency: **~6 seconds** (LLM call dominates; WS frame handling < 1ms).

## Known Non-Critical Issues

### 1. Canonical session ON CONFLICT
```
WARN: Failed to update canonical session: Memory error: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint
```
From the `user-session-isolation` feature. Occurs AFTER the reply is sent. Non-blocking.

### 2. Agent heartbeat false positive
After completing an LLM call, the agent's internal state sometimes remains `Running`
instead of transitioning to `Idle`. The 180s heartbeat timeout then marks it as crashed.
Auto-recovery (attempt 1/3) resolves it in ~30s. Self-healing, but noisy in logs.

## Prevention / Checklist

For any future channel adapter implementing a WebSocket long-connection:

- [ ] Install `protoc` system binary before `cargo build`
- [ ] Use `mpsc::Sender` writer task, not `Arc<Mutex<SplitSink>>`
- [ ] Set channel buffer ≥ 256 (not 128)
- [ ] ACK every `method=1` frame — omitting ACK causes server retries
- [ ] Deduplicate by both `message_id` header AND `header.event_id` payload field
- [ ] Use `WsLoopArgs` struct if function has >7 parameters (clippy lint)
- [ ] Add info-level logs at: frame received, dispatched, ACK sent
- [ ] Keep `parse_event()` reused from webhook path — same V2 event schema

## Files Changed

| File | Change |
|------|--------|
| `crates/openfang-channels/Cargo.toml` | Added `prost = "0.13"`, `prost-build = "0.13"` |
| `crates/openfang-channels/build.rs` | New — prost codegen |
| `crates/openfang-channels/proto/feishu_frame.proto` | New — pbbp2.Frame schema |
| `crates/openfang-channels/src/feishu_proto.rs` | New — include generated code |
| `crates/openfang-channels/src/feishu.rs` | Added WS loop, writer/heartbeat tasks, frame codec |
| `crates/openfang-types/src/config.rs` | Added `connection_mode` field to `FeishuConfig` |
| `crates/openfang-api/src/channel_bridge.rs` | Pass `connection_mode` to `with_config()` |

## References

- Plan: `docs/plans/2026-03-16-002-feat-feishu-websocket-long-connection-plan.md`
- Feishu WS SDK reference: https://open.feishu.cn/document/server-docs/im-v1/message/websocket
- prost crate: https://crates.io/crates/prost
