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
pub enum NoticeLevel {
    Info,
    Success,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NotifyFrame {
    #[serde(default = "protocol_version")]
    pub v: String,
    pub level: NoticeLevel,
    pub message: String,
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
    Notify(NotifyFrame),
    Note(NoteFrame),
    Ping(PingFrame),
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
    pub payload: Value,
    pub seq: u64,
    /// Unix epoch milliseconds, stamped by the bridge rather than trusted from the webview.
    pub at: u64,
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
pub const COMPONENT_NAMES: [&str; 8] = [
    "ActionCard",
    "Notice",
    "WizardForm",
    "SortableList",
    "DataGrid",
    "InteractiveChart",
    "RatingScale",
    "DiffReview",
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
            json!({"type":"notify","level":"warn","message":"careful"}),
            json!({"type":"note","text":"thinking","kind":"thinking"}),
            json!({"type":"ping"}),
        ];
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
}
