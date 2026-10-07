//! The agent-facing WebSocket bridge.
//!
//! One long-lived session per bridge process. Agents connect on loopback, send JSON
//! frames, and the bridge routes them to whatever human-facing surface exists (the Tauri
//! webview, or a headless stdout sink) while streaming the human's answers back.
//!
//! Two design rules run through this file:
//!
//! 1. **A bad agent must never take the bridge down.** Every socket is its own task, every
//!    lock tolerates poisoning, and a failed send only removes that one connection.
//! 2. **Silence is a bug.** Anything the bridge refuses is reported back on the socket with
//!    a specific [`ErrorCode`], because an agent staring at a blank canvas with no error is
//!    the worst possible outcome.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::protocol::{
    is_known_component, validate_props, AckFrame, AckStatus, AgentConnection, AgentFrame,
    AgentIdentity, BridgeStatus, CanvasFrame, ErrorCode, ErrorFrame, EventFrame, EventName,
    PongFrame, ServerInfo, WelcomeFrame, COMPONENT_NAMES, PROTOCOL_VERSION, SERVER_NAME,
    SERVER_VERSION,
};

/// Default pending-queue depth. A queue exists because the bridge can accept tasks before
/// the window has mounted; 32 is enough to cover a burst and small enough to stay honest.
pub const DEFAULT_PENDING_CAPACITY: usize = 32;

/// Frame types an agent is allowed to send. Used to distinguish "unknown frame type" from
/// "known type, broken body" so the error code is precise.
const KNOWN_FRAME_TYPES: [&str; 7] = [
    "hello", "task", "update", "resolve", "notify", "note", "ping",
];

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

pub fn log(msg: impl AsRef<str>) {
    eprintln!("[auraui] {}", msg.as_ref());
}

pub fn warn(msg: impl AsRef<str>) {
    eprintln!("[auraui] warn: {}", msg.as_ref());
}

pub fn log_error(msg: impl AsRef<str>) {
    eprintln!("[auraui] error: {}", msg.as_ref());
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A poisoned lock means some connection task panicked while holding it. The data behind it
/// is a plain map or queue, so recovering it is strictly better than wedging the bridge.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/// The human-facing surface the bridge delivers frames to.
///
/// Implementations decide whether a human can actually see a frame right now. Returning
/// [`Delivery::Queued`] is how "the window is closed" is expressed, and the bridge holds the
/// frame until someone attaches.
pub trait UiSink: Send + Sync + 'static {
    /// Hand a validated agent frame to whatever surface exists.
    fn deliver(&self, frame: &AgentFrame) -> Delivery;

    /// Called whenever the connection set or the queue changes, so the surface can show who
    /// is attached. Default is a no-op, which is right for sinks that have no UI.
    fn status(&self, status: &BridgeStatus) {
        let _ = status;
    }
}

/// Whether a delivered frame reached a human.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// A surface took it; the human can see it now.
    Attached,
    /// Nothing was listening. The bridge queues the frame for the next attach.
    Queued,
}

#[derive(Debug)]
pub enum BridgeError {
    /// The listen socket could not be bound.
    Bind { addr: String, source: std::io::Error },
    /// A non-loopback host was requested without an explicit opt-in.
    NonLoopback { addr: String },
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BridgeError::Bind { addr, source } => {
                write!(f, "could not bind the AuraUI bridge to {addr}: {source}")
            }
            BridgeError::NonLoopback { addr } => write!(
                f,
                "refusing to bind {addr}: the bridge is loopback-only. Set AURAUI_ALLOW_REMOTE=1 \
                 to override deliberately."
            ),
        }
    }
}

impl std::error::Error for BridgeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            BridgeError::Bind { source, .. } => Some(source),
            BridgeError::NonLoopback { .. } => None,
        }
    }
}

/// Where the bridge listens and what it talks to. `addr` accepts `host:port`, and port 0
/// asks the OS for a free port (tests rely on this).
#[derive(Clone)]
pub struct BridgeConfig {
    pub addr: String,
    pub sink: Arc<dyn UiSink>,
    pub pending_capacity: usize,
}

impl BridgeConfig {
    /// Defaults to loopback on 9090, overridable with `AURAUI_HOST` / `AURAUI_PORT`.
    pub fn new(sink: Arc<dyn UiSink>) -> Self {
        Self {
            addr: default_addr(),
            sink,
            pending_capacity: DEFAULT_PENDING_CAPACITY,
        }
    }

    pub fn with_addr(mut self, addr: impl Into<String>) -> Self {
        self.addr = addr.into();
        self
    }

    pub fn with_pending_capacity(mut self, capacity: usize) -> Self {
        // A zero-capacity queue would make `push_pending` spin forever trying to make room.
        self.pending_capacity = capacity.max(1);
        self
    }

    pub fn default_addr() -> String {
        default_addr()
    }
}

/// `host:port` from the environment, defaulting to loopback on 9090.
pub fn default_addr() -> String {
    let host = std::env::var("AURAUI_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("AURAUI_PORT").unwrap_or_else(|_| "9090".to_string());
    format!("{host}:{port}")
}

pub fn default_bridge_url() -> String {
    format!("ws://{}", default_addr())
}

/// Status for a bridge that has not started yet, so the UI can say "starting" rather than
/// render nothing.
pub fn offline_status() -> BridgeStatus {
    BridgeStatus {
        session_id: String::new(),
        bridge_url: default_bridge_url(),
        running: false,
        connections: Vec::new(),
        received: 0,
        emitted: 0,
    }
}

fn split_addr(addr: &str) -> (String, String) {
    match addr.rsplit_once(':') {
        Some((host, port)) => (host.trim_matches(['[', ']']).to_string(), port.to_string()),
        None => (addr.to_string(), "9090".to_string()),
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host,
        "localhost" | "::1" | "0:0:0:0:0:0:0:1" | "ip6-localhost"
    ) || host.starts_with("127.")
}

/* ------------------------------------------------------------------ *
 * Bridge internals
 * ------------------------------------------------------------------ */

/// A connected agent's write half plus its advertised identity.
struct ConnHandle {
    identity: AgentIdentity,
    since: u64,
    tx: mpsc::UnboundedSender<String>,
}

struct Inner {
    session_id: String,
    bridge_url: String,
    sink: Arc<dyn UiSink>,
    conns: Mutex<HashMap<String, ConnHandle>>,
    /// Task ids the human's surface has actually been shown. Drives the ack status of
    /// `update` and `resolve`: you cannot update a card that was never painted.
    known_tasks: Mutex<HashSet<String>>,
    /// Frames accepted while nothing was listening.
    pending: Mutex<VecDeque<AgentFrame>>,
    pending_capacity: usize,
    seq: AtomicU64,
    received: AtomicU64,
    emitted: AtomicU64,
    running: AtomicBool,
    shutdown: Notify,
}

/// Entry point. `Bridge::start` binds, spawns the accept loop and returns a handle that is
/// cheap to clone and safe to share between Tauri commands and background tasks.
pub struct Bridge;

impl Bridge {
    /// Bind and start serving. The returned handle's `addr()` is the *actual* bound address,
    /// which differs from the requested one when the port was 0.
    pub async fn start(config: BridgeConfig) -> Result<BridgeHandle, BridgeError> {
        let (host, _port) = split_addr(&config.addr);
        let allow_remote = std::env::var("AURAUI_ALLOW_REMOTE").ok().as_deref() == Some("1");
        if !is_loopback_host(&host) && !allow_remote {
            return Err(BridgeError::NonLoopback {
                addr: config.addr.clone(),
            });
        }

        let listener =
            TcpListener::bind(&config.addr)
                .await
                .map_err(|source| BridgeError::Bind {
                    addr: config.addr.clone(),
                    source,
                })?;
        let local = listener.local_addr().map_err(|source| BridgeError::Bind {
            addr: config.addr.clone(),
            source,
        })?;
        let bridge_url = format!("ws://{local}");

        let inner = Arc::new(Inner {
            session_id: Uuid::new_v4().to_string(),
            bridge_url: bridge_url.clone(),
            sink: config.sink,
            conns: Mutex::new(HashMap::new()),
            known_tasks: Mutex::new(HashSet::new()),
            pending: Mutex::new(VecDeque::new()),
            pending_capacity: config.pending_capacity.max(1),
            seq: AtomicU64::new(0),
            received: AtomicU64::new(0),
            emitted: AtomicU64::new(0),
            running: AtomicBool::new(true),
            shutdown: Notify::new(),
        });

        let accept_inner = inner.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    // `notify_one` rather than `notify_waiters`: it stores a permit, so a
                    // shutdown that lands between loop iterations is not lost.
                    _ = accept_inner.shutdown.notified() => {
                        log("bridge stopping: listener closed");
                        break;
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, peer)) => {
                                let conn_inner = accept_inner.clone();
                                // One task per socket: a panic here cannot touch the listener
                                // or any other agent.
                                tokio::spawn(async move {
                                    serve_connection(conn_inner, stream, peer).await;
                                });
                            }
                            Err(e) => {
                                // Back off a little: a persistent accept error would otherwise
                                // spin the loop at 100% CPU.
                                warn(format!("accept failed: {e}"));
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                        }
                    }
                }
            }
            accept_inner.running.store(false, Ordering::SeqCst);
        });

        let handle = BridgeHandle { inner };
        log(format!("listening on {bridge_url} (session {})", handle.session_id()));
        handle.notify_status();
        Ok(handle)
    }
}

/// A shareable handle to a running bridge.
#[derive(Clone)]
pub struct BridgeHandle {
    inner: Arc<Inner>,
}

impl BridgeHandle {
    /// The address actually bound, which is what a client should dial.
    pub fn addr(&self) -> SocketAddr {
        // `bridge_url` is only ever built from a bound listener, so the fallback is
        // unreachable in practice; it exists to keep this infallible.
        self.inner
            .bridge_url
            .trim_start_matches("ws://")
            .parse()
            .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 9090)))
    }

    pub fn bridge_url(&self) -> String {
        self.inner.bridge_url.clone()
    }

    pub fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    pub fn connection_count(&self) -> usize {
        lock(&self.inner.conns).len()
    }

    pub fn received(&self) -> u64 {
        self.inner.received.load(Ordering::SeqCst)
    }

    pub fn emitted(&self) -> u64 {
        self.inner.emitted.load(Ordering::SeqCst)
    }

    pub fn status(&self) -> BridgeStatus {
        let connections = {
            let conns = lock(&self.inner.conns);
            let mut list: Vec<AgentConnection> = conns
                .iter()
                .map(|(id, handle)| AgentConnection {
                    id: id.clone(),
                    identity: handle.identity.clone(),
                    since: handle.since,
                })
                .collect();
            // HashMap order is not stable; sort so the UI does not reshuffle on every poll.
            list.sort_by_key(|c| c.since);
            list
        };

        BridgeStatus {
            session_id: self.inner.session_id.clone(),
            bridge_url: self.inner.bridge_url.clone(),
            running: self.inner.running.load(Ordering::SeqCst),
            connections,
            received: self.received(),
            emitted: self.emitted(),
        }
    }

    /// Push the current status to the UI sink. Safe to call from anywhere.
    pub fn notify_status(&self) {
        let status = self.status();
        self.inner.sink.status(&status);
    }

    /// Build, stamp and broadcast an event to every connected agent.
    ///
    /// `seq` comes from one counter per session and `at` from the bridge's clock, so an
    /// agent can trust both without trusting the client that produced the interaction.
    pub fn emit_event(&self, task_id: &str, event: EventName, payload: Value) -> EventFrame {
        let seq = self.inner.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let frame = EventFrame {
            v: PROTOCOL_VERSION.to_string(),
            task_id: task_id.to_string(),
            event,
            payload,
            seq,
            at: now_ms(),
        };
        self.inner.emitted.fetch_add(1, Ordering::SeqCst);
        self.broadcast_canvas(CanvasFrame::Event(frame.clone()));
        frame
    }

    /// Send any frame to every connected agent.
    pub fn broadcast(&self, frame: &CanvasFrame) {
        self.broadcast_canvas(frame.clone());
    }

    /// Hand over everything queued while nothing was listening, and mark those tasks as
    /// known so a later `update` or `resolve` acks correctly.
    ///
    /// Call this when a UI attaches (the Tauri layer does it from `auraui_attach`).
    pub fn drain_pending(&self) -> Vec<AgentFrame> {
        let frames: Vec<AgentFrame> = {
            let mut pending = lock(&self.inner.pending);
            pending.drain(..).collect()
        };

        if !frames.is_empty() {
            let mut known = lock(&self.inner.known_tasks);
            for frame in &frames {
                if let Some(id) = task_id_of(frame) {
                    known.insert(id.to_string());
                }
            }
            log(format!("flushed {} queued frame(s) to the UI", frames.len()));
            drop(known);
            self.notify_status();
        }

        frames
    }

    pub fn pending_len(&self) -> usize {
        lock(&self.inner.pending).len()
    }

    /// Stop accepting connections and drop every agent. Idempotent.
    pub fn shutdown(&self) {
        if self.inner.running.swap(false, Ordering::SeqCst) {
            self.inner.shutdown.notify_one();
            // Dropping the senders ends each connection task, which closes its socket.
            lock(&self.inner.conns).clear();
            log("shutdown requested");
        }
        self.notify_status();
    }

    /* -------------------------- frame handling -------------------------- */

    /// Validate and act on one inbound text frame.
    ///
    /// Deliberately synchronous: the whole path is CPU work plus non-blocking channel sends,
    /// so there is no lock held across an await and no way for a slow UI to stall an agent's
    /// socket beyond the queue depth.
    fn on_text(&self, conn_id: &str, text: &str) {
        let value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                self.send_error(
                    conn_id,
                    ErrorCode::BadJson,
                    format!("Could not parse the frame as JSON: {e}"),
                    None,
                );
                return;
            }
        };

        // Everything borrowed from `value` has to be finished with before the end of this
        // block: the typed parse below moves `value`, so `kind` is copied out as a String.
        let kind: String = {
            let Some(object) = value.as_object() else {
                self.send_error(
                    conn_id,
                    ErrorCode::BadFrame,
                    "A frame must be a JSON object.",
                    None,
                );
                return;
            };

            let Some(kind) = object.get("type").and_then(Value::as_str) else {
                self.send_error(
                    conn_id,
                    ErrorCode::BadFrame,
                    "A frame must have a string `type`.",
                    None,
                );
                return;
            };

            // Check the version before the typed parse: `protocol.rs` defaults a missing
            // `v`, so a mismatched version would otherwise be silently accepted.
            if let Some(v) = object.get("v").and_then(Value::as_str) {
                if v != PROTOCOL_VERSION {
                    warn(format!("agent sent protocol version {v}, expected {PROTOCOL_VERSION}"));
                    let task_id = object.get("taskId").and_then(Value::as_str).map(str::to_string);
                    self.send_error(
                        conn_id,
                        ErrorCode::UnsupportedVersion,
                        format!("This bridge speaks protocol {PROTOCOL_VERSION}, got {v}."),
                        task_id,
                    );
                    return;
                }
            }

            kind.to_string()
        };

        if !KNOWN_FRAME_TYPES.contains(&kind.as_str()) {
            self.send_error(
                conn_id,
                ErrorCode::UnknownType,
                format!(
                    "Unknown frame type {kind:?}. Supported: {}.",
                    KNOWN_FRAME_TYPES.join(", ")
                ),
                None,
            );
            return;
        }

        let frame: AgentFrame = match serde_json::from_value(value) {
            Ok(f) => f,
            Err(e) => {
                self.send_error(
                    conn_id,
                    ErrorCode::BadFrame,
                    format!("Malformed `{kind}` frame: {e}"),
                    None,
                );
                return;
            }
        };

        self.dispatch(conn_id, frame);
    }

    fn dispatch(&self, conn_id: &str, frame: AgentFrame) {
        self.inner.received.fetch_add(1, Ordering::SeqCst);

        // Matched by reference so `frame` stays intact: the queued path needs to clone it
        // whole, and a by-value match would have partially moved it.
        match &frame {
            AgentFrame::Hello(hello) => {
                let updated = {
                    let mut conns = lock(&self.inner.conns);
                    match conns.get_mut(conn_id) {
                        Some(handle) => {
                            handle.identity = hello.agent.clone();
                            true
                        }
                        None => false,
                    }
                };
                if updated {
                    log(format!("agent attached: {}", describe_identity(&hello.agent)));
                    self.notify_status();
                }
            }

            AgentFrame::Task(task) => {
                if !is_known_component(&task.component) {
                    self.send_error(
                        conn_id,
                        ErrorCode::UnknownComponent,
                        format!(
                            "Unknown component {:?}. Supported: {}.",
                            task.component,
                            COMPONENT_NAMES.join(", ")
                        ),
                        Some(task.task_id.clone()),
                    );
                    return;
                }
                if let Err(message) = validate_props(&task.component, &task.props) {
                    self.send_error(conn_id, ErrorCode::BadFrame, message, Some(task.task_id.clone()));
                    return;
                }

                let delivery = self.inner.sink.deliver(&frame);
                match delivery {
                    Delivery::Attached => {
                        lock(&self.inner.known_tasks).insert(task.task_id.clone());
                        self.send_ack(&task.task_id, AckStatus::Rendered);
                    }
                    Delivery::Queued => {
                        let task_id = task.task_id.clone();
                        self.push_pending(frame.clone());
                        self.send_ack(&task_id, ack_status_for(delivery));
                    }
                }
                log(format!(
                    "task {} [{}] -> {delivery:?}",
                    task.task_id, task.component
                ));
            }

            AgentFrame::Update(update) => {
                let known = lock(&self.inner.known_tasks).contains(&update.task_id);
                if !known {
                    // Keep the queue coherent: an update to a task nobody has seen yet must
                    // change what the window eventually shows, not be dropped.
                    merge_pending_update(
                        &self.inner,
                        &update.task_id,
                        update.props.as_ref(),
                        update.instruction.as_deref(),
                    );
                }
                self.inner.sink.deliver(&frame);
                self.send_ack(
                    &update.task_id,
                    if known {
                        AckStatus::Updated
                    } else {
                        AckStatus::Unknown
                    },
                );
            }

            AgentFrame::Resolve(resolve) => {
                let known = lock(&self.inner.known_tasks).remove(&resolve.task_id);
                retract_pending(&self.inner, &resolve.task_id);
                self.inner.sink.deliver(&frame);
                self.send_ack(
                    &resolve.task_id,
                    if known {
                        AckStatus::Resolved
                    } else {
                        AckStatus::Unknown
                    },
                );
            }

            AgentFrame::Notify(notify) => {
                self.inner.sink.deliver(&frame);
                log(format!("notify {:?} {}", notify.level, notify.message));
            }

            AgentFrame::Note(note) => {
                self.inner.sink.deliver(&frame);
                log(format!("note {}", note.text));
            }

            AgentFrame::Ping(_) => {
                self.send_to(
                    conn_id,
                    CanvasFrame::Pong(PongFrame {
                        v: PROTOCOL_VERSION.to_string(),
                    }),
                );
            }
        }
    }

    /// Acks are broadcast to every connected agent, not just the sender: a session is shared
    /// state, and the broadcast keeps all agents' views of what the human has seen in step.
    fn send_ack(&self, task_id: &str, status: AckStatus) {
        self.broadcast_canvas(CanvasFrame::Ack(AckFrame {
            v: PROTOCOL_VERSION.to_string(),
            task_id: task_id.to_string(),
            status,
        }));
    }

    fn send_error(
        &self,
        conn_id: &str,
        code: ErrorCode,
        message: impl Into<String>,
        task_id: Option<String>,
    ) {
        let message: String = message.into();
        warn(format!("{}: {}", code.as_str(), message));
        self.send_to(
            conn_id,
            CanvasFrame::Error(ErrorFrame {
                v: PROTOCOL_VERSION.to_string(),
                code,
                message,
                task_id,
            }),
        );
    }

    fn send_to(&self, conn_id: &str, frame: CanvasFrame) {
        let text = frame.to_json();
        let failed = {
            let conns = lock(&self.inner.conns);
            match conns.get(conn_id) {
                Some(handle) => handle.tx.send(text).is_err(),
                None => false,
            }
        };
        if failed {
            self.remove_conn(conn_id);
        }
    }

    fn broadcast_canvas(&self, frame: CanvasFrame) {
        let text = frame.to_json();
        let dead: Vec<String> = {
            let conns = lock(&self.inner.conns);
            conns
                .iter()
                .filter(|(_, handle)| handle.tx.send(text.clone()).is_err())
                .map(|(id, _)| id.clone())
                .collect()
        };

        if !dead.is_empty() {
            {
                let mut conns = lock(&self.inner.conns);
                for id in &dead {
                    conns.remove(id);
                }
            }
            warn(format!("pruned {} dead connection(s)", dead.len()));
            self.notify_status();
        }
    }

    fn push_pending(&self, frame: AgentFrame) {
        let mut pending = lock(&self.inner.pending);
        // Bounded and drop-oldest: a newer request is almost always more relevant than a
        // stale one, and unbounded growth would be a slow memory leak.
        while !pending.is_empty() && pending.len() >= self.inner.pending_capacity {
            if let Some(dropped) = pending.pop_front() {
                warn(format!(
                    "pending queue full ({}): dropped {}",
                    self.inner.pending_capacity,
                    describe_frame(&dropped)
                ));
            }
        }
        pending.push_back(frame);
    }

    fn add_conn(&self, id: String, tx: mpsc::UnboundedSender<String>) {
        {
            let mut conns = lock(&self.inner.conns);
            conns.insert(
                id,
                ConnHandle {
                    identity: unnamed_identity(),
                    since: now_ms(),
                    tx,
                },
            );
        }
        self.notify_status();
    }

    fn remove_conn(&self, id: &str) {
        let removed = lock(&self.inner.conns).remove(id).is_some();
        if removed {
            self.notify_status();
        }
    }
}

/// The identity shown until an agent says `hello`. A minimal client that never introduces
/// itself still works, it just shows up unnamed.
fn unnamed_identity() -> AgentIdentity {
    AgentIdentity {
        name: "unnamed-agent".to_string(),
        version: None,
        vendor: None,
        capabilities: None,
    }
}

fn describe_identity(identity: &AgentIdentity) -> String {
    let mut s = identity.name.clone();
    if let Some(v) = &identity.version {
        s.push(' ');
        s.push_str(v);
    }
    if let Some(vendor) = &identity.vendor {
        s.push_str(" (");
        s.push_str(vendor);
        s.push(')');
    }
    s
}

/// Acknowledgement status for a delivery outcome.
///
/// NOTE: the brief for this slice asks for a distinct `queued` status, but
/// `protocol::AckStatus` — owned by the coordinator, not this file — has no `Queued`
/// variant. A queued frame therefore acks as `Unknown`, which is the closest thing the
/// contract can express. If `Queued` is added to `protocol.rs` (and `protocol.ts` and
/// `docs/PROTOCOL.md` alongside it), this function is the only place that needs to change.
fn ack_status_for(delivery: Delivery) -> AckStatus {
    match delivery {
        Delivery::Attached => AckStatus::Rendered,
        Delivery::Queued => AckStatus::Queued,
    }
}

fn task_id_of(frame: &AgentFrame) -> Option<&str> {
    match frame {
        AgentFrame::Task(t) => Some(&t.task_id),
        AgentFrame::Update(u) => Some(&u.task_id),
        AgentFrame::Resolve(r) => Some(&r.task_id),
        _ => None,
    }
}

fn describe_frame(frame: &AgentFrame) -> String {
    match frame {
        AgentFrame::Task(t) => format!("task {} [{}]", t.task_id, t.component),
        AgentFrame::Update(u) => format!("update {}", u.task_id),
        AgentFrame::Resolve(r) => format!("resolve {}", r.task_id),
        AgentFrame::Notify(_) => "notify".to_string(),
        AgentFrame::Note(_) => "note".to_string(),
        AgentFrame::Hello(h) => format!("hello {}", h.agent.name),
        AgentFrame::Ping(_) => "ping".to_string(),
    }
}

/// Fold an update into a task still waiting in the queue, so the window shows the latest
/// version rather than a stale one.
fn merge_pending_update(
    inner: &Inner,
    task_id: &str,
    props: Option<&Value>,
    instruction: Option<&str>,
) {
    let mut pending = lock(&inner.pending);
    for frame in pending.iter_mut() {
        if let AgentFrame::Task(task) = frame {
            if task.task_id != task_id {
                continue;
            }
            if let Some(new_props) = props {
                match (task.props.as_object_mut(), new_props.as_object()) {
                    // Shallow merge, matching the webview: a patched `data` array replaces the
                    // old one, which is exactly what a chart drill-down needs.
                    (Some(existing), Some(patch)) => {
                        for (key, value) in patch {
                            existing.insert(key.clone(), value.clone());
                        }
                    }
                    _ => task.props = new_props.clone(),
                }
            }
            if let Some(text) = instruction {
                task.instruction = Some(text.to_string());
            }
            return;
        }
    }
}

/// Drop a resolved task from the queue. A card the agent already withdrew must not appear
/// when the window finally opens.
fn retract_pending(inner: &Inner, task_id: &str) {
    let mut pending = lock(&inner.pending);
    let before = pending.len();
    pending.retain(|frame| task_id_of(frame) != Some(task_id));
    if pending.len() != before {
        log(format!("retracted queued task {task_id}"));
    }
}

/* ------------------------------------------------------------------ *
 * Connection task
 * ------------------------------------------------------------------ */

async fn serve_connection(inner: Arc<Inner>, stream: TcpStream, peer: SocketAddr) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            warn(format!("websocket handshake with {peer} failed: {e}"));
            return;
        }
    };

    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let conn_id = Uuid::new_v4().to_string();
    let handle = BridgeHandle { inner: inner.clone() };

    if !inner.running.load(Ordering::SeqCst) {
        let _ = sink.send(Message::Close(None)).await;
        return;
    }

    // Register before the greeting so nothing broadcast in between is lost; the channel is
    // FIFO, so an early broadcast still arrives after `welcome`.
    handle.add_conn(conn_id.clone(), tx);
    log(format!("agent connected from {peer} ({conn_id})"));

    let welcome = CanvasFrame::Welcome(WelcomeFrame {
        v: PROTOCOL_VERSION.to_string(),
        session_id: inner.session_id.clone(),
        server: ServerInfo {
            name: SERVER_NAME.to_string(),
            version: SERVER_VERSION.to_string(),
            protocol: PROTOCOL_VERSION.to_string(),
            bridge_url: inner.bridge_url.clone(),
        },
    });

    // Sent before any `hello`: a one-line client must not be able to miss the greeting.
    if sink
        .send(Message::Text(welcome.to_json().into()))
        .await
        .is_err()
    {
        handle.remove_conn(&conn_id);
        return;
    }

    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                match outgoing {
                    Some(text) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    // Every sender was dropped: the bridge shut down or pruned us.
                    None => break,
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(message)) => {
                        if message.is_close() {
                            // RFC 6455 requires answering a close frame with one of our own.
                            // tungstenite queues that reply inside its read path, so the
                            // flush is what actually puts it on the wire. Skipping it makes
                            // the peer see an abrupt teardown and report code 1006, which
                            // reads as a failure on what was a clean, intentional shutdown.
                            let _ = sink.flush().await;
                            let _ = sink.close().await;
                            break;
                        }
                        // Control frames are left to the transport. The protocol has its own
                        // `ping`/`pong`, which is what clients actually use for liveness.
                        if message.is_ping() || message.is_pong() {
                            continue;
                        }
                        match message.to_text() {
                            Ok(text) => handle.on_text(&conn_id, text),
                            Err(_) => handle.send_error(
                                &conn_id,
                                ErrorCode::BadJson,
                                "Frames must be UTF-8 text containing one JSON object.",
                                None,
                            ),
                        }
                    }
                    Some(Err(e)) => {
                        warn(format!("connection {conn_id} read error: {e}"));
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    handle.remove_conn(&conn_id);
    log(format!("agent disconnected ({conn_id})"));
}
