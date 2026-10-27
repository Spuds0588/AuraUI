//! AuraUI wire protocol, version 1 — the Rust half of the contract.
//!
//! Mirrors `src/lib/protocol.ts`. `docs/PROTOCOL.md` is the prose version and is what
//! agent authors read; change all three together or not at all.
//!
//! The bridge is a router, not a renderer: component *props* travel through as
//! [`serde_json::Value`] because the webview owns their rendering. What the bridge does
//! enforce is the envelope and the shape of each component's required keys, so a
//! malformed task is rejected with a specific error code instead of painting nothing.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: &str = "1.0";
pub const SERVER_NAME: &str = "auraui-bridge";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

fn protocol_version() -> String {
    PROTOCOL_VERSION.to_string()
}

/* ------------------------------------------------------------------ *
 * Agent -> canvas
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentIdentity {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HelloFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    pub agent: AgentIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub component: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    pub props: Value,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub urgent: bool,
    /// Set when this question was asked as part of one `run`.
    ///
    /// A run is not a component and not a card: it is a *request* that carried several
    /// questions. The bridge expands it here, so everything downstream — acks, events,
    /// retention, the queue — treats each question exactly like a lone one. The only thing
    /// this adds is enough context for the human to see that they are in the middle of a set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<RunSlot>,
}

/// Where one question sits inside the run that asked it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunSlot {
    #[serde(rename = "runId")]
    pub run_id: String,
    /// Zero-based.
    pub index: usize,
    pub total: usize,
    /// The run's own sentence, repeated on every card of the run: somebody who sits down at
    /// question three still has to know what the set of questions is for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
}

/// One question inside a `run`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunQuestion {
    /// Becomes this question's task id, so acks, events, `progress` and retained answers all
    /// key off it exactly as they do for a lone task.
    pub id: String,
    pub component: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    pub props: Value,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub urgent: bool,
}

/// Several questions asked in one call.
///
/// This exists because of how agents actually behave: an agent with four independent things
/// to ask will fan them out as four calls, and the human then works through four cards that
/// nothing ties together. A run makes that same fan-out one request with one result, while
/// keeping the thing this canvas is built on — one card, one question, one press.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    pub questions: Vec<RunQuestion>,
}

/// How many questions one run may carry.
///
/// A run longer than this is not a set of questions, it is a form the human did not agree to
/// fill in. The cap is deliberately low enough to keep the run's shape visible on screen.
pub const RUN_LIMIT: usize = 12;

/// A run the bridge refused, and which question it refused.
#[derive(Debug, Clone, PartialEq)]
pub struct RunError {
    /// The offending question's id, when the fault is one question's rather than the run's.
    /// Travels as the error frame's `taskId`, so an agent can blame the right question.
    pub question_id: Option<String>,
    pub message: String,
}

/// Check a run and turn it into the questions the rest of the bridge already understands.
///
/// One function rather than two so a question cannot be validated by one path and delivered
/// by another: what passes here is exactly what goes on screen. Order is preserved, because
/// the canvas answers first asked first answered and a run is asked in the order it was
/// written.
pub fn expand_run(frame: &RunFrame) -> Result<Vec<TaskFrame>, RunError> {
    let refuse = |question_id: Option<&str>, message: String| RunError {
        question_id: question_id.map(str::to_string),
        message,
    };

    let run_id = frame.run_id.trim();
    if run_id.is_empty() {
        return Err(refuse(None, "`runId` must be a non-empty string.".into()));
    }
    if frame.questions.is_empty() {
        return Err(refuse(None, "`questions` is empty: there is nothing to ask.".into()));
    }
    if frame.questions.len() > RUN_LIMIT {
        return Err(refuse(
            None,
            format!(
                "`questions` carries {} questions; a run asks at most {RUN_LIMIT}. Split it, or \
                 use a WizardForm when the questions are fields of one thing.",
                frame.questions.len()
            ),
        ));
    }

    let total = frame.questions.len();
    let mut seen: Vec<&str> = Vec::with_capacity(total);
    let mut tasks = Vec::with_capacity(total);

    for (index, question) in frame.questions.iter().enumerate() {
        let id = question.id.trim();
        if id.is_empty() {
            return Err(refuse(None, format!("`questions[{index}].id` must be non-empty.")));
        }
        if seen.contains(&id) {
            return Err(refuse(
                Some(id),
                format!("`questions[{index}].id` repeats {id:?}; every question in a run needs its own id, because the id is the task id its answer comes back on."),
            ));
        }
        seen.push(id);

        if !is_known_component(&question.component) {
            return Err(refuse(
                Some(id),
                format!(
                    "Unknown component {:?} on question {id:?}. Supported: {}.",
                    question.component,
                    COMPONENT_NAMES.join(", ")
                ),
            ));
        }
        if let Err(message) = validate_props(&question.component, &question.props) {
            return Err(refuse(Some(id), message));
        }

        tasks.push(TaskFrame {
            // Stamped by the bridge, like every other outbound `v`: the questions in a run do
            // not each carry their own version, because the run was accepted as one frame.
            v: PROTOCOL_VERSION.to_string(),
            task_id: id.to_string(),
            component: question.component.clone(),
            instruction: question.instruction.clone(),
            props: question.props.clone(),
            urgent: question.urgent,
            run: Some(RunSlot {
                run_id: run_id.to_string(),
                index,
                total,
                instruction: frame.instruction.clone(),
            }),
        });
    }

    Ok(tasks)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UpdateFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub props: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolveFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    Thinking,
    Progress,
    Result,
    Meta,
}

impl Default for NoteKind {
    fn default() -> Self {
        NoteKind::Meta
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    pub text: String,
    #[serde(default)]
    pub kind: NoteKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PingFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
}

/// Any frame an agent may send. Tagged on `type` so unknown frames fail loudly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentFrame {
    Hello(HelloFrame),
    Task(TaskFrame),
    Update(UpdateFrame),
    Resolve(ResolveFrame),
    Note(NoteFrame),
    Ping(PingFrame),
    Answers(AnswersRequest),
    Run(RunFrame),
}

/* ------------------------------------------------------------------ *
 * Canvas -> agent
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    pub protocol: String,
    #[serde(rename = "bridgeUrl")]
    pub bridge_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WelcomeFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub server: ServerInfo,
}

/// What an agent should expect while a question is in front of a person.
///
/// AuraUI's guarantee is weaker than a tool call's and it is better to say so: nothing here
/// times a question out, and the human is under no obligation to answer inside this window.
/// `estimate_ms` is the point at which a wait stops being routine — past it an agent that is
/// narrating progress should say it is still blocked rather than going quiet. `expires_at` is
/// that same point on the clock, so an agent that reschedules can compare it later without
/// having subtracted anything.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaitPlan {
    #[serde(rename = "estimatedMs")]
    pub estimated_ms: u64,
    #[serde(rename = "pollIntervalMs")]
    pub poll_interval_ms: u64,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

/// What a wait costs when nobody has said how long it takes.
///
/// Overridable with `AURAUI_WAIT_ESTIMATE_MS`, because "a person answers in about a minute and
/// a half" is a claim about people, not about this protocol.
pub const DEFAULT_WAIT_ESTIMATE_MS: u64 = 90_000;
/// How often the canvas checks in while a question is unanswered. Mirrored in
/// `src/lib/protocol.ts`, which is what actually sends them.
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 5_000;
/// How many answered questions the bridge keeps for an agent that was not listening.
pub const RETAINED_ANSWER_LIMIT: usize = 64;
/// How long a kept answer stays available. Long enough for a whole turn of an agent that
/// stopped waiting, a page refresh, or a bridge restart; short enough that a long-running
/// session does not accumulate somebody's whole afternoon.
pub const RETAINED_ANSWER_TTL_MS: u64 = 600_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AckStatus {
    /// A human-facing surface took the frame and is showing it.
    Rendered,
    /// Nothing is listening right now; the frame is held for the next window.
    Queued,
    /// `update` applied to a known task.
    Updated,
    /// `resolve` withdrew a known task.
    Resolved,
    /// The taskId is not on the canvas.
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AckFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub status: AckStatus,
    /// Present on the ack to a `task`: the confirmation half of asking a person anything.
    ///
    /// "Your question is up, expect roughly this long, and here is how often you will hear
    /// from me in the meantime." Absent on `update` and `resolve` acks, which are not waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<WaitPlan>,
}

/// Every name a component can report back. Kept as an enum so the bridge cannot forward
/// an event name the documented protocol does not define.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EventName {
    Ready,
    Action,
    Submit,
    Select,
    Filter,
    Change,
    Sort,
    Cancel,
    Error,
}

impl EventName {
    pub fn as_str(self) -> &'static str {
        match self {
            EventName::Ready => "ready",
            EventName::Action => "action",
            EventName::Submit => "submit",
            EventName::Select => "select",
            EventName::Filter => "filter",
            EventName::Change => "change",
            EventName::Sort => "sort",
            EventName::Cancel => "cancel",
            EventName::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub event: EventName,
    /// Untyped on purpose, and the one place this mirror is deliberately incomplete.
    ///
    /// The event name is the contract the bridge enforces; the payload is a superset whose
    /// keys depend on the component that produced it (`values`, `order`, `rowIds`,
    /// `value`/`label`, `decisions`/`accepted`/`rejected`, `audio`), and the canvas owns that
    /// shape. Re-declaring it here would mean three places to keep in step for no validation
    /// the bridge could actually perform, so `src/lib/protocol.ts` and `docs/PROTOCOL.md`
    /// carry it and this stays a passthrough.
    pub payload: Value,
    pub seq: u64,
    /// Unix epoch milliseconds, stamped by the bridge rather than trusted from the webview.
    pub at: u64,
}

impl EventName {
    /// True when this event finishes the question it belongs to.
    ///
    /// Mirrors `TERMINAL_EVENTS` in `src/lib/canvasStore.ts`: `ready`, `select`, `change` and
    /// `sort` describe a question still being answered, so they are signals rather than
    /// answers and never close a task on the bridge's side either.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            EventName::Action | EventName::Submit | EventName::Filter | EventName::Cancel
        )
    }
}

/// How far along a question is, from the canvas's point of view.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WaitState {
    /// The card is up and nobody has touched it.
    Waiting,
    /// The human has started: they picked something, typed into a field, moved a slider.
    Answering,
}

/// One non-terminal thing the human has done on a card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Signal {
    pub event: EventName,
    pub payload: Value,
    pub at: u64,
}

/// A check-in on a question nobody has answered yet.
///
/// This is the piece that keeps a waiting agent out of trouble. A tool call that blocks on a
/// person has to decide what to do with a minute of silence, and the honest answer is nothing
/// useful: the difference between "she is reading it" and "nobody is at the desk" is not
/// visible from the outside. So the canvas says which one it is, on a timer, with the partial
/// answer attached — a form half filled in, a row highlighted, a hunk already decided.
///
/// `remaining_ms` saturates at zero rather than going negative: past the estimate the frame
/// keeps arriving, saying only that the wait is longer than expected.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProgressFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub state: WaitState,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    #[serde(rename = "estimatedMs")]
    pub estimated_ms: u64,
    #[serde(rename = "remainingMs")]
    pub remaining_ms: u64,
    /// Everything non-terminal the human has done on this card, newest first. Omitted when
    /// they have only looked at it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub signals: Vec<Signal>,
    pub at: u64,
}

/// An agent asking what was answered while it was not listening.
///
/// The one question a blocking call cannot answer for itself: a tool call that gave up, or an
/// agent that was restarted mid-question, has no way to learn what the human eventually said.
/// This is that way. The bridge keeps terminal events for a while, so asking again is enough —
/// no second card, and no asking the person to type the same thing twice.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnswersRequest {
    #[serde(default = "protocol_version")]
    pub v: String,
    /// Only these tasks. Omitted asks for everything the bridge still holds.
    #[serde(rename = "taskIds", default, skip_serializing_if = "Option::is_none")]
    pub task_ids: Option<Vec<String>>,
}

/// One answer, as it was sent when it happened.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetainedAnswer {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub event: EventName,
    pub payload: Value,
    /// The same `seq` the live event carried, so a replayed answer and a seen one are the same
    /// event and an agent can tell it has already handled it.
    pub seq: u64,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnswersFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    pub items: Vec<RetainedAnswer>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadJson,
    BadFrame,
    UnsupportedVersion,
    UnknownComponent,
    UnknownTask,
    UnknownType,
}

impl ErrorCode {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::BadJson => "bad_json",
            ErrorCode::BadFrame => "bad_frame",
            ErrorCode::UnsupportedVersion => "unsupported_version",
            ErrorCode::UnknownComponent => "unknown_component",
            ErrorCode::UnknownTask => "unknown_task",
            ErrorCode::UnknownType => "unknown_type",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ErrorFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    pub code: ErrorCode,
    pub message: String,
    #[serde(rename = "taskId", default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PongFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CanvasFrame {
    Welcome(WelcomeFrame),
    Ack(AckFrame),
    Event(EventFrame),
    Progress(ProgressFrame),
    /// The reply to `answers`: what the human said while the agent was not waiting.
    Answers(AnswersFrame),
    Error(ErrorFrame),
    Pong(PongFrame),
}

impl CanvasFrame {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|e| {
            json!({
                "v": PROTOCOL_VERSION,
                "type": "error",
                "code": "bad_frame",
                "message": format!("failed to serialize frame: {e}"),
            })
            .to_string()
        })
    }
}

/* ------------------------------------------------------------------ *
 * Component validation
 * ------------------------------------------------------------------ */

/// The component kinds v1 knows how to render. Mirrors `COMPONENT_NAMES` in protocol.ts and
/// the list quoted in `docs/PROTOCOL.md`. The order is the order an agent sees in the
/// `unknown_component` message, so all three have to agree on it.
pub const COMPONENT_NAMES: [&str; 13] = [
    "ActionCard",
    "Notice",
    "WizardForm",
    "SortableList",
    "DataGrid",
    "InteractiveChart",
    "RatingScale",
    "DiffReview",
    "RegionMark",
    "PairMatrix",
    "AllocateBudget",
    "WebTask",
    "ESign",
];

pub fn is_known_component(name: &str) -> bool {
    COMPONENT_NAMES.contains(&name)
}

/// The field kinds a `WizardForm` step may ask for. Mirrors `FieldType` in protocol.ts and
/// `_FIELD_TYPES` in the Python client.
///
/// There is deliberately no checkbox, radio button or dropdown: choosing is always a button
/// in AuraUI, so `choice` and `multi` are the entire vocabulary for it.
pub const FIELD_TYPES: [&str; 6] = ["text", "textarea", "number", "date", "choice", "multi"];

/// Required keys per component. Optional keys are documented in `docs/PROTOCOL.md` and are
/// the webview's problem: an absent `pageSize` has a sane default, an absent `rows` does not.
fn required_keys(component: &str) -> &'static [(&'static str, &'static str)] {
    match component {
        "ActionCard" => &[("options", "array")],
        "Notice" => &[("level", "string")],
        "WizardForm" => &[("steps", "array")],
        "SortableList" => &[("items", "array")],
        "DataGrid" => &[("columns", "array"), ("rows", "array")],
        "InteractiveChart" => &[("vegaSchema", "object"), ("data", "array")],
        "RatingScale" => &[("max", "number")],
        "DiffReview" => &[("hunks", "array")],
        "RegionMark" => &[("src", "string")],
        "PairMatrix" => &[("rows", "array"), ("options", "array")],
        "AllocateBudget" => &[("items", "array"), ("total", "number")],
        "WebTask" => &[("items", "array")],
        // `ESign` has two required keys depending on which mode it is in — a provider URL or a
        // document — so the one-of rule lives in `validate_esign` rather than in a table that
        // can only say "this key must exist".
        "ESign" => &[],
        _ => &[],
    }
}

/// Check a task's props against the component's required keys.
///
/// Returns a message naming the offending key, so the agent gets something actionable
/// back on the socket instead of an empty canvas.
pub fn validate_props(component: &str, props: &Value) -> Result<(), String> {
    let obj = props
        .as_object()
        .ok_or_else(|| "`props` must be a JSON object.".to_string())?;

    for (key, kind) in required_keys(component) {
        match obj.get(*key) {
            None => {
                return Err(format!("`props.{key}` is required for {component} (expected {kind})."))
            }
            Some(Value::Null) => {
                return Err(format!("`props.{key}` is null, expected {kind}."))
            }
            Some(v) => {
                let ok = match *kind {
                    "array" => v.is_array(),
                    "object" => v.is_object(),
                    "string" => v.is_string(),
                    _ => true,
                };
                if !ok {
                    return Err(format!(
                        "`props.{key}` must be {kind}, got {}.",
                        json_kind(v)
                    ));
                }
            }
        }
    }

    // Component-specific minimums worth catching early: an empty option list or an empty
    // wizard renders a dead end the human cannot answer.
    if component == "ActionCard" {
        if let Some(opts) = obj.get("options").and_then(Value::as_array) {
            if opts.is_empty() {
                return Err("`props.options` is empty: the human would have nothing to click.".into());
            }
        }
    }
    if component == "WizardForm" {
        if let Some(steps) = obj.get("steps") {
            if let Some(items) = steps.as_array() {
                if items.is_empty() {
                    return Err("`props.steps` is empty: the form would have no fields.".into());
                }
            }
            validate_wizard_fields(steps)?;
        }
    }
    if component == "InteractiveChart" {
        if let Some(schema) = obj.get("vegaSchema") {
            validate_chart_spec(schema)?;
        }
    }
    if component == "RatingScale" {
        validate_rating_scale(props)?;
    }
    if component == "DiffReview" {
        validate_diff_review(props)?;
    }
    if component == "RegionMark" {
        validate_region_mark(props)?;
    }
    if component == "PairMatrix" {
        validate_pair_matrix(props)?;
    }
    if component == "AllocateBudget" {
        validate_allocation(props)?;
    }
    if component == "WebTask" {
        validate_web_task(props)?;
    }
    if component == "ESign" {
        validate_esign(props)?;
    }

    Ok(())
}

/* ------------------------------------------------------------------ *
 * Delegated web tasks
 * ------------------------------------------------------------------ */

/// How many items one `WebTask` may carry.
///
/// A list longer than this is not a day's work, it is a spreadsheet, and the card stops being
/// something a person can see the end of. An agent with more to hand over should send a second
/// card once the first is done, which also gives the human a place to stop.
pub const WEBTASK_ITEM_LIMIT: usize = 32;

/// The two ways a delegated task can be opened.
pub const WEBTASK_OPEN_IN: [&str; 2] = ["embedded", "browser"];

/// Caps on the session an agent may hand over.
///
/// These are not about performance. A session payload is a set of live credentials, and the
/// thing this component makes easy is handing a real login to an embedded browser; a payload
/// asking for thousands of cookies is not a session, it is a jar to be scraped, and it is
/// refused before a window exists.
pub const WEBTASK_SESSION_ORIGIN_LIMIT: usize = 32;
pub const WEBTASK_SESSION_COOKIE_LIMIT: usize = 200;
pub const WEBTASK_SESSION_STORAGE_LIMIT: usize = 200;
pub const WEBTASK_SESSION_BYTES_LIMIT: usize = 256 * 1024;

/// The kinds of field an `ESign` document may ask the human to fill.
pub const ESIGN_FIELD_KINDS: [&str; 5] = ["text", "date", "initials", "signature", "checkbox"];

/// How many fields one signature request may place, and how far into a document it may point.
pub const ESIGN_FIELD_LIMIT: usize = 64;
pub const ESIGN_PAGE_LIMIT: usize = 200;

/// How large a document may be, in bytes.
///
/// The frame cap is 16 MiB and base64 inflates by a third, so a document the canvas fills and
/// returns has to start well under half of it. A larger document is not carried as bytes: the
/// agent sends a link instead, and the human signs it where it lives.
pub const ESIGN_DOCUMENT_BYTES_LIMIT: usize = 8 * 1024 * 1024;

/// The host part of a URL, with userinfo, port and IPv6 brackets taken off.
fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    if let Some(bracketed) = authority.strip_prefix('[') {
        return bracketed.split(']').next().unwrap_or("");
    }
    authority.split(':').next().unwrap_or("")
}

pub fn is_loopback_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "localhost" || host == "::1" || host.ends_with(".localhost") || host.starts_with("127.")
}

/// Check an address an agent wants a human to open.
///
/// `https` only, except on loopback, where `http` is allowed because the thing being delegated
/// to is very often a tool running on this machine — and the bridge itself is loopback-only for
/// the same reason.
///
/// Everything else is refused *by name*, because the interesting failures are the ones that
/// look like a link: `javascript:` and `data:` are code wearing an address, and `file:` reads
/// the human's disk from inside a card an agent asked them to trust. This is the same policy the
/// embedded browser applies again when it opens the view; here it exists so a malformed task is
/// refused with an error code and a sentence rather than becoming a card that cannot work.
pub fn url_is_allowed(raw: &str) -> Result<(), String> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    if lower.starts_with("http://") {
        let host = host_of(trimmed);
        if is_loopback_host(host) {
            return Ok(());
        }
        return Err(format!(
            "`http://{host}` is refused for a delegated web task: it has to travel over https, unless it points at this machine (localhost, 127.0.0.1, ::1)."
        ));
    }
    let scheme = lower.split([':', '/']).next().unwrap_or("");
    Err(format!(
        "`{scheme}:` is not an address for a delegated web task; it takes an `https:` URL."
    ))
}

/// How many bytes a value occupies once serialized, for the session size cap.
fn json_len(value: &Value) -> usize {
    serde_json::to_string(value).map(|s| s.len()).unwrap_or(0)
}

/// Check one `WebTask` item.
fn validate_web_task_item(item: &Value, index: usize, seen: &mut std::collections::HashSet<String>) -> Result<(), String> {
    let Some(obj) = item.as_object() else {
        return Err(format!(
            "`props.items[{index}]` must be an object with an `id`, a `title` and a `url`."
        ));
    };

    match obj.get("id").and_then(Value::as_str) {
        Some(id) if !id.trim().is_empty() => {
            if !seen.insert(id.to_string()) {
                return Err(format!(
                    "`props.items[{index}].id` is `{id}`, which is already used by an earlier item: an answer keyed by id could not say which one was done."
                ));
            }
        }
        _ => {
            return Err(format!(
                "`props.items[{index}].id` must be a non-empty string; an item with no id has nothing for the human's progress to be recorded against."
            ))
        }
    }

    match obj.get("title").and_then(Value::as_str) {
        Some(title) if !title.trim().is_empty() => {}
        _ => {
            return Err(format!(
                "`props.items[{index}].title` must be a non-empty string: a row in the list the human cannot read is a row they cannot decide about."
            ))
        }
    }

    match obj.get("url").and_then(Value::as_str) {
        Some(url) => url_is_allowed(url).map_err(|e| format!("`props.items[{index}].url`: {e}"))?,
        None => {
            return Err(format!(
                "`props.items[{index}].url` must be a string for WebTask."
            ))
        }
    }

    Ok(())
}

/// Check the session an agent wants carried into the embedded browser.
fn validate_web_session(session: &Value) -> Result<(), String> {
    let Some(obj) = session.as_object() else {
        return Err("`props.session` must be an object when it is present for WebTask.".into());
    };

    if let Some(origins) = obj.get("origins") {
        let Some(items) = origins.as_array() else {
            return Err("`props.session.origins` must be an array for WebTask.".into());
        };
        if items.len() > WEBTASK_SESSION_ORIGIN_LIMIT {
            return Err(format!(
                "`props.session.origins` has {} entries for WebTask, and the cap is {WEBTASK_SESSION_ORIGIN_LIMIT}: a session names the sites it is for, it is not a cookie jar.",
                items.len()
            ));
        }
        for (index, origin) in items.iter().enumerate() {
            let Some(origin) = origin.as_object() else {
                return Err(format!(
                    "`props.session.origins[{index}]` must be an object with an `origin`."
                ));
            };
            match origin.get("origin").and_then(Value::as_str) {
                Some(value) if !value.trim().is_empty() => {}
                _ => {
                    return Err(format!(
                        "`props.session.origins[{index}].origin` must be a non-empty string, and it has to be the full origin (`https://example.com`): the canvas seeds `localStorage` by exact origin match."
                    ))
                }
            }
            if let Some(storage) = origin.get("localStorage") {
                let Some(entries) = storage.as_array() else {
                    return Err(format!(
                        "`props.session.origins[{index}].localStorage` must be an array of `{{ name, value }}` pairs."
                    ));
                };
                if entries.len() > WEBTASK_SESSION_STORAGE_LIMIT {
                    return Err(format!(
                        "`props.session.origins[{index}].localStorage` has {} entries, and the cap is {WEBTASK_SESSION_STORAGE_LIMIT}.",
                        entries.len()
                    ));
                }
                for (entry_index, entry) in entries.iter().enumerate() {
                    let valid = entry
                        .as_object()
                        .map(|e| e.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty()))
                        .unwrap_or(false);
                    if !valid {
                        return Err(format!(
                            "`props.session.origins[{index}].localStorage[{entry_index}]` must be an object with a non-empty `name`, and it may carry a `value`."
                        ));
                    }
                }
            }
        }
    }

    if let Some(cookies) = obj.get("cookies") {
        let Some(items) = cookies.as_array() else {
            return Err("`props.session.cookies` must be an array for WebTask.".into());
        };
        if items.len() > WEBTASK_SESSION_COOKIE_LIMIT {
            return Err(format!(
                "`props.session.cookies` has {} entries for WebTask, and the cap is {WEBTASK_SESSION_COOKIE_LIMIT}.",
                items.len()
            ));
        }
        for (index, cookie) in items.iter().enumerate() {
            let Some(cookie) = cookie.as_object() else {
                return Err(format!(
                    "`props.session.cookies[{index}]` must be an object with `name`, `value` and `domain`."
                ));
            };
            for key in ["name", "value", "domain"] {
                match cookie.get(key).and_then(Value::as_str) {
                    Some(value) if key == "value" || !value.trim().is_empty() => {}
                    _ => {
                        return Err(format!(
                            "`props.session.cookies[{index}].{key}` must be a string; a cookie without a {key} cannot be placed in the browser, and placing one at the wrong domain would leak a credential."
                        ))
                    }
                }
            }
            // A cookie has to name a domain, and the shell checks the item's host against it
            // before anything is placed, so a session for `bank.example` is never handed to a
            // page on `shop.example` just because both arrived in one card.
        }
    }

    // A session exists to be shown before it is handed over, and what is shown is the list of
    // sites it is for. A payload that names none of them has nothing to ask consent about, so
    // it is refused rather than injected on the strength of a label.
    let names_a_site = obj
        .get("origins")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
        || obj
            .get("cookies")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
    if !names_a_site {
        return Err(
            "`props.session` names no origins and carries no cookies: there is nothing to hand over, and nothing for the human to be asked about."
                .into(),
        );
    }

    if json_len(session) > WEBTASK_SESSION_BYTES_LIMIT {
        return Err(format!(
            "`props.session` is larger than {} KiB. A session is a set of credentials, not a payload: hand over the few entries the site actually needs.",
            WEBTASK_SESSION_BYTES_LIMIT / 1024
        ));
    }

    Ok(())
}

/// Check a `WebTask`'s list and the session it wants carried over.
fn validate_web_task(props: &Value) -> Result<(), String> {
    let Some(obj) = props.as_object() else {
        return Ok(());
    };

    let Some(items) = obj.get("items").and_then(Value::as_array) else {
        return Ok(());
    };
    if items.is_empty() {
        return Err(
            "`props.items` is empty: a delegated web task with nothing in it is a card with no work in it."
                .into(),
        );
    }
    if items.len() > WEBTASK_ITEM_LIMIT {
        return Err(format!(
            "`props.items` has {} entries for WebTask, and the cap is {WEBTASK_ITEM_LIMIT}. Send a second card when the first is done rather than one list nobody can see the end of.",
            items.len()
        ));
    }

    let mut seen = std::collections::HashSet::new();
    for (index, item) in items.iter().enumerate() {
        validate_web_task_item(item, index, &mut seen)?;
    }

    if let Some(open_in) = obj.get("openIn") {
        match open_in.as_str() {
            Some(value) if WEBTASK_OPEN_IN.contains(&value) => {}
            _ => {
                return Err(format!(
                    "`props.openIn` must be one of {} for WebTask.",
                    WEBTASK_OPEN_IN.join(", ")
                ))
            }
        }
    }

    if let Some(session) = obj.get("session") {
        if !session.is_null() {
            validate_web_session(session)?;
        }
    }

    Ok(())
}

/// Check a signature request: exactly one target, and fields that can actually be drawn.
fn validate_esign(props: &Value) -> Result<(), String> {
    let Some(obj) = props.as_object() else {
        return Ok(());
    };

    let has_url = obj.get("url").is_some_and(|v| !v.is_null());
    let has_document = obj.get("document").is_some_and(|v| !v.is_null());
    if !has_url && !has_document {
        return Err(
            "ESign needs either `props.url` (a signing link) or `props.document` (the PDF to fill and sign); it has neither."
                .into(),
        );
    }
    if has_url && has_document {
        // Both clients refuse this too, but the bridge is the gate: a card holding both would have
        // to pick which one the human signs, and an answer about the wrong document looks exactly
        // like an answer about the right one.
        return Err(
            "ESign takes `props.url` or `props.document`, not both: send the provider link, or the PDF to fill, and the card knows what it is asking for."
                .into(),
        );
    }

    if has_url {
        match obj.get("url").and_then(Value::as_str) {
            Some(url) => url_is_allowed(url).map_err(|e| format!("`props.url`: {e}"))?,
            None => return Err("`props.url` must be a string for ESign.".into()),
        }
    }

    if has_document {
        let Some(document) = obj.get("document").and_then(Value::as_object) else {
            return Err("`props.document` must be an object with a `src` for ESign.".into());
        };
        let Some(src) = document.get("src").and_then(Value::as_str) else {
            return Err("`props.document.src` must be a string for ESign.".into());
        };
        if let Some(rest) = src.strip_prefix("data:") {
            if !rest.starts_with("application/pdf") {
                return Err(
                    "`props.document.src` is a data URL that is not a PDF; ESign fills PDF documents."
                        .into(),
                );
            }
            let bytes = src.len();
            if bytes > (ESIGN_DOCUMENT_BYTES_LIMIT * 4 / 3) + 1024 {
                return Err(format!(
                    "`props.document.src` is about {} MiB of base64, and the cap is {} MiB of PDF: send a link instead of the bytes.",
                    bytes / (1024 * 1024),
                    ESIGN_DOCUMENT_BYTES_LIMIT / (1024 * 1024)
                ));
            }
        } else {
            url_is_allowed(src).map_err(|e| format!("`props.document.src`: {e}"))?;
        }
    }

    if let Some(fields) = obj.get("fields") {
        let Some(items) = fields.as_array() else {
            return Err("`props.fields` must be an array of fields for ESign.".into());
        };
        if items.len() > ESIGN_FIELD_LIMIT {
            return Err(format!(
                "`props.fields` has {} entries for ESign, and the cap is {ESIGN_FIELD_LIMIT}.",
                items.len()
            ));
        }
        for (index, field) in items.iter().enumerate() {
            let Some(field) = field.as_object() else {
                return Err(format!(
                    "`props.fields[{index}]` must be an object with an `id`, a `kind` and a rectangle."
                ));
            };
            match field.get("id").and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => {}
                _ => {
                    return Err(format!(
                        "`props.fields[{index}].id` must be a non-empty string; a field with no name has nothing to key the human's answer against."
                    ))
                }
            }
            match field.get("kind").and_then(Value::as_str) {
                Some(kind) if ESIGN_FIELD_KINDS.contains(&kind) => {}
                _ => {
                    return Err(format!(
                        "`props.fields[{index}].kind` must be one of {} for ESign.",
                        ESIGN_FIELD_KINDS.join(", ")
                    ))
                }
            }
            let page = field.get("page").and_then(Value::as_i64).unwrap_or(1);
            if page < 1 || page > ESIGN_PAGE_LIMIT as i64 {
                return Err(format!(
                    "`props.fields[{index}].page` is {page}; pages are numbered from 1, and this takes up to {ESIGN_PAGE_LIMIT}."
                ));
            }
            // Fractions of the page, the same coordinate language `RegionMark` uses: the agent
            // knows the page, the canvas knows how large it drew it, and neither has to be told
            // the other's size.
            for key in ["x", "y", "w", "h"] {
                let value = field.get(key).and_then(Value::as_f64);
                let valid = value.is_some_and(|v| v >= 0.0 && v <= 1.0);
                if !valid {
                    return Err(format!(
                        "`props.fields[{index}].{key}` must be a number between 0 and 1, as a fraction of the page."
                    ));
                }
            }
        }
    }

    Ok(())
}

/// The widest scale AuraUI draws. Past ten buttons the row stops fitting one line and stops
/// being answerable at a glance, which is the whole point of a scale drawn as buttons.
pub const RATING_MAX_POINTS: i64 = 10;
pub const RATING_MIN_POINTS: i64 = 2;

/// Check a `RatingScale`'s range, its labels and its default.
///
/// The range is the agent's to choose and the labels are the agent's words — AuraUI never
/// invents "1 means terrible". What it does insist on is that the range is drawable and that
/// every point has exactly one name, because a scale with a missing label renders a button
/// with nothing on it.
fn validate_rating_scale(props: &Value) -> Result<(), String> {
    let Some(obj) = props.as_object() else {
        return Ok(());
    };

    let Some(max) = obj.get("max").and_then(Value::as_i64) else {
        return Err("`props.max` must be a whole number for RatingScale.".into());
    };
    if !(RATING_MIN_POINTS..=RATING_MAX_POINTS).contains(&max) {
        return Err(format!(
            "`props.max` is {max} for RatingScale; a scale has to be between {RATING_MIN_POINTS} and {RATING_MAX_POINTS} points so every point stays one button the human can press."
        ));
    }

    let min = match obj.get("min") {
        None | Some(Value::Null) => 1,
        Some(value) => match value.as_i64() {
            Some(number) => number,
            None => return Err("`props.min` must be a whole number for RatingScale.".into()),
        },
    };
    if min >= max {
        return Err(format!(
            "`props.min` is {min} and `props.max` is {max} for RatingScale; the lowest point has to be below the highest."
        ));
    }

    if let Some(labels) = obj.get("labels") {
        let Some(items) = labels.as_array() else {
            return Err("`props.labels` must be an array of strings for RatingScale.".into());
        };
        let expected = (max - min + 1) as usize;
        if items.len() != expected {
            return Err(format!(
                "`props.labels` has {} entries for RatingScale, expected {expected}: one label per point from {min} to {max}.",
                items.len()
            ));
        }
        for (index, label) in items.iter().enumerate() {
            match label.as_str() {
                Some(text) if !text.is_empty() => {}
                _ => {
                    return Err(format!(
                        "`props.labels[{index}]` must be a non-empty string; a point with no name would draw an empty button."
                    ))
                }
            }
        }
    }

    if let Some(default) = obj.get("defaultValue") {
        if !default.is_null() && !default.as_i64().is_some_and(|n| n >= min && n <= max) {
            return Err(format!(
                "`props.defaultValue` for RatingScale must be a whole number between {min} and {max}."
            ));
        }
    }

    Ok(())
}

/// The kinds of line a diff hunk may contain. Mirrors `DiffLine` in protocol.ts.
pub const DIFF_LINE_KINDS: [&str; 3] = ["context", "add", "del"];

/// Check a `DiffReview`'s hunks.
///
/// The canvas renders what it is handed and never computes a diff, the same way it never
/// computes a chart's numbers: the agent splits its own change and marks each line. That
/// makes a hunk with no id, or a line whose kind is not one of the three, unrenderable rather
/// than merely unusual, so both are refused here with the position that is wrong.
fn validate_diff_review(props: &Value) -> Result<(), String> {
    let Some(obj) = props.as_object() else {
        return Ok(());
    };
    let Some(items) = obj.get("hunks").and_then(Value::as_array) else {
        return Ok(());
    };
    if items.is_empty() {
        return Err("`props.hunks` is empty: the human would have nothing to review.".into());
    }

    for (hunk_index, hunk) in items.iter().enumerate() {
        let Some(hunk) = hunk.as_object() else {
            return Err(format!(
                "`props.hunks[{hunk_index}]` must be an object with an `id` and `lines`."
            ));
        };
        match hunk.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => {}
            _ => {
                return Err(format!(
                    "`props.hunks[{hunk_index}].id` must be a non-empty string; a hunk with no id has nothing to send a decision back against."
                ))
            }
        }

        let Some(lines) = hunk.get("lines").and_then(Value::as_array) else {
            return Err(format!(
                "`props.hunks[{hunk_index}].lines` must be an array of diff lines."
            ));
        };
        if lines.is_empty() {
            return Err(format!(
                "`props.hunks[{hunk_index}].lines` is empty: a hunk with no lines would draw an empty box."
            ));
        }

        for (line_index, line) in lines.iter().enumerate() {
            let Some(line) = line.as_object() else {
                return Err(format!(
                    "`props.hunks[{hunk_index}].lines[{line_index}]` must be an object with a `kind` and `text`."
                ));
            };
            match line.get("kind").and_then(Value::as_str) {
                Some(kind) if DIFF_LINE_KINDS.contains(&kind) => {}
                other => {
                    let shown = match other {
                        Some(kind) => format!("`{kind}`"),
                        None => "missing".to_string(),
                    };
                    return Err(format!(
                        "`props.hunks[{hunk_index}].lines[{line_index}].kind` is {shown}, which the canvas cannot draw; expected one of `context`, `add`, `del`."
                    ));
                }
            }
            if line.get("text").and_then(Value::as_str).is_none() {
                return Err(format!(
                    "`props.hunks[{hunk_index}].lines[{line_index}].text` must be a string."
                ));
            }
        }
    }

    Ok(())
}

/// The only kinds of address a `RegionMark` will draw a picture from.
///
/// Deliberately two. An overlay that appears over somebody's desktop unasked is not the place
/// to let a socket on the machine name whatever URL it likes (a plain `http:` fetch from the
/// human's browser, or a `file:` read of a path they never chose), and neither scheme is needed
/// to do the job: an agent with a screenshot in hand base64s it, which is the common case.
/// `https:` is allowed for a picture that already lives somewhere public.
pub const MARK_SRC_PREFIXES: [&str; 2] = ["https://", "data:image/"];

/// The pens a `RegionMark` card can offer. Mirrors `MARK_TOOLS` in protocol.ts.
///
/// Order matters: it is the order the buttons appear in and the order the digit keys pick them,
/// so the two sides have to agree on it. Box first, because "mark the part that is wrong" is
/// the commonest thing anyone wants to say about a picture.
pub const MARK_TOOLS: [&str; 5] = ["rect", "ellipse", "arrow", "cross", "path"];

/// Check a `RegionMark`'s picture and the way it is to be marked.
///
/// The one thing this component cannot do without is somewhere to draw: an unusable `src`
/// reaches the canvas as a broken image under a question about a picture nobody can see.
fn validate_region_mark(props: &Value) -> Result<(), String> {
    let Some(obj) = props.as_object() else {
        return Ok(());
    };

    if let Some(src) = obj.get("src").and_then(Value::as_str) {
        if !MARK_SRC_PREFIXES.iter().any(|prefix| src.starts_with(prefix)) {
            return Err(
                "`props.src` for RegionMark must be an `https:` URL or a `data:image/...` URL. AuraUI draws over whatever the human was already doing, so it will not fetch a plaintext address or read a local file on the say-so of whatever opened a socket; send the image's bytes as a data URL instead."
                    .into(),
            );
        }
    }

    if let Some(tool) = obj.get("tool") {
        if !tool.is_null() {
            match tool.as_str() {
                Some(name) if MARK_TOOLS.contains(&name) => {}
                other => {
                    let shown = match other {
                        Some(value) => format!("`{value}`"),
                        None => "not a string".to_string(),
                    };
                    return Err(format!(
                        "`props.tool` for RegionMark is {shown}, which the canvas cannot draw; expected one of {}.",
                        mark_tool_list()
                    ));
                }
            }
        }
    }

    // A toolbar is the question: a pen that does not exist is a button that cannot mark what was
    // asked for, and an empty list is a drawing surface with nothing to draw with.
    if let Some(tools) = obj.get("tools") {
        if !tools.is_null() {
            let Some(listed) = tools.as_array() else {
                return Err("`props.tools` for RegionMark must be an array of pen names.".into());
            };
            if listed.is_empty() {
                return Err(format!(
                    "`props.tools` is empty for RegionMark, so the human would have nothing to draw with; leave the key out to offer all of {}.",
                    mark_tool_list()
                ));
            }
            for (index, name) in listed.iter().enumerate() {
                match name.as_str() {
                    Some(name) if MARK_TOOLS.contains(&name) => {}
                    Some(unknown) => {
                        return Err(format!(
                            "`props.tools[{index}]` is `{unknown}`, which the canvas cannot draw; expected one of {}.",
                            mark_tool_list()
                        ))
                    }
                    None => {
                        return Err(format!(
                            "`props.tools[{index}]` must be a pen name; expected one of {}.",
                            mark_tool_list()
                        ))
                    }
                }
            }
        }
    }

    for key in ["width", "height"] {
        if let Some(value) = obj.get(key) {
            if value.is_null() {
                continue;
            }
            match value.as_f64() {
                Some(number) if number > 0.0 => {}
                _ => {
                    return Err(format!(
                        "`props.{key}` for RegionMark must be a positive number: the picture's natural size in pixels. It only decides the frame's shape before the image loads, so leave the key out when it is not known."
                    ))
                }
            }
        }
    }

    Ok(())
}

/// Check a `PairMatrix`'s rows, its options, and the restriction each row may place on them.
///
/// Both lists are keyed by id, and both are a dead end when the id is missing: the answer comes
/// back as `{rowId: optionId}` and a row that cannot be named cannot be answered, while a
/// repeated id has two answers and no way to tell them apart. A row's `options` subset is
/// checked against the real option ids for the same reason an empty option list is: a row
/// restricted to an option that does not exist draws a line with nothing to press.
fn validate_pair_matrix(props: &Value) -> Result<(), String> {
    let Some(obj) = props.as_object() else {
        return Ok(());
    };

    let mut option_ids: Vec<&str> = Vec::new();
    if let Some(options) = obj.get("options").and_then(Value::as_array) {
        if options.is_empty() {
            return Err(
                "`props.options` is empty for PairMatrix: every row would offer nothing to press. AuraUI has no dropdown, so the options are the whole vocabulary the human can answer with."
                    .into(),
            );
        }
        for (index, option) in options.iter().enumerate() {
            let Some(option) = option.as_object() else {
                return Err(format!(
                    "`props.options[{index}]` must be an object with an `id` and a `label`."
                ));
            };
            let Some(id) = option
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                return Err(format!(
                    "`props.options[{index}].id` must be a non-empty string; the answer comes back keyed by it."
                ));
            };
            if option_ids.contains(&id) {
                return Err(format!(
                    "`props.options[{index}].id` is `{id}`, which another option already uses: a repeated id could not be told apart in the answer."
                ));
            }
            if option.get("label").and_then(Value::as_str).is_none() {
                return Err(format!(
                    "`props.options[{index}].label` must be a string: a button with no label is one the human cannot choose."
                ));
            }
            option_ids.push(id);
        }
    }

    let Some(rows) = obj.get("rows").and_then(Value::as_array) else {
        return Ok(());
    };
    if rows.is_empty() {
        return Err(
            "`props.rows` is empty for PairMatrix: the human would have nothing to place.".into(),
        );
    }

    let mut row_ids: Vec<&str> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let Some(row) = row.as_object() else {
            return Err(format!(
                "`props.rows[{index}]` must be an object with an `id` and a `label`."
            ));
        };
        let Some(id) = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return Err(format!(
                "`props.rows[{index}].id` must be a non-empty string; the answer comes back keyed by it."
            ));
        };
        if row_ids.contains(&id) {
            return Err(format!(
                "`props.rows[{index}].id` is `{id}`, which another row already uses: one row would answer for the other."
            ));
        }
        if row.get("label").and_then(Value::as_str).is_none() {
            return Err(format!(
                "`props.rows[{index}].label` must be a string: it is the thing being placed, and the human needs to read it."
            ));
        }

        if let Some(restricted) = row.get("options") {
            if !restricted.is_null() {
                let Some(allowed) = restricted.as_array() else {
                    return Err(format!(
                        "`props.rows[{index}].options` must be an array of option ids."
                    ));
                };
                if allowed.is_empty() {
                    return Err(format!(
                        "`props.rows[{index}].options` is empty, so the row offers nothing to press; leave the key out to offer every option."
                    ));
                }
                for (position, allowed_id) in allowed.iter().enumerate() {
                    match allowed_id.as_str() {
                        Some(allowed_id) if option_ids.contains(&allowed_id) => {}
                        Some(unknown) => {
                            return Err(format!(
                                "`props.rows[{index}].options[{position}]` is `{unknown}`, which is not one of `props.options`; a row can only be narrowed to options that exist."
                            ))
                        }
                        None => {
                            return Err(format!(
                                "`props.rows[{index}].options[{position}]` must be an option id string."
                            ))
                        }
                    }
                }
            }
        }

        row_ids.push(id);
    }

    Ok(())
}

/// Check an `AllocateBudget`'s total, its lines, and whether the two can add up at all.
///
/// The arithmetic is the agent's to get right and the human's to move, and the one thing worse
/// than an unanswerable split is an impossible one: lines whose floors already exceed the total
/// leave the human looking at a card that can never be sent, with no way to say so.
fn validate_allocation(props: &Value) -> Result<(), String> {
    let Some(obj) = props.as_object() else {
        return Ok(());
    };

    let Some(total) = obj.get("total").and_then(Value::as_i64) else {
        return Err(
            "`props.total` must be a whole number for AllocateBudget: the figure the parts have to add up to."
                .into(),
        );
    };
    if total < 1 {
        return Err(format!(
            "`props.total` is {total} for AllocateBudget; a total of zero is nothing to hand out."
        ));
    }

    if let Some(step) = obj.get("step") {
        if !step.is_null() {
            match step.as_i64() {
                Some(number) if (1..=total).contains(&number) => {}
                _ => {
                    return Err(format!(
                        "`props.step` for AllocateBudget must be a whole number between 1 and {total}: how far one press moves a line."
                    ))
                }
            }
        }
    }

    if let Some(flag) = obj.get("requireTotal") {
        if !flag.is_null() && !flag.is_boolean() {
            return Err("`props.requireTotal` for AllocateBudget must be true or false.".into());
        }
    }

    let Some(items) = obj.get("items").and_then(Value::as_array) else {
        return Ok(());
    };
    if items.is_empty() {
        return Err(
            "`props.items` is empty for AllocateBudget: there would be nothing to split the total between."
                .into(),
        );
    }

    let mut ids: Vec<&str> = Vec::new();
    let mut floors: i64 = 0;
    for (index, item) in items.iter().enumerate() {
        let Some(item) = item.as_object() else {
            return Err(format!(
                "`props.items[{index}]` must be an object with an `id` and a `label`."
            ));
        };
        let Some(id) = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return Err(format!(
                "`props.items[{index}].id` must be a non-empty string; the answer comes back keyed by it."
            ));
        };
        if ids.contains(&id) {
            return Err(format!(
                "`props.items[{index}].id` is `{id}`, which another line already uses: the split could not be read back."
            ));
        }
        if item.get("label").and_then(Value::as_str).is_none() {
            return Err(format!(
                "`props.items[{index}].label` must be a string: a line the human cannot read is one they cannot budget."
            ));
        }
        if let Some(min) = item.get("min") {
            if !min.is_null() {
                match min.as_i64() {
                    Some(number) if (0..=total).contains(&number) => floors += number,
                    _ => {
                        return Err(format!(
                            "`props.items[{index}].min` must be a whole number between 0 and {total}."
                        ))
                    }
                }
            }
        }
        ids.push(id);
    }

    if floors > total {
        return Err(format!(
            "`props.items[].min` adds up to {floors}, more than `props.total` ({total}): the card could never reach its own total, so it would never be sendable."
        ));
    }

    Ok(())
}

/// Reject a Vega-Lite spec that would draw a form control.
///
/// A wizard field is not the only place an agent can name a control: Vega binds a signal to
/// an input with `bind`, and `bind: {"input": "checkbox"}` reaches the canvas as an agent's
/// spec and draws a real checkbox inside the chart. AuraUI has no checkboxes, radio buttons
/// or dropdowns, so this is refused rather than rendered — the choice belongs in an
/// `ActionCard` or a wizard `choice` field, where the answer comes back as an event.
///
/// The walk is over the whole spec rather than the two positions Vega documents, because a
/// spec nests its innermost view under `spec`, `layer`, `concat`, `hconcat` or `facet`, and
/// a bind in any of them still draws. Our contract already forbids inlining data into the
/// spec (rows arrive in `props.data` and bind to a named source), so a `bind` key in here is
/// a bind and never a data field that happens to share the name.
fn validate_chart_spec(schema: &Value) -> Result<(), String> {
    match schema {
        Value::Object(map) => {
            if map.contains_key("bind") {
                return Err(
                    "`props.vegaSchema` contains a `bind`, which draws a form control; AuraUI has no checkbox, radio button or dropdown. Ask for the choice in an ActionCard or a wizard `choice` field instead."
                        .into(),
                );
            }
            for value in map.values() {
                validate_chart_spec(value)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                validate_chart_spec(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Check the fields inside a `WizardForm`'s steps.
///
/// A wizard field is the one place an agent names a control, so a kind the canvas does not
/// have would otherwise be drawn as whatever the renderer falls back to — the human answers
/// a different question than the one that was asked. Catching it here turns that into an
/// `error` frame on the agent's socket instead.
///
/// Tolerant by construction: anything this walk cannot read is left to the shape check that
/// already owns malformed frames, and no branch indexes or unwraps untrusted JSON.
fn validate_wizard_fields(steps: &Value) -> Result<(), String> {
    let Some(steps) = steps.as_array() else {
        return Ok(());
    };

    for step in steps {
        let Some(fields) = step.get("fields").and_then(Value::as_array) else {
            continue;
        };

        for field in fields {
            let Some(object) = field.as_object() else {
                continue;
            };
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("(unnamed)");

            let Some(kind) = object.get("type").and_then(Value::as_str) else {
                return Err(format!(
                    "`props.steps[].fields[].type` is required for the `{name}` field; expected one of {}.",
                    field_type_list()
                ));
            };

            if !FIELD_TYPES.contains(&kind) {
                return Err(format!(
                    "`props.steps[].fields[].type` is `{kind}` for the `{name}` field, which the canvas cannot draw; expected one of {}.",
                    field_type_list()
                ));
            }

            // A choice with nothing to choose from is the same dead end an empty ActionCard is.
            if matches!(kind, "choice" | "multi") {
                match object.get("options").and_then(Value::as_array) {
                    Some(options) if !options.is_empty() => {}
                    _ => {
                        return Err(format!(
                            "`props.steps[].fields[].options` for the `{name}` {kind} field must be a non-empty array: the human would have nothing to click."
                        ))
                    }
                }
            }
        }
    }

    Ok(())
}

/// The valid pens, quoted for an error message.
fn mark_tool_list() -> String {
    MARK_TOOLS
        .iter()
        .map(|tool| format!("`{tool}`"))
        .collect::<Vec<String>>()
        .join(", ")
}

/// The valid field kinds, quoted for an error message.
fn field_type_list() -> String {
    FIELD_TYPES
        .iter()
        .map(|kind| format!("`{kind}`"))
        .collect::<Vec<String>>()
        .join(", ")
}

fn json_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/* ------------------------------------------------------------------ *
 * Bridge -> webview
 * ------------------------------------------------------------------ */

/// Connection state pushed to the canvas so the window can show who is attached.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentConnection {
    pub id: String,
    pub identity: AgentIdentity,
    /// Unix epoch milliseconds.
    pub since: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeStatus {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "bridgeUrl")]
    pub bridge_url: String,
    pub running: bool,
    pub connections: Vec<AgentConnection>,
    /// Total frames accepted from agents since the bridge started.
    pub received: u64,
    /// Total events emitted back to agents since the bridge started.
    pub emitted: u64,
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_agent_frame_type() {
        let samples = [
            json!({"type":"hello","agent":{"name":"pip","version":"0.1"}}),
            json!({"type":"task","taskId":"t1","component":"ActionCard","props":{"options":[]}}),
            json!({"type":"update","taskId":"t1","props":{"x":1}}),
            json!({"type":"resolve","taskId":"t1"}),
            json!({"type":"note","text":"thinking","kind":"thinking"}),
            json!({"type":"ping"}),
        ];
        // `run` is exercised on its own below, where the expansion is checked too.
        for s in samples {
            let parsed: AgentFrame = serde_json::from_value(s.clone())
                .unwrap_or_else(|e| panic!("failed on {s}: {e}"));
            // Round-trips back to the same tag.
            let encoded = serde_json::to_value(&parsed).unwrap();
            assert_eq!(encoded["type"], s["type"]);
            // Version is filled in when the agent omits it.
            assert_eq!(encoded["v"], PROTOCOL_VERSION);
        }
    }

    /// A run becomes ordinary questions, in the order it was written, and each one carries
    /// enough context for the card to say where in the set it sits.
    #[test]
    fn a_run_expands_into_ordered_questions() {
        let frame: RunFrame = serde_json::from_value(json!({
            "type": "run",
            "runId": "incident",
            "instruction": "Four things about the incident.",
            "questions": [
                {"id":"area","component":"ActionCard","instruction":"Where?",
                 "props":{"options":[{"id":"a","label":"A"}]}},
                {"id":"severity","component":"RatingScale","props":{"max":5}},
            ],
        }))
        .expect("a run frame should parse");

        let tasks = expand_run(&frame).expect("a well-formed run should expand");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].task_id, "area");
        assert_eq!(tasks[1].task_id, "severity");
        assert_eq!(tasks[0].instruction.as_deref(), Some("Where?"));
        assert_eq!(tasks[0].v, PROTOCOL_VERSION);

        let first = tasks[0].run.as_ref().expect("the first question knows its slot");
        assert_eq!(first.run_id, "incident");
        assert_eq!((first.index, first.total), (0, 2));
        assert_eq!(first.instruction.as_deref(), Some("Four things about the incident."));
        let second = tasks[1].run.as_ref().unwrap();
        assert_eq!((second.index, second.total), (1, 2));

        // The `run` slot is what makes the card say "Question 2 of 3"; a lone task has none.
        let lone: TaskFrame = serde_json::from_value(
            json!({"type":"task","taskId":"t1","component":"RatingScale","props":{"max":5}}),
        )
        .unwrap();
        assert!(lone.run.is_none());
        let encoded = serde_json::to_value(&lone).unwrap();
        assert!(
            encoded.get("run").is_none(),
            "a lone task must not carry an empty run slot: {encoded}"
        );
    }

    /// Everything that makes a run unanswerable is refused before a single card is drawn,
    /// and the refusal names the question at fault.
    #[test]
    fn refuses_runs_that_cannot_be_asked() {
        let run = |questions: Value| -> RunFrame {
            serde_json::from_value(json!({"type":"run","runId":"r","questions":questions}))
                .expect("the shell of the frame parses")
        };
        let card = json!({"id":"only","component":"ActionCard",
                          "props":{"options":[{"id":"a","label":"A"}]}});

        assert!(expand_run(&run(json!([]))).is_err(), "an empty run asks nothing");
        assert!(expand_run(&run(json!([{"id":"","component":"ActionCard","props":{"options":[{"id":"a","label":"A"}]}}]))).is_err(),
            "the id is the task id, so it cannot be blank");

        let repeated = run(json!([
            {"id":"a","component":"ActionCard","props":{"options":[{"id":"a","label":"A"}]}},
            {"id":"a","component":"ActionCard","props":{"options":[{"id":"a","label":"A"}]}},
        ]));
        let refusal = expand_run(&repeated).expect_err("duplicate ids have no distinct answers");
        assert_eq!(refusal.question_id.as_deref(), Some("a"));

        let unknown = run(json!([
            {"id":"ok","component":"ActionCard","props":{"options":[{"id":"a","label":"A"}]}},
            {"id":"bad","component":"Teleport","props":{}},
        ]));
        let refusal = expand_run(&unknown).expect_err("an unknown component is refused");
        assert_eq!(refusal.question_id.as_deref(), Some("bad"));
        assert!(refusal.message.contains("Teleport"), "{} should name it", refusal.message);

        // An over-long run is refused as a whole: a form the human did not agree to fill in.
        let many: Vec<Value> = (0..RUN_LIMIT + 1)
            .map(|i| json!({"id":format!("q{i}"),"component":"ActionCard",
                             "props":{"options":[{"id":"a","label":"A"}]}}))
            .collect();
        assert!(expand_run(&run(json!(many))).is_err());

        // One question is a legal run; agents just do not need it, and the message says so.
        assert_eq!(expand_run(&run(json!([card]))).map(|t| t.len()), Ok(1));
    }

    #[test]
    fn unknown_type_is_a_deserialize_error() {
        let err = serde_json::from_value::<AgentFrame>(json!({"type":"teleport"}));
        assert!(err.is_err());
    }

    #[test]
    fn validates_required_component_props() {
        assert!(validate_props("ActionCard", &json!({"options":[{"id":"a","label":"A"}]})).is_ok());
        assert!(validate_props("ActionCard", &json!({})).is_err());
        assert!(validate_props("ActionCard", &json!({"options":[]})).is_err());
        assert!(validate_props("DataGrid", &json!({"columns":[],"rows":[]})).is_ok());
        assert!(validate_props("DataGrid", &json!({"columns":[]})).is_err());
        assert!(validate_props("DataGrid", &json!({"columns":"nope","rows":[]})).is_err());
        assert!(validate_props("InteractiveChart", &json!({"vegaSchema":{},"data":[]})).is_ok());
        assert!(validate_props("WizardForm", &json!({"steps":[{"id":"s","title":"S","fields":[]}]})).is_ok());
        assert!(validate_props("WizardForm", &json!({"steps":[]})).is_err());
        assert!(validate_props("SortableList", &json!({"items":[]})).is_ok());
        assert!(validate_props("Notice", &json!({"level":"info"})).is_ok());
    }

    #[test]
    fn rejects_wizard_field_kinds_the_canvas_cannot_draw() {
        let form = |field: Value| json!({"steps":[{"id":"s","title":"S","fields":[field]}]});

        let choice = json!({
            "name":"area","label":"Where did it break?","type":"choice",
            "options":[{"value":"checkout","label":"Checkout"}]
        });
        assert!(validate_props("WizardForm", &form(choice)).is_ok());

        let multi = json!({
            "name":"suites","label":"Which suites?","type":"multi",
            "options":[{"value":"checkout","label":"Checkout"}]
        });
        assert!(validate_props("WizardForm", &form(multi)).is_ok());

        // The three kinds that were deleted, still sent by an agent built against the old
        // contract: each has to come back as an error rather than be redrawn as something else.
        for gone in ["radio", "select", "checkbox"] {
            let stale = json!({"name":"area","label":"Where?","type":gone});
            assert!(
                validate_props("WizardForm", &form(stale)).is_err(),
                "`{gone}` should have been rejected"
            );
        }

        let no_type = json!({"name":"area","label":"Where?"});
        assert!(validate_props("WizardForm", &form(no_type)).is_err());

        for empty in [json!([]), json!(null), json!("nope")] {
            let starved = json!({"name":"area","label":"Where?","type":"choice","options":empty});
            assert!(
                validate_props("WizardForm", &form(starved)).is_err(),
                "a choice field with `{empty}` options should have been rejected"
            );
        }
    }

    #[test]
    fn wizard_field_validation_tolerates_shapes_it_cannot_read() {
        // Every one of these passes the required-key check and then gives the walk nothing to
        // read. That is not this validator's to reject: a malformed frame is the shape check's
        // problem, and guessing here would block a form the canvas can still draw.
        let unreadable = [
            json!({"steps":[null]}),
            json!({"steps":[7]}),
            json!({"steps":["step"]}),
            json!({"steps":[{"id":"s","title":"S"}]}),
            json!({"steps":[{"id":"s","title":"S","fields":null}]}),
            json!({"steps":[{"id":"s","title":"S","fields":[]}]}),
            json!({"steps":[{"id":"s","title":"S","fields":[null,"x",7]}]}),
            // A readable field beside an unreadable step: the walk keeps going.
            json!({"steps":[null,{"id":"s","title":"S","fields":[{"name":"note","label":"Note","type":"text"}]}]}),
        ];

        for props in unreadable {
            if let Err(message) = validate_props("WizardForm", &props) {
                panic!("{props} should not have been rejected, got: {message}");
            }
        }
    }

    #[test]
    fn rejects_chart_specs_that_would_draw_a_form_control() {
        let chart = |schema: Value| json!({"vegaSchema": schema, "data": []});

        // The shape every real spec has: a bind-free bar chart is fine.
        let plain = json!({
            "data": {"name": "auraui"},
            "mark": {"type": "bar"},
            "encoding": {"x": {"field": "region", "type": "nominal"}}
        });
        assert!(validate_props("InteractiveChart", &chart(plain)).is_ok());

        // Vega draws a real checkbox for this one, in a component whose whole job is a chart.
        for control in ["checkbox", "radio", "select", "range"] {
            let bound = json!({
                "data": {"name": "auraui"},
                "params": [{ "name": "p", "bind": { "input": control } }],
                "mark": {"type": "bar"}
            });
            assert!(
                validate_props("InteractiveChart", &chart(bound)).is_err(),
                "a `{control}` bind should have been rejected"
            );
        }

        // A bind does not have to sit at the top: a layered or concatenated spec hides its
        // views a level down, and Vega still draws the control.
        let nested = json!({
            "layer": [
                { "mark": {"type": "bar"} },
                { "spec": { "params": [{ "name": "p", "bind": { "input": "checkbox" } }] } }
            ]
        });
        assert!(validate_props("InteractiveChart", &chart(nested)).is_err());

        // A selection's own bind, which is the older spelling of the same thing.
        let legacy = json!({
            "selection": { "pick": { "type": "single", "bind": "legend" } },
            "mark": {"type": "bar"}
        });
        assert!(validate_props("InteractiveChart", &chart(legacy)).is_err());

        // A spec whose inner values are unreadable still has no bind in it, and that is the
        // only thing this walk judges. (`vegaSchema` itself being absent or null is a
        // required-key failure, which the check above already owns.)
        let odd = json!({ "mark": 7, "encoding": "nope", "layer": [{ "params": 3 }] });
        assert!(validate_props("InteractiveChart", &chart(odd)).is_ok());
    }

    #[test]
    fn canvas_frames_serialize_with_type_tag_and_camel_case_ids() {
        let welcome = CanvasFrame::Welcome(WelcomeFrame {
            v: PROTOCOL_VERSION.into(),
            session_id: "abc".into(),
            server: ServerInfo {
                name: SERVER_NAME.into(),
                version: SERVER_VERSION.into(),
                protocol: PROTOCOL_VERSION.into(),
                bridge_url: "ws://127.0.0.1:9090".into(),
            },
        });
        let v: Value = serde_json::from_str(&welcome.to_json()).unwrap();
        assert_eq!(v["type"], "welcome");
        assert_eq!(v["sessionId"], "abc");
        assert_eq!(v["server"]["bridgeUrl"], "ws://127.0.0.1:9090");

        let event = CanvasFrame::Event(EventFrame {
            v: PROTOCOL_VERSION.into(),
            task_id: "t1".into(),
            event: EventName::Action,
            payload: json!({"actionId":"approve"}),
            seq: 7,
            at: 1_700_000_000_000,
        });
        let v: Value = serde_json::from_str(&event.to_json()).unwrap();
        assert_eq!(v["type"], "event");
        assert_eq!(v["taskId"], "t1");
        assert_eq!(v["event"], "action");
        assert_eq!(v["seq"], 7);
    }

    #[test]
    fn error_codes_use_snake_case_on_the_wire() {
        let f = CanvasFrame::Error(ErrorFrame {
            v: PROTOCOL_VERSION.into(),
            code: ErrorCode::UnknownComponent,
            message: "nope".into(),
            task_id: None,
        });
        let v: Value = serde_json::from_str(&f.to_json()).unwrap();
        assert_eq!(v["code"], "unknown_component");
        // Absent optional fields must not serialize as null.
        assert!(v.get("taskId").is_none());
    }

    #[test]
    fn validates_rating_scales_a_human_can_actually_press() {
        let scale = |props: Value| validate_props("RatingScale", &props);

        assert!(scale(json!({"max": 5})).is_ok());
        assert!(scale(json!({"max": 10, "min": 0})).is_ok());
        assert!(scale(json!({"max": 5, "labels": ["a","b","c","d","e"]})).is_ok());
        assert!(scale(json!({"max": 5, "min": 0, "labels": ["a","b","c","d","e","f"]})).is_ok());
        assert!(scale(json!({"max": 5, "defaultValue": 3})).is_ok());
        assert!(scale(json!({"max": 5, "defaultValue": null})).is_ok());

        // A scale has to fit in one row of buttons, so it is bounded at both ends.
        assert!(scale(json!({"max": 11})).is_err());
        assert!(scale(json!({"max": 1})).is_err());
        // Not a whole number of points.
        assert!(scale(json!({"max": 4.5})).is_err());
        assert!(scale(json!({"max": "5"})).is_err());
        assert!(scale(json!({"max": 5, "min": 5})).is_err());
        // One label per point, and every point has to say something.
        assert!(scale(json!({"max": 5, "labels": ["a","b"]})).is_err());
        assert!(scale(json!({"max": 5, "labels": ["a","b","c","d",""]})).is_err());
        assert!(scale(json!({"max": 5, "labels": "not an array"})).is_err());
        // A default outside the range would preselect a point that is never drawn.
        assert!(scale(json!({"max": 5, "defaultValue": 9})).is_err());
        assert!(scale(json!({"max": 5, "defaultValue": 2.5})).is_err());

        assert!(scale(json!({})).is_err());
        assert!(is_known_component("RatingScale"));
    }

    #[test]
    fn validates_diff_hunks_line_by_line() {
        let review = |props: Value| validate_props("DiffReview", &props);
        let hunk = |lines: Value| {
            json!({"hunks":[{"id":"h1","header":"@@ -1,2 +1,3 @@","lines":lines}]})
        };

        let mixed = json!([
            {"kind":"context","text":" let total = 0;"},
            {"kind":"add","text":"+const tax = 0.2;"},
            {"kind":"del","text":"-const tax = 0.1;"}
        ]);
        assert!(review(hunk(mixed)).is_ok());
        // A blank line in a diff is still a string, so it is allowed.
        assert!(review(hunk(json!([{"kind":"context","text":""}]))).is_ok());

        assert!(review(json!({"hunks":[]})).is_err());
        assert!(review(json!({})).is_err());
        // `hunks` is a required array, so a string here is the required-key check's problem.
        assert!(review(json!({"hunks":"nope"})).is_err());
        assert!(review(json!({"hunks":[7]})).is_err());
        assert!(review(json!({"hunks":[{"lines":[{"kind":"add","text":"x"}]}]})).is_err());
        assert!(review(json!({"hunks":[{"id":"","lines":[{"kind":"add","text":"x"}]}]})).is_err());
        assert!(review(json!({"hunks":[{"id":"h","lines":[]}]})).is_err());
        assert!(review(hunk(json!([{"kind":"add"}]))).is_err());
        assert!(review(hunk(json!([{"text":"x"}]))).is_err());

        // A line kind with no colour to draw it in: report the position and the vocabulary.
        let stale = hunk(json!([{"kind":"hunk","text":"@@ -1 +1 @@"}]));
        let message = review(stale).unwrap_err();
        assert!(message.contains("context"), "should name the valid kinds: {message}");
        assert!(message.contains("add") && message.contains("del"), "names all three: {message}");

        assert!(is_known_component("DiffReview"));
    }

    #[test]
    fn validates_region_marks_that_can_actually_be_drawn() {
        let mark = |props: Value| validate_props("RegionMark", &props);

        assert!(mark(json!({"src": "https://example.com/shot.png"})).is_ok());
        assert!(mark(json!({"src": "data:image/png;base64,AAAA", "tool": "cross"})).is_ok());
        assert!(mark(json!({
            "src": "data:image/png;base64,AAAA",
            "tool": "arrow",
            "tools": ["arrow", "cross"],
            "width": 1280,
            "height": 800
        }))
        .is_ok());
        // Every pen by name, and the whole set by omission.
        for tool in MARK_TOOLS {
            assert!(mark(json!({"src": "https://x/y.png", "tool": tool})).is_ok());
            assert!(mark(json!({"src": "https://x/y.png", "tools": [tool]})).is_ok());
        }

        // The picture an agent actually has is a screenshot, which is a data URL. What this
        // refuses is a socket on the machine naming an address of its own choosing.
        assert!(mark(json!({"src": "http://example.com/shot.png"})).is_err());
        assert!(mark(json!({"src": "file:///home/somebody/notes.txt"})).is_err());
        assert!(mark(json!({"src": "data:text/html,<b>x</b>"})).is_err());
        assert!(mark(json!({"src": ""})).is_err());
        assert!(mark(json!({})).is_err());
        assert!(mark(json!({"src": 7})).is_err());

        // The toolbar is the question, so a pen that does not exist and a toolbar with nothing in
        // it are both refused rather than drawn.
        let refusal = mark(json!({"src": "https://x/y.png", "tool": "lasso"})).unwrap_err();
        assert!(refusal.contains("lasso"), "should name it: {refusal}");
        assert!(refusal.contains("ellipse"), "should list what is drawable: {refusal}");
        assert!(mark(json!({"src": "https://x/y.png", "tools": []})).is_err());
        assert!(mark(json!({"src": "https://x/y.png", "tools": ["ghost"]})).is_err());
        assert!(mark(json!({"src": "https://x/y.png", "tools": "rect"})).is_err());
        assert!(mark(json!({"src": "https://x/y.png", "tools": [7]})).is_err());
        assert!(mark(json!({"src": "https://x/y.png", "width": 0})).is_err());
        assert!(mark(json!({"src": "https://x/y.png", "height": -3})).is_err());
        assert!(mark(json!({"src": "https://x/y.png", "width": "1280"})).is_err());

        assert!(is_known_component("RegionMark"));
    }

    #[test]
    fn validates_pair_matrix_rows_against_its_options() {
        let matrix = |props: Value| validate_props("PairMatrix", &props);
        let options = json!([
            {"id": "auth", "label": "Signing in"},
            {"id": "billing", "label": "Payments"}
        ]);
        let rows = json!([
            {"id": "r1", "label": "Stripe charge failed"},
            {"id": "r2", "label": "Token expired", "options": ["auth"]}
        ]);

        assert!(matrix(json!({"rows": rows, "options": options})).is_ok());
        assert!(matrix(json!({"rows": rows, "options": options, "requireAll": false})).is_ok());

        assert!(matrix(json!({"rows": [], "options": options})).is_err());
        assert!(matrix(json!({"rows": rows, "options": []})).is_err());
        assert!(matrix(json!({"rows": rows, "options": "auth"})).is_err());
        assert!(matrix(json!({"rows": rows})).is_err());

        // Both lists are keyed by id, and an id that repeats or goes missing has no answer.
        assert!(matrix(json!({
            "rows": rows,
            "options": [{"id": "auth", "label": "A"}, {"id": "auth", "label": "B"}]
        }))
        .is_err());
        assert!(matrix(json!({"rows": rows, "options": [{"id": "auth"}]})).is_err());
        assert!(matrix(json!({"rows": rows, "options": [{"id": "", "label": "A"}]})).is_err());
        assert!(matrix(json!({
            "rows": [{"id": "r", "label": "A"}, {"id": "r", "label": "B"}],
            "options": options
        }))
        .is_err());
        assert!(matrix(json!({"rows": [{"id": "r"}], "options": options})).is_err());
        assert!(matrix(json!({"rows": [7], "options": options})).is_err());

        // A row narrowed to an option that does not exist is a line with nothing to press.
        let refusal = matrix(json!({
            "rows": [{"id": "r", "label": "X", "options": ["ghost"]}],
            "options": options
        }))
        .expect_err("an unknown option id should be refused");
        assert!(refusal.contains("ghost"), "should name it: {refusal}");
        assert!(matrix(json!({
            "rows": [{"id": "r", "label": "X", "options": []}],
            "options": options
        }))
        .is_err());
        assert!(matrix(json!({
            "rows": [{"id": "r", "label": "X", "options": "auth"}],
            "options": options
        }))
        .is_err());

        assert!(is_known_component("PairMatrix"));
    }

    #[test]
    fn validates_splits_that_can_add_up() {
        let budget = |props: Value| validate_props("AllocateBudget", &props);
        let items = json!([{"id": "a", "label": "A"}, {"id": "b", "label": "B"}]);

        assert!(budget(json!({"total": 100, "items": items})).is_ok());
        assert!(budget(json!({
            "total": 10,
            "items": [{"id": "a", "label": "A", "min": 10}],
            "step": 5,
            "requireTotal": false
        }))
        .is_ok());

        assert!(budget(json!({"total": 0, "items": items})).is_err());
        assert!(budget(json!({"total": 4.5, "items": items})).is_err());
        assert!(budget(json!({"items": items})).is_err());
        assert!(budget(json!({"total": 100, "items": []})).is_err());
        assert!(budget(json!({"total": 100, "items": "a"})).is_err());

        // The one failure worth catching before a window opens: floors that already overrun the
        // total leave a card that can never be sent and never says why.
        let refusal = budget(json!({
            "total": 100,
            "items": [{"id": "a", "label": "A", "min": 60}, {"id": "b", "label": "B", "min": 50}]
        }))
        .expect_err("impossible floors should be refused");
        assert!(refusal.contains("110"), "should do the sum: {refusal}");

        assert!(budget(json!({
            "total": 100,
            "items": [{"id": "a", "label": "A"}, {"id": "a", "label": "B"}]
        }))
        .is_err());
        assert!(budget(json!({"total": 100, "items": [{"id": "a"}]})).is_err());
        assert!(budget(json!({
            "total": 100,
            "items": [{"id": "a", "label": "A", "min": -1}]
        }))
        .is_err());
        assert!(budget(json!({"total": 100, "items": items, "step": 0})).is_err());
        assert!(budget(json!({"total": 100, "items": items, "step": 200})).is_err());
        assert!(budget(json!({"total": 100, "items": items, "requireTotal": "yes"})).is_err());

        assert!(is_known_component("AllocateBudget"));
    }

    #[test]
    fn validates_delegated_web_tasks_a_person_could_work_through() {
        let web = |props: Value| validate_props("WebTask", &props);
        let item = json!({
            "id": "renew-car",
            "title": "Renew the car insurance",
            "url": "https://portal.example.com/renew/8842",
            "note": "Quote is at step 3.",
            "done": "a policy number is on screen"
        });

        assert!(web(json!({"items": [item.clone()]})).is_ok());
        // A single local tool is a legitimate target, and the loopback exception is the reason.
        assert!(web(json!({
            "items": [{"id": "a", "title": "Tidy the inbox", "url": "http://localhost:8000/inbox"}]
        }))
        .is_ok());
        assert!(web(json!({
            "items": [item.clone()],
            "openIn": "browser",
            "autoAdvance": false,
            "allowSkip": true,
            "submitLabel": "Send back"
        }))
        .is_ok());

        assert!(web(json!({"items": []})).is_err());
        assert!(web(json!({})).is_err());

        // Every way an item can be unrenderable, refused where it can still be explained.
        assert!(web(json!({"items": [{"title": "x", "url": "https://a.example"}]})).is_err());
        assert!(web(json!({"items": [{"id": "a", "title": "", "url": "https://a.example"}]})).is_err());
        assert!(web(json!({"items": [{"id": "a", "title": "x"}]})).is_err());
        assert!(web(json!({"items": [{"id": "a", "title": "x", "url": "http://a.example"}]})).is_err());
        assert!(web(json!({
            "items": [{"id": "a", "title": "x", "url": "javascript:alert(1)"}]
        }))
        .is_err());
        assert!(web(json!({
            "items": [{"id": "a", "title": "x", "url": "file:///etc/passwd"}]
        }))
        .is_err());
        // Two rows with one id cannot be reported on separately, and the human's progress would
        // land on whichever of them the canvas found first.
        assert!(web(json!({"items": [item.clone(), item.clone()]})).is_err());
        assert!(web(json!({"items": [item], "openIn": "sideways"})).is_err());

        let many: Vec<Value> = (0..WEBTASK_ITEM_LIMIT + 1)
            .map(|i| json!({"id": format!("t{i}"), "title": "x", "url": "https://a.example"}))
            .collect();
        let refusal = web(json!({"items": many})).expect_err("a list nobody can see the end of");
        assert!(refusal.contains(&WEBTASK_ITEM_LIMIT.to_string()));
    }

    #[test]
    fn validates_a_session_before_anything_is_handed_over() {
        let web = |session: Value| {
            validate_props(
                "WebTask",
                &json!({
                    "items": [{"id": "a", "title": "x", "url": "https://bank.example/x"}],
                    "session": session
                }),
            )
        };

        let cookie = json!({
            "name": "sid", "value": "v", "domain": ".bank.example",
            "path": "/", "secure": true, "httpOnly": true, "sameSite": "lax"
        });
        assert!(web(json!({
            "label": "your bank login",
            "cookies": [cookie.clone()],
            "origins": [{"origin": "https://bank.example", "localStorage": [{"name": "t", "value": "1"}]}]
        }))
        .is_ok());

        // A session has to name where it goes: that list is what the human is shown, and a
        // payload with nothing to show cannot be consented to.
        assert!(web(json!({"label": "somewhere"})).is_err());
        assert!(web(json!({"origins": []})).is_err());
        // A cookie with no domain could be placed at whichever host the card happened to open.
        assert!(web(json!({
            "cookies": [{"name": "sid", "value": "v"}]
        }))
        .is_err());
        assert!(web(json!({
            "cookies": [{"name": "", "value": "v", "domain": "a.example"}]
        }))
        .is_err());
        assert!(web(json!({
            "cookies": [{"name": "a", "value": "v", "domain": ""}]
        }))
        .is_err());
        assert!(web(json!({"cookies": "lots"})).is_err());
        assert!(web(json!({"origins": [{"localStorage": []}]})).is_err());
        assert!(web(json!({"origins": [{"origin": "https://a.example", "localStorage": [{}]}]})).is_err());

        let too_many: Vec<Value> = (0..WEBTASK_SESSION_COOKIE_LIMIT + 1)
            .map(|i| json!({"name": format!("c{i}"), "value": "v", "domain": "a.example"}))
            .collect();
        assert!(web(json!({"cookies": too_many})).is_err());

        // A payload big enough to be a scrape rather than a session.
        let huge = "x".repeat(WEBTASK_SESSION_BYTES_LIMIT + 1);
        assert!(web(json!({
            "origins": [{"origin": "https://a.example", "localStorage": [{"name": "t", "value": huge}]}]
        }))
        .is_err());
    }

    #[test]
    fn validates_signature_requests() {
        let sign = |props: Value| validate_props("ESign", &props);
        let field = json!({
            "id": "sig", "page": 3, "kind": "signature", "label": "Sign here",
            "x": 0.12, "y": 0.72, "w": 0.3, "h": 0.06, "required": true
        });

        assert!(sign(json!({"url": "https://sign.example.com/envelope/9f3"})).is_ok());
        let pdf = format!("data:application/pdf;base64,{}", "A".repeat(2048));
        assert!(sign(json!({
            "document": {"src": pdf, "filename": "lease.pdf", "mime": "application/pdf"},
            "fields": [field.clone()],
            "useAcroForm": true,
            "flatten": true,
            "signer": {"name": "A Person", "email": "a@b.example"}
        }))
        .is_ok());

        // Neither target: nothing to sign, so nothing to ask. Both targets: the card would have
        // to choose which one the human is signing, and it is not the card's choice to make.
        assert!(sign(json!({})).is_err());
        let both = sign(json!({
            "url": "https://sign.example.com/envelope/9f3",
            "document": {"src": format!("data:application/pdf;base64,{}", "A".repeat(2048))}
        }))
        .expect_err("two targets in one card");
        assert!(both.contains("not both"), "{both}");
        assert!(sign(json!({"url": "http://sign.example.com/x"})).is_err());
        assert!(sign(json!({"document": {"src": "data:text/html,<b>hi</b>"}})).is_err());
        assert!(sign(json!({"document": {"src": "file:///tmp/lease.pdf"}})).is_err());
        assert!(sign(json!({"document": {}})).is_err());
        assert!(sign(json!({"document": "lease.pdf"})).is_err());

        // A field the canvas could not draw, refused by name.
        assert!(sign(json!({
            "url": "https://sign.example.com/x",
            "fields": [{"id": "a", "kind": "hovercraft", "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}]
        }))
        .is_err());
        assert!(sign(json!({"url": "https://sign.example.com/x", "fields": [field.clone()], "nope": 1})).is_ok());
        assert!(sign(json!({
            "url": "https://sign.example.com/x",
            "fields": [{"id": "a", "kind": "text", "page": 0, "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}]
        }))
        .is_err());
        assert!(sign(json!({
            "url": "https://sign.example.com/x",
            "fields": [{"id": "a", "kind": "text", "x": 1.4, "y": 0.1, "w": 0.1, "h": 0.1}]
        }))
        .is_err());
        assert!(sign(json!({
            "url": "https://sign.example.com/x",
            "fields": [{"id": "", "kind": "text", "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}]
        }))
        .is_err());

        // Bytes too large to travel inside a frame, said so rather than truncated.
        let enormous = format!("data:application/pdf;base64,{}", "A".repeat(ESIGN_DOCUMENT_BYTES_LIMIT * 2));
        let refusal = sign(json!({"document": {"src": enormous}})).expect_err("too big to carry");
        assert!(refusal.contains("send a link"), "{refusal}");

        assert!(is_known_component("WebTask"));
        assert!(is_known_component("ESign"));
    }
}
