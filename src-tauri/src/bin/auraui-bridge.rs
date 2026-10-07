//! Headless AuraUI bridge.
//!
//! Runs the same WebSocket server and session logic as the desktop window with no GUI, so
//! agents can talk to AuraUI on a machine with no display, and so the whole loop can be
//! exercised end to end in a terminal or in CI.
//!
//! The stdout sink counts as "attached": a human reading the terminal can see every frame.
//! With `--auto-answer` the bridge answers each task itself, which is how an agent author
//! can verify their wiring without a person in the loop.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use auraui_lib::bridge::{Bridge, BridgeConfig, BridgeHandle, Delivery, UiSink};
use auraui_lib::protocol::{AgentFrame, BridgeStatus, EventName, TaskFrame};
use serde_json::{json, Value};

fn main() {
    let mut addr: Option<String> = None;
    let mut auto_answer = false;
    let mut quiet = false;
    let mut verbose = false;
    let mut delay_ms: u64 = 1500;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--addr" => addr = args.next(),
            "--port" => {
                if let Some(port) = args.next() {
                    addr = Some(format!("127.0.0.1:{port}"));
                }
            }
            "--auto-answer" => auto_answer = true,
            "--delay" => {
                if let Some(ms) = args.next() {
                    delay_ms = ms.parse().unwrap_or(delay_ms);
                }
            }
            "--quiet" => quiet = true,
            "--verbose" | "-v" => verbose = true,
            "--help" | "-h" => {
                print_help();
                return;
            }
            other => eprintln!("[auraui-bridge] ignoring unknown argument {other:?}"),
        }
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("[auraui-bridge] could not start the async runtime: {e}");
            std::process::exit(1);
        }
    };

    let sink = Arc::new(StdoutSink {
        auto_answer,
        quiet,
        verbose,
        delay_ms,
        handle: Mutex::new(None),
        answered: Mutex::new(HashSet::new()),
        runtime: runtime.handle().clone(),
    });

    let mut config = BridgeConfig::new(sink.clone());
    if let Some(a) = addr {
        config = config.with_addr(a);
    }

    let handle = match runtime.block_on(Bridge::start(config)) {
        Ok(handle) => handle,
        Err(e) => {
            eprintln!("[auraui-bridge] {e}");
            std::process::exit(1);
        }
    };

    // The sink needs the handle to answer tasks, and the handle needs the sink to deliver
    // frames: this is the one point where the cycle closes.
    {
        let mut slot = sink
            .handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = Some(handle.clone());
    }

    if !quiet {
        println!("[auraui-bridge] listening on {}", handle.bridge_url());
        println!("[auraui-bridge] session {}", handle.session_id());
        if auto_answer {
            println!("[auraui-bridge] --auto-answer is ON ({delay_ms} ms): tasks answer themselves");
        }
        println!("[auraui-bridge] ready. Ctrl+C to stop.");
    }

    // No `tokio::signal` here on purpose: the `signal` feature is not enabled for this
    // crate, and for a headless helper the process default on SIGINT is correct anyway.
    // Parking the main thread keeps the multi-threaded runtime's workers alive.
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

fn print_help() {
    println!(
        "auraui-bridge - headless AuraUI agent bridge

USAGE:
    auraui-bridge [OPTIONS]

OPTIONS:
    --addr <HOST:PORT>   Address to listen on (default 127.0.0.1:9090,
                         or AURAUI_HOST / AURAUI_PORT from the environment).
    --port <PORT>        Shorthand for --addr 127.0.0.1:<PORT>.
    --auto-answer        Answer every incoming task automatically after --delay ms.
                         Use this to verify an agent end to end with no human present.
    --delay <MS>         Delay before an automatic answer (default 1500).
    --verbose            Also print a status line each time the connection set changes.
    --quiet              Suppress the startup banner and status lines. Frame lines still
                         print, since observing frames is the point of this command.
    -h, --help           Show this help."
    );
}

/* ------------------------------------------------------------------ *
 * Stdout sink
 * ------------------------------------------------------------------ */

struct StdoutSink {
    auto_answer: bool,
    quiet: bool,
    verbose: bool,
    delay_ms: u64,
    /// Filled in right after `Bridge::start` returns; the sink cannot exist without the
    /// bridge, and the bridge cannot answer without the sink.
    handle: Mutex<Option<BridgeHandle>>,
    /// Task ids already auto-answered, so a re-delivered frame cannot produce two answers.
    answered: Mutex<HashSet<String>>,
    runtime: tokio::runtime::Handle,
}

impl UiSink for StdoutSink {
    fn deliver(&self, frame: &AgentFrame) -> Delivery {
        match frame {
            AgentFrame::Task(task) => {
                let instruction = task.instruction.as_deref().unwrap_or("");
                println!(
                    "[task] {} component={} {}",
                    task.task_id, task.component, instruction
                );
                if self.auto_answer {
                    self.schedule_auto_answer(task);
                }
            }
            AgentFrame::Update(update) => {
                println!("[update] {}", update.task_id);
            }
            AgentFrame::Resolve(resolve) => {
                println!(
                    "[resolve] {} {}",
                    resolve.task_id,
                    resolve.reason.as_deref().unwrap_or("")
                );
            }
            AgentFrame::Notify(notify) => {
                println!("[notify] {:?} {}", notify.level, notify.message);
            }
            AgentFrame::Note(note) => {
                println!("[note] {}", note.text);
            }
            AgentFrame::Hello(hello) => {
                println!("[hello] {}", hello.agent.name);
            }
            // Answered with a `pong` by the bridge itself; nothing to show.
            AgentFrame::Ping(_) => {}
        }

        // A terminal printing every frame is a real human-facing surface.
        Delivery::Attached
    }

    fn status(&self, status: &BridgeStatus) {
        if !self.verbose || self.quiet {
            return;
        }
        println!(
            "[status] running={} agents={} received={} emitted={}",
            status.running,
            status.connections.len(),
            status.received,
            status.emitted
        );
    }
}

impl StdoutSink {
    fn schedule_auto_answer(&self, task: &TaskFrame) {
        let Some(event) = auto_event(&task.component, &task.props) else {
            return;
        };
        let payload = auto_payload(&task.component, &task.props);

        {
            let mut answered = self
                .answered
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !answered.insert(task.task_id.clone()) {
                return;
            }
        }

        let handle: Option<BridgeHandle> = {
            let slot = self
                .handle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            slot.as_ref().cloned()
        };
        let Some(handle) = handle else {
            return;
        };

        let task_id = task.task_id.clone();
        let delay = self.delay_ms;
        self.runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let frame = handle.emit_event(&task_id, event, payload);
            eprintln!(
                "[auto-answer] {task_id} -> {} (seq {})",
                frame.event.as_str(),
                frame.seq
            );
        });
    }
}

/// The option list a component offers, if any. An `ActionCard` calls its list `options`; a
/// `Notice` with follow-up buttons calls the same shape `actions`.
fn first_action(component: &str, props: &Value) -> Option<(String, String)> {
    let key = if component == "Notice" { "actions" } else { "options" };
    let first = props.get(key).and_then(Value::as_array)?.first()?;
    let id = first.get("id").and_then(Value::as_str)?.to_string();
    let label = first
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    Some((id, label))
}

/// Which terminal event an automatic answer uses for each component.
///
/// A bare `Notice` is informational and deserves no reply. A `Notice` that carries buttons
/// is a decision though, and a human would click one, so it is answered like an ActionCard.
fn auto_event(component: &str, props: &Value) -> Option<EventName> {
    match component {
        "ActionCard" => Some(EventName::Action),
        "WizardForm" | "SortableList" | "DataGrid" => Some(EventName::Submit),
        "InteractiveChart" => Some(EventName::Filter),
        // Both of these confirm with a submit, like a form: the human picks or decides and
        // then says so, rather than the first press being the answer.
        "RatingScale" | "DiffReview" => Some(EventName::Submit),
        "Notice" if first_action(component, props).is_some() => Some(EventName::Action),
        _ => None,
    }
}

/// A plausible answer built from the task's own data, so the payload shape matches what a
/// real human interaction would produce.
fn auto_payload(component: &str, props: &Value) -> Value {
    match component {
        "ActionCard" | "Notice" => match first_action(component, props) {
            Some((id, label)) => json!({ "actionId": id, "label": label, "source": component }),
            // Only reachable for an ActionCard that arrived with an empty option list, which
            // the protocol validator already rejects.
            None => json!({ "actionId": "auto", "source": component }),
        },
        "WizardForm" => json!({ "component": component, "values": {} }),
        "RatingScale" => {
            let min = props.get("min").and_then(Value::as_i64).unwrap_or(1);
            let max = props.get("max").and_then(Value::as_i64).unwrap_or(min + 4);
            // Answer the preselected point when there is one, so a demo script that sets a
            // `defaultValue` gets the same answer a human who just pressed submit would give.
            let value = props
                .get("defaultValue")
                .and_then(Value::as_i64)
                .unwrap_or(min)
                .clamp(min, max);
            let label = props
                .get("labels")
                .and_then(Value::as_array)
                .and_then(|labels| labels.get((value - min).max(0) as usize))
                .and_then(Value::as_str);
            let mut payload =
                json!({ "component": component, "value": value, "min": min, "max": max });
            if let Some(label) = label {
                payload["label"] = json!(label);
            }
            payload
        }
        "DiffReview" => {
            let accepted: Vec<String> = props
                .get("hunks")
                .and_then(Value::as_array)
                .map(|hunks| {
                    hunks
                        .iter()
                        .filter_map(|hunk| hunk.get("id").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            // Accept everything: the shape of the answer is what this is testing, and a
            // rejection list would only make the smoke test harder to read.
            let decisions = Value::Object(
                accepted
                    .iter()
                    .map(|id| (id.clone(), json!("accept")))
                    .collect(),
            );
            json!({
                "component": component,
                "decisions": decisions,
                "accepted": accepted,
                "rejected": Vec::<String>::new()
            })
        }
        "SortableList" => {
            let order: Vec<String> = props
                .get("items")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .enumerate()
                        .map(|(index, item)| {
                            item.get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("item_{index}"))
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({ "component": component, "order": order })
        }
        "DataGrid" => {
            let row_ids: Vec<String> = props
                .get("rows")
                .and_then(Value::as_array)
                .and_then(|rows| rows.first())
                .map(|row| {
                    vec![row
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("0")
                        .to_string()]
                })
                .unwrap_or_default();
            json!({ "component": component, "rowIds": row_ids })
        }
        "InteractiveChart" => json!({ "field": "__auto__", "value": Value::Null }),
        _ => json!({ "component": component }),
    }
}
