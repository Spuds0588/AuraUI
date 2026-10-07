//! End-to-end protocol tests.
//!
//! These drive a real [`Bridge`] over a real TCP socket with a real WebSocket client, so
//! they cover the parts that unit tests on helpers cannot: the greeting, frame validation
//! and error codes, the ack/event ordering an agent actually observes, and the behaviour of
//! the pending queue when no UI is attached.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use auraui_lib::bridge::{Bridge, BridgeConfig, BridgeError, BridgeHandle, Delivery, UiSink};
use auraui_lib::protocol::{AgentFrame, BridgeStatus, EventName};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::Message;

/// What `connect_async` hands back for a `ws://` URL with no TLS features enabled.
type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const EPOCH_MILLIS_FLOOR: u64 = 1_600_000_000_000; // 2020-09-13, comfortably below "now"

/* ------------------------------------------------------------------ *
 * Test sink
 * ------------------------------------------------------------------ */

/// A stand-in for the Tauri webview. Reports the delivery outcome the test wants and keeps
/// the two cases apart: frames a human-facing surface actually took, and frames it was
/// offered while nothing was attached. Conflating those is how a "nobody saw it" bug hides.
struct TestSink {
    /// Delivered and taken: a human could see these.
    frames: Mutex<Vec<AgentFrame>>,
    /// Offered while detached, so held by the bridge instead.
    declined: Mutex<Vec<AgentFrame>>,
    statuses: Mutex<Vec<BridgeStatus>>,
    outcome: Delivery,
    tx: UnboundedSender<AgentFrame>,
    rx: Mutex<Option<UnboundedReceiver<AgentFrame>>>,
}

impl TestSink {
    fn new(outcome: Delivery) -> Self {
        let (tx, rx) = unbounded_channel();
        Self {
            frames: Mutex::new(Vec::new()),
            declined: Mutex::new(Vec::new()),
            statuses: Mutex::new(Vec::new()),
            outcome,
            tx,
            rx: Mutex::new(Some(rx)),
        }
    }

    /// Every frame the surface was asked about but did not take.
    fn declined(&self) -> Vec<AgentFrame> {
        self.declined
            .lock()
            .expect("the sink mutex is not poisoned")
            .clone()
    }

    /// Take the receiver. One call only: it is how the test observes what the sink saw.
    fn subscribe(&self) -> UnboundedReceiver<AgentFrame> {
        self.rx
            .lock()
            .expect("the sink mutex is not poisoned")
            .take()
            .expect("subscribe must be called exactly once")
    }

    /// Only the task frames, which is what "did the human see it" actually means. Updates
    /// and resolves are delivered to the sink even when it is not attached.
    fn task_frames(&self) -> Vec<AgentFrame> {
        self.frames
            .lock()
            .expect("the sink mutex is not poisoned")
            .iter()
            .filter(|frame| matches!(frame, AgentFrame::Task(_)))
            .cloned()
            .collect()
    }

    fn statuses(&self) -> Vec<BridgeStatus> {
        self.statuses
            .lock()
            .expect("the sink mutex is not poisoned")
            .clone()
    }
}

impl UiSink for TestSink {
    fn deliver(&self, frame: &AgentFrame) -> Delivery {
        match self.outcome {
            Delivery::Attached => {
                self.frames
                    .lock()
                    .expect("the sink mutex is not poisoned")
                    .push(frame.clone());
                let _ = self.tx.send(frame.clone());
            }
            Delivery::Queued => self
                .declined
                .lock()
                .expect("the sink mutex is not poisoned")
                .push(frame.clone()),
        }
        self.outcome
    }

    fn status(&self, status: &BridgeStatus) {
        self.statuses
            .lock()
            .expect("the sink mutex is not poisoned")
            .push(status.clone());
    }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async fn start_bridge(sink: Arc<TestSink>) -> BridgeHandle {
    // Port 0 asks the OS for a free port, so tests never collide with a running AuraUI.
    Bridge::start(BridgeConfig::new(sink).with_addr("127.0.0.1:0"))
        .await
        .expect("the bridge should start on an ephemeral loopback port")
}

/// A fresh `Sec-WebSocket-Key` for one connection: 16 bytes, base64 encoded (RFC 6455 §4.1).
///
/// `connect_async` does *not* mint this for you when it is handed a prebuilt `Request`, and
/// the server rejects a handshake without it.
fn websocket_key() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seed = nanos ^ COUNTER.fetch_add(1, Ordering::SeqCst) ^ u64::from(std::process::id());

    let mut bytes = [0u8; 16];
    for (i, slot) in bytes.iter_mut().enumerate() {
        *slot = ((seed >> ((i % 8) * 8)) as u8) ^ (i as u8).wrapping_mul(31);
    }
    base64(&bytes)
}

fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

async fn connect(handle: &BridgeHandle) -> Ws {
    // A bare `Request` rather than a URL string, so the test does not depend on
    // tungstenite's optional `url` feature. Every handshake header has to be set by hand.
    let request = Request::builder()
        .uri(format!("ws://{}/", handle.addr()))
        .header("Host", handle.addr().to_string())
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", websocket_key())
        .body(())
        .expect("building the websocket handshake request");

    let (ws, _response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("the test client should connect to the bridge");
    ws
}

async fn recv_json(ws: &mut Ws) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for a frame from the bridge")
            .expect("the bridge closed the socket")
            .expect("websocket error while reading");

        if message.is_ping() || message.is_pong() {
            continue;
        }
        if message.is_close() {
            panic!("the bridge closed the connection unexpectedly");
        }

        let text = message
            .to_text()
            .expect("the bridge must send UTF-8 text frames");
        return serde_json::from_str(text).expect("every bridge frame must be JSON");
    }
}

async fn send_json(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .expect("sending a frame should succeed");
}

async fn send_raw(ws: &mut Ws, text: &str) {
    ws.send(Message::Text(text.into()))
        .await
        .expect("sending a frame should succeed");
}

async fn next_delivered(rx: &mut UnboundedReceiver<AgentFrame>) -> AgentFrame {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("timed out waiting for the sink to receive a frame")
        .expect("the sink channel closed")
}

/// Poll a condition while yielding to the runtime, so background bridge tasks can progress.
async fn wait_until(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..300 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the system clock is after 1970")
        .as_millis() as u64
}

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

#[tokio::test]
async fn bridge_completes_the_full_protocol_loop() {
    let sink = Arc::new(TestSink::new(Delivery::Attached));
    let mut delivered = sink.subscribe();
    let handle = start_bridge(sink.clone()).await;
    let mut ws = connect(&handle).await;

    // (a) The greeting arrives unprompted, before any `hello`, with the real session id.
    let welcome = recv_json(&mut ws).await;
    assert_eq!(welcome["type"].as_str(), Some("welcome"));
    assert_eq!(welcome["v"].as_str(), Some("1.0"));
    assert_eq!(welcome["server"]["protocol"].as_str(), Some("1.0"));
    assert_eq!(welcome["server"]["name"].as_str(), Some("auraui-bridge"));
    let expected_url = handle.bridge_url();
    assert_eq!(
        welcome["server"]["bridgeUrl"].as_str(),
        Some(expected_url.as_str()),
        "the greeting must advertise the address the client actually reached"
    );
    assert_eq!(welcome["sessionId"].as_str(), Some(handle.session_id()));
    assert!(!handle.session_id().is_empty(), "the session id must not be empty");

    // (b) `hello` attaches an identity, and the UI is told about it.
    send_json(
        &mut ws,
        json!({"type":"hello","agent":{"name":"test-agent","version":"9.9","vendor":"ci"}}),
    )
    .await;

    wait_until("the sink to learn the agent's name", || {
        sink.statuses().iter().any(|status| {
            status
                .connections
                .iter()
                .any(|conn| conn.identity.name == "test-agent")
        })
    })
    .await;

    let status = handle.status();
    assert_eq!(status.connections.len(), 1);
    assert_eq!(status.connections[0].identity.name, "test-agent");
    assert_eq!(status.connections[0].identity.version.as_deref(), Some("9.9"));
    assert_eq!(status.connections[0].identity.vendor.as_deref(), Some("ci"));
    assert!(status.running, "the bridge should report itself as running");

    // (c) Malformed JSON is reported, and the socket is still usable afterwards.
    send_raw(&mut ws, "{\"type\":").await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["type"].as_str(), Some("error"));
    assert_eq!(error["code"].as_str(), Some("bad_json"));
    assert!(
        error["message"].as_str().unwrap_or_default().contains("JSON"),
        "the error should say what went wrong: {error}"
    );

    send_json(&mut ws, json!({"type":"ping"})).await;
    let pong = recv_json(&mut ws).await;
    assert_eq!(pong["type"].as_str(), Some("pong"));

    // A frame with a type the protocol does not define.
    send_json(&mut ws, json!({"type":"teleport"})).await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["code"].as_str(), Some("unknown_type"));

    // A version from the future is reported rather than silently accepted.
    send_json(&mut ws, json!({"v":"99.0","type":"ping"})).await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["code"].as_str(), Some("unsupported_version"));

    // (d) A component the canvas cannot render, with the supported list in the message.
    send_json(
        &mut ws,
        json!({"type":"task","taskId":"t_bad","component":"Hologram","props":{}}),
    )
    .await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["type"].as_str(), Some("error"));
    assert_eq!(error["code"].as_str(), Some("unknown_component"));
    assert_eq!(error["taskId"].as_str(), Some("t_bad"));
    let message = error["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("Hologram"),
        "the error should name the offending component: {message}"
    );
    assert!(
        message.contains("ActionCard"),
        "the error should list what the bridge does support: {message}"
    );
    assert!(
        sink.task_frames().is_empty(),
        "an invalid task must never reach the human's surface"
    );

    // Props that fail validation are refused with the validator's own words.
    send_json(
        &mut ws,
        json!({"type":"task","taskId":"t_props","component":"DataGrid","props":{"columns":[]}}),
    )
    .await;
    let error = recv_json(&mut ws).await;
    assert_eq!(error["code"].as_str(), Some("bad_frame"));
    assert_eq!(error["taskId"].as_str(), Some("t_props"));
    assert!(
        error["message"]
            .as_str()
            .unwrap_or_default()
            .contains("rows"),
        "the error should name the missing key: {error}"
    );

    // (e) A valid task: the ack comes first, then the human's answer.
    send_json(
        &mut ws,
        json!({
            "type": "task",
            "taskId": "t1",
            "component": "ActionCard",
            "instruction": "Ship it?",
            "props": {"options": [
                {"id": "approve", "label": "Approve"},
                {"id": "reject", "label": "Reject"}
            ]}
        }),
    )
    .await;

    let ack = recv_json(&mut ws).await;
    assert_eq!(ack["type"].as_str(), Some("ack"));
    assert_eq!(ack["status"].as_str(), Some("rendered"));
    assert_eq!(ack["taskId"].as_str(), Some("t1"));

    match next_delivered(&mut delivered).await {
        AgentFrame::Task(task) => {
            assert_eq!(task.task_id, "t1");
            assert_eq!(task.component, "ActionCard");
            assert_eq!(task.instruction.as_deref(), Some("Ship it?"));
            assert_eq!(task.props["options"][0]["id"].as_str(), Some("approve"));
        }
        other => panic!("expected a task frame at the sink, got {other:?}"),
    }

    // The "human" clicks Approve.
    let answered = handle.emit_event(
        "t1",
        EventName::Action,
        json!({"actionId":"approve","label":"Approve"}),
    );

    let event = recv_json(&mut ws).await;
    assert_eq!(event["type"].as_str(), Some("event"));
    assert_eq!(event["event"].as_str(), Some("action"));
    assert_eq!(event["taskId"].as_str(), Some("t1"));
    assert_eq!(event["payload"]["actionId"].as_str(), Some("approve"));
    assert_eq!(event["payload"]["label"].as_str(), Some("Approve"));
    assert_eq!(event["seq"].as_u64(), Some(answered.seq));

    // (f) `seq` strictly increases and `at` is epoch millis stamped by the bridge.
    let second = handle.emit_event("t1", EventName::Select, json!({"rowIds":["r1"]}));
    assert!(
        second.seq > answered.seq,
        "seq must increase: {} then {}",
        answered.seq,
        second.seq
    );

    let now = now_ms();
    for frame in [&answered, &second] {
        assert!(
            frame.at >= EPOCH_MILLIS_FLOOR,
            "`at` should be epoch milliseconds, got {}",
            frame.at
        );
        assert!(
            frame.at <= now + 60_000,
            "`at` should be close to now, got {} when now is {now}",
            frame.at
        );
    }

    let second_on_the_wire = recv_json(&mut ws).await;
    assert_eq!(second_on_the_wire["type"].as_str(), Some("event"));
    assert_eq!(second_on_the_wire["seq"].as_u64(), Some(second.seq));
    assert_eq!(second_on_the_wire["event"].as_str(), Some("select"));

    // (g) Resolving a task the human never saw cannot claim to have withdrawn a card.
    send_json(&mut ws, json!({"type":"resolve","taskId":"never-seen"})).await;
    let ack = recv_json(&mut ws).await;
    assert_eq!(ack["type"].as_str(), Some("ack"));
    assert_eq!(ack["taskId"].as_str(), Some("never-seen"));
    assert_eq!(ack["status"].as_str(), Some("unknown"));

    // ...and resolving one the human did see reports `resolved`.
    send_json(
        &mut ws,
        json!({"type":"resolve","taskId":"t1","reason":"handled"}),
    )
    .await;
    let ack = recv_json(&mut ws).await;
    assert_eq!(ack["type"].as_str(), Some("ack"));
    assert_eq!(ack["taskId"].as_str(), Some("t1"));
    assert_eq!(ack["status"].as_str(), Some("resolved"));

    // Counters back up what the socket showed.
    assert!(
        handle.received() >= 7,
        "the bridge should have accepted at least 7 frames, counted {}",
        handle.received()
    );
    assert_eq!(handle.emitted(), 2);

    handle.shutdown();
    assert!(!handle.status().running, "shutdown should stop the bridge");
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

#[tokio::test]
async fn tasks_wait_in_the_queue_while_nothing_is_attached() {
    let sink = Arc::new(TestSink::new(Delivery::Queued));
    let handle = start_bridge(sink.clone()).await;
    let mut ws = connect(&handle).await;
    let _welcome = recv_json(&mut ws).await;

    let task = json!({
        "type": "task",
        "taskId": "q1",
        "component": "ActionCard",
        "props": {"options": [{"id": "a", "label": "A"}]}
    });

    // A queued frame is accepted, held, and honestly acked.
    send_json(&mut ws, task.clone()).await;
    let ack = recv_json(&mut ws).await;
    assert_eq!(ack["type"].as_str(), Some("ack"));
    assert_eq!(ack["taskId"].as_str(), Some("q1"));
    // A held frame must not claim a human saw it. `queued` is the honest status.
    assert_eq!(ack["status"].as_str(), Some("queued"));
    assert_eq!(handle.pending_len(), 1);
    assert!(
        sink.declined()
            .iter()
            .any(|frame| matches!(frame, AgentFrame::Task(task) if task.task_id == "q1")),
        "a queued task must still have been offered to the surface"
    );
    assert!(
        sink.task_frames().is_empty(),
        "nothing should reach the surface while nothing is attached"
    );

    // Withdrawing a task nobody has looked at must also drop it from the queue, so it cannot
    // reappear when the window finally opens.
    send_json(&mut ws, json!({"type":"resolve","taskId":"q1"})).await;
    let ack = recv_json(&mut ws).await;
    assert_eq!(ack["status"].as_str(), Some("unknown"));
    assert_eq!(
        handle.pending_len(),
        0,
        "a withdrawn task must not stay queued"
    );

    // Queue a second task, then update it while it is still waiting: the update is folded
    // into the queued copy rather than dropped.
    send_json(
        &mut ws,
        json!({
            "type": "task",
            "taskId": "q2",
            "component": "ActionCard",
            "props": {"options": [{"id": "a", "label": "A"}]}
        }),
    )
    .await;
    let _ack = recv_json(&mut ws).await;
    assert_eq!(handle.pending_len(), 1);

    send_json(
        &mut ws,
        json!({
            "type": "update",
            "taskId": "q2",
            "instruction": "now with B",
            "props": {"options": [{"id": "b", "label": "B"}]}
        }),
    )
    .await;
    let ack = recv_json(&mut ws).await;
    assert_eq!(
        ack["status"].as_str(),
        Some("unknown"),
        "an update to a task no UI has seen is not `updated`"
    );
    assert_eq!(
        handle.pending_len(),
        1,
        "the update must replace the queued frame, not add another"
    );

    // Attaching flushes the queue and makes the task known from then on.
    let drained = handle.drain_pending();
    assert_eq!(drained.len(), 1, "exactly the one queued frame");
    match &drained[0] {
        AgentFrame::Task(task) => {
            assert_eq!(task.task_id, "q2");
            assert_eq!(task.instruction.as_deref(), Some("now with B"));
            assert_eq!(
                task.props["options"][0]["id"].as_str(),
                Some("b"),
                "the update should be merged into the queued props"
            );
        }
        other => panic!("expected the queued task frame, got {other:?}"),
    }
    assert_eq!(handle.pending_len(), 0);

    // Now that a human has been shown it, resolve reports `resolved`.
    send_json(&mut ws, json!({"type":"resolve","taskId":"q2"})).await;
    let ack = recv_json(&mut ws).await;
    assert_eq!(ack["status"].as_str(), Some("resolved"));

    handle.shutdown();
}

/* ------------------------------------------------------------------ *
 * Loopback only
 * ------------------------------------------------------------------ */

#[tokio::test]
async fn the_bridge_refuses_to_listen_off_loopback() {
    let sink = Arc::new(TestSink::new(Delivery::Attached));
    let result = Bridge::start(BridgeConfig::new(sink).with_addr("0.0.0.0:0")).await;
    assert!(
        matches!(&result, Err(BridgeError::NonLoopback { .. })),
        "binding a public interface must be refused without an explicit opt-in"
    );
}
