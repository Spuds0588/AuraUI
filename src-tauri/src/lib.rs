//! AuraUI — the desktop shell.
//!
//! Wires the agent bridge (see [`bridge`]) into the Tauri window: frames arriving from an
//! agent are emitted to the webview as `auraui://frame`, and the webview reports the
//! human's answers back through the `auraui_emit` command.
//!
//! The window is an overlay, not a normal window: frameless, transparent, always on top and
//! maximised (see `tauri.conf.json`). It has no titlebar, so the canvas draws its own
//! controls, and it hides itself whenever there is nothing to ask the human.
//!
//! Contract for the frontend, all of these names stable:
//!
//! | Tauri           | Direction | Payload                                   |
//! |-----------------|-----------|-------------------------------------------|
//! | `auraui://frame`  | → webview | one [`AgentFrame`] (`task`, `update`, …)  |
//! | `auraui://status` | → webview | [`BridgeStatus`]                          |
//! | `auraui_emit`     | ← webview | `{ taskId, event, payload }` → [`EventFrame`] |
//! | `auraui_status`   | ← webview | → [`BridgeStatus`]                        |
//! | `auraui_attach`   | ← webview | flush queued frames, then → [`BridgeStatus`] |
//! | `auraui_detach`   | ← webview | window is going away: queue instead of emit |
//! | `auraui_set_overlay` | ← webview | `{ active }`: show and focus, or hide the overlay |
//!
//! A delegated web task ([`webtask`]) adds a second kind of webview to this process: a child
//! webview inside the overlay that loads a real site. The canvas is the only webview allowed to
//! talk to the app, and that is enforced twice — once by the capability file, which scopes the
//! IPC layer to the canvas webview, and once by [`guard_canvas`], which refuses any command
//! whose caller is not the canvas.
//!
//! | Tauri                    | Direction | Payload                                   |
//! |--------------------------|-----------|-------------------------------------------|
//! | `auraui://webtask`         | → webview | [`webtask::WebTaskStatus`]                |
//! | `auraui_webtask_capability` | ← webview | → [`webtask::WebTaskCapability`]          |
//! | `auraui_webtask_open`      | ← webview | `{ taskId, itemId, url, session, rect }`  |
//! | `auraui_webtask_place`     | ← webview | `{ taskId, rect }`                        |
//! | `auraui_webtask_set_visible` | ← webview | `{ taskId, visible }`                   |
//! | `auraui_webtask_navigate`  | ← webview | `{ taskId, url }`                         |
//! | `auraui_webtask_action`    | ← webview | `{ taskId, action }`                      |
//! | `auraui_webtask_state`     | ← webview | `{ taskId }` → [`webtask::WebTaskView`]   |
//! | `auraui_webtask_close`     | ← webview | `{ taskId, keepSession }`                 |
//!
//! Tauri converts camelCase arguments from JavaScript to snake_case Rust parameters, so the
//! webview calls `invoke("auraui_emit", { taskId, event, payload })`.

pub mod bridge;
pub mod protocol;
pub mod webtask;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{Emitter, EventTarget, Manager};

use crate::bridge::{
    log, log_error, offline_status, Bridge, BridgeConfig, BridgeHandle, Delivery, UiSink,
};
use crate::protocol::{AgentFrame, BridgeStatus, EventFrame, EventName, ProgressFrame, Signal, WaitState};
use crate::webtask::{Rect, WebSession, WebTaskCapability, WebTaskManager, WebTaskView};

/// Emitted to the webview for every frame an agent sends that the bridge accepted.
pub const FRAME_EVENT: &str = "auraui://frame";
/// Emitted to the webview whenever the connection set or counters change.
pub const STATUS_EVENT: &str = "auraui://status";
/// The label of the single overlay window. Referenced from `setup` and the overlay command.
pub const MAIN_WINDOW: &str = "main";

/* ------------------------------------------------------------------ *
 * UI sink
 * ------------------------------------------------------------------ */

/// Delivers frames into the running webview.
///
/// The `attached` flag is the bridge's definition of "a human can see this". The window
/// flips it through `auraui_attach` / `auraui_detach`; until it is set, the bridge holds
/// frames in its pending queue so nothing is silently lost while the window is loading.
struct WebviewSink {
    app: tauri::AppHandle,
    attached: Arc<AtomicBool>,
}

impl UiSink for WebviewSink {
    fn deliver(&self, frame: &AgentFrame) -> Delivery {
        if !self.attached.load(Ordering::SeqCst) {
            return Delivery::Queued;
        }
        match self.app.emit_to(canvas_target(&self.app), FRAME_EVENT, frame.clone()) {
            Ok(()) => Delivery::Attached,
            Err(e) => {
                // Treat a failed emit as "nobody saw it" rather than losing the frame.
                log_error(format!("could not push a frame to the window: {e}"));
                Delivery::Queued
            }
        }
    }

    fn status(&self, status: &BridgeStatus) {
        if let Err(e) = self.app.emit_to(canvas_target(&self.app), STATUS_EVENT, status.clone()) {
            eprintln!("[auraui] could not push status to the window: {e}");
        }
    }
}

/* ------------------------------------------------------------------ *
 * Shared state
 * ------------------------------------------------------------------ */

/// Held by Tauri as `Arc<BridgeState>`.
pub struct BridgeState {
    /// `None` until `Bridge::start` resolves.
    handle: Mutex<Option<BridgeHandle>>,
    /// Shared with [`WebviewSink`]; the bridge reads it, the commands write it.
    attached: Arc<AtomicBool>,
}

impl BridgeState {
    fn new() -> Self {
        Self {
            handle: Mutex::new(None),
            attached: Arc::new(AtomicBool::new(false)),
        }
    }
}

fn current_handle(state: &BridgeState) -> Option<BridgeHandle> {
    // Tolerate a poisoned lock: a panic while holding it must not make the bridge
    // permanently unreachable from the UI.
    let slot = match state.handle.lock() {
        Ok(slot) => slot,
        Err(poisoned) => poisoned.into_inner(),
    };
    slot.as_ref().cloned()
}

/* ------------------------------------------------------------------ *
 * Overlay window
 * ------------------------------------------------------------------ */

/// Report a cosmetic overlay problem without failing the command that hit it.
///
/// Raising and focusing a window is refused by some Linux compositors while the app is
/// otherwise completely healthy. Turning that into an error would make the canvas give up on
/// something it can work around, so it is logged and the caller carries on.
fn overlay_problem(message: String) {
    log_error(format!("overlay: {message}"));
}

/* ------------------------------------------------------------------ *
 * Who may talk to the app
 * ------------------------------------------------------------------ */

/// Emit only to the canvas webview, never to whatever else this window is hosting.
///
/// A delegated web task puts a real site inside this process as a child webview, and a
/// broadcast would hand that site every frame the agent sent. The canvas is the addressed
/// target for everything on the wire.
fn canvas_target(app: &tauri::AppHandle) -> EventTarget {
    EventTarget::Webview {
        label: webtask::canvas_webview_label(app),
    }
}

/// Refuse a command that did not come from the canvas.
///
/// The canvas is the only webview here that a person is looking at: it renders the agent's
/// question and it is the thing allowed to answer it. An embedded page is the other side of
/// that trust boundary — a site an agent chose, possibly steered by content an agent read — so
/// it must not be able to answer a question on someone's behalf, open a browser session, or
/// read the bridge's status. The capability file scopes the IPC layer to the canvas already;
/// this is the second lock on the same door, and it holds even if the first is loosened.
fn guard_canvas(app: &tauri::AppHandle, webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() == webtask::canvas_webview_label(app) {
        return Ok(());
    }
    let message = format!(
        "the `{}` webview is not the AuraUI canvas and may not answer questions",
        webview.label()
    );
    log_error(format!("guard: {message}"));
    Err(message)
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/// The human answered a task. Forwards the interaction to every connected agent and returns
/// the stamped event so the caller can log exactly what the agent will see.
#[tauri::command]
fn auraui_emit(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<BridgeState>>,
    task_id: String,
    event: EventName,
    payload: Value,
) -> Result<EventFrame, String> {
    guard_canvas(&app, &webview)?;
    let handle = current_handle(state.inner())
        .ok_or_else(|| "the AuraUI bridge is not running yet".to_string())?;
    Ok(handle.emit_event(&task_id, event, payload))
}

/// The canvas checking in on a question that is still unanswered.
///
/// The webview owns the clock and the human's activity; the bridge owns the socket and the
/// stamp. So the canvas sends *what it knows* — how long the card has been up, whether anyone
/// has touched it, and what they have said so far on it — and the envelope, the estimate and
/// the `at` stamp are added here. Splitting it this way keeps one clock in the protocol.
#[tauri::command]
fn auraui_progress(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<BridgeState>>,
    task_id: String,
    phase: WaitState,
    elapsed_ms: u64,
    signals: Vec<Signal>,
) -> Result<ProgressFrame, String> {
    guard_canvas(&app, &webview)?;
    let handle = current_handle(state.inner())
        .ok_or_else(|| "the AuraUI bridge is not running yet".to_string())?;
    Ok(handle.emit_progress(&task_id, phase, elapsed_ms, signals))
}

/// Current connection state, safe to poll at any time (including before the bridge is up).
#[tauri::command]
fn auraui_status(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<BridgeState>>,
) -> Result<BridgeStatus, String> {
    guard_canvas(&app, &webview)?;
    Ok(current_handle(state.inner())
        .map(|handle| handle.status())
        .unwrap_or_else(offline_status))
}

/// The window mounted and can render. Flips the sink to attached, replays anything that was
/// queued while it was loading, then pushes a fresh status.
#[tauri::command]
fn auraui_attach(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<BridgeState>>,
) -> Result<(), String> {
    guard_canvas(&app, &webview)?;
    state.attached.store(true, Ordering::SeqCst);

    let Some(handle) = current_handle(state.inner()) else {
        // Bridge still starting: the sink will see `attached` once it exists.
        let _ = app.emit_to(canvas_target(&app), STATUS_EVENT, offline_status());
        return Ok(());
    };

    for frame in handle.drain_pending() {
        if let Err(e) = app.emit_to(canvas_target(&app), FRAME_EVENT, frame) {
            log_error(format!("could not flush a queued frame: {e}"));
        }
    }
    let _ = app.emit_to(canvas_target(&app), STATUS_EVENT, handle.status());
    Ok(())
}

/// The window is hidden or closing. Frames are queued again instead of emitted into a
/// webview nobody is looking at.
#[tauri::command]
fn auraui_detach(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<BridgeState>>,
) -> Result<(), String> {
    guard_canvas(&app, &webview)?;
    state.attached.store(false, Ordering::SeqCst);
    if let Some(handle) = current_handle(state.inner()) {
        handle.notify_status();
    }
    Ok(())
}

/// Show or hide the overlay window.
///
/// `active` is true whenever the canvas has a question to put in front of the human, and
/// false when it has none. Hiding rather than click-through is deliberate: an invisible
/// window cannot block the desktop, and a frameless overlay parked on top of everything is
/// the thing users hate most about this class of app.
#[tauri::command]
fn auraui_set_overlay(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    active: bool,
) -> Result<(), String> {
    guard_canvas(&app, &webview)?;
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| format!("the `{MAIN_WINDOW}` overlay window is not available"))?;

    if active {
        // Re-asserted on every show rather than only in `setup`: some compositors drop the
        // always-on-top flag when a window is hidden and shown again.
        if let Err(e) = window.set_always_on_top(true) {
            overlay_problem(format!("could not raise the window: {e}"));
        }
        if let Err(e) = window.show() {
            return Err(format!("could not show the overlay: {e}"));
        }
        // Not fatal: a human can still click a window that the compositor refused to focus.
        if let Err(e) = window.set_focus() {
            overlay_problem(format!("could not focus the window: {e}"));
        }
    } else if let Err(e) = window.hide() {
        return Err(format!("could not hide the overlay: {e}"));
    }

    // An embedded web task paints above the canvas and does not follow the overlay's
    // visibility on its own, so hiding the window has to take it down too. It is hidden, not
    // closed: the human's half-finished checkout is still there when the overlay comes back.
    if !active {
        app.state::<WebTaskManager>().hide_all();
    }

    Ok(())
}

/* ------------------------------------------------------------------ *
 * Microphone
 * ------------------------------------------------------------------ */

/// Let the canvas open the microphone, and nothing else.
///
/// WebKitGTK never prompts for `getUserMedia`: it hands every request to the embedding
/// application and *denies* it unless that application answers the signal. Leave this out and
/// the voice button is a control that looks live and does nothing, which is worse than not
/// drawing it. So the request is answered here.
///
/// Microphone only, and audio only. The canvas has no camera, no location and no use for a
/// notification, so those requests are left to WebKit's own default rather than answered by
/// an application that was never asked. A window that says yes to everything is not one to
/// leave running on a desktop.
#[cfg(target_os = "linux")]
fn allow_microphone_requests(window: &tauri::WebviewWindow) {
    use webkit2gtk::glib::prelude::Cast;
    use webkit2gtk::{
        PermissionRequestExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt,
        WebViewExt,
    };

    let attached = window.with_webview(|webview| {
        webview.inner().connect_permission_request(|_, request| {
            let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                // Some other kind of request. Not ours to answer.
                return false;
            };

            if media.is_for_audio_device() && !media.is_for_video_device() {
                media.allow();
                log("voice: microphone allowed for the canvas");
            } else {
                media.deny();
                log_error("voice: refused a media request that was not microphone-only");
            }
            // Handled either way, so WebKit does not fall back to its own denial for the
            // requests we deliberately allowed.
            true
        });
    });

    if let Err(e) = attached {
        log_error(format!(
            "voice: could not reach the webview to allow the microphone: {e}"
        ));
    }
}

/* ------------------------------------------------------------------ *
 * Delegated web tasks
 * ------------------------------------------------------------------ */

/// Can this machine embed a page for a delegated web task?
///
/// The canvas asks before it offers an embedded view, because the alternative is a control
/// that looks live and does nothing. Today the answer is always yes on desktop; the ACK shape
/// exists so a build without the `unstable` webview APIs can answer no and have the cards fall
/// back to "open it in your browser", which is a real answer rather than a broken button.
#[tauri::command]
fn auraui_webtask_capability(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<WebTaskCapability, String> {
    guard_canvas(&app, &webview)?;
    Ok(WebTaskCapability {
        embedded: true,
        reason: None,
    })
}

/// Open the embedded view for one item of a delegated web task.
///
/// Called only after the human has approved handing over the session, which is the canvas's
/// job: the sheet that names the origins is drawn in the card, and this side is told the
/// answer. One view per task, reused for every item, so a queue that needs one login logs in
/// once.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn auraui_webtask_open(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    manager: tauri::State<'_, WebTaskManager>,
    task_id: String,
    url: String,
    item_id: Option<String>,
    session: Option<WebSession>,
    rect: Option<Rect>,
) -> Result<WebTaskView, String> {
    guard_canvas(&app, &webview)?;
    manager.open(
        &app,
        crate::webtask::OpenRequest {
            task_id,
            item_id,
            url,
            session,
            rect,
        },
    )
}

/// Move or resize the embedded view to match the card's layout.
#[tauri::command]
fn auraui_webtask_place(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    manager: tauri::State<'_, WebTaskManager>,
    task_id: String,
    rect: Rect,
) -> Result<(), String> {
    guard_canvas(&app, &webview)?;
    manager.place(&task_id, rect)
}

/// Show or hide the embedded view without closing it.
#[tauri::command]
fn auraui_webtask_set_visible(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    manager: tauri::State<'_, WebTaskManager>,
    task_id: String,
    visible: bool,
) -> Result<(), String> {
    guard_canvas(&app, &webview)?;
    manager.set_visible(&task_id, visible)
}

/// Point the embedded view at another address: the next item in a queue, or a link the card
/// offers. The URL goes through the same scheme policy as the first one.
#[tauri::command]
fn auraui_webtask_navigate(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    manager: tauri::State<'_, WebTaskManager>,
    task_id: String,
    url: String,
) -> Result<WebTaskView, String> {
    guard_canvas(&app, &webview)?;
    manager.navigate(&task_id, &url)
}

/// Back, forward or reload. An embedded view has no browser chrome, so the card draws these.
#[tauri::command]
fn auraui_webtask_action(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    manager: tauri::State<'_, WebTaskManager>,
    task_id: String,
    action: String,
) -> Result<(), String> {
    guard_canvas(&app, &webview)?;
    manager.action(&task_id, &action)
}

/// Where the embedded view currently is, for a card that has just mounted over one that is
/// already open (a second item in the same list, or a resend of the same task).
#[tauri::command]
fn auraui_webtask_state(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    manager: tauri::State<'_, WebTaskManager>,
    task_id: String,
) -> Result<Option<WebTaskView>, String> {
    guard_canvas(&app, &webview)?;
    Ok(manager.state(&task_id))
}

/// Close the embedded view and clean up after it.
///
/// `keep_session` is the human's answer to "keep me signed in for this list". Without it the
/// cookies handed over for this run are deleted and the run's own data directory is removed,
/// so the default is that nothing of someone's session outlives the task it was lent for.
#[tauri::command]
fn auraui_webtask_close(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    manager: tauri::State<'_, WebTaskManager>,
    task_id: String,
    keep_session: bool,
) -> Result<(), String> {
    guard_canvas(&app, &webview)?;
    manager.close(&task_id, keep_session);
    Ok(())
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(BridgeState::new()))
        .manage(WebTaskManager::default())
        .invoke_handler(tauri::generate_handler![
            auraui_emit,
            auraui_progress,
            auraui_status,
            auraui_attach,
            auraui_detach,
            auraui_set_overlay,
            auraui_webtask_capability,
            auraui_webtask_open,
            auraui_webtask_place,
            auraui_webtask_set_visible,
            auraui_webtask_navigate,
            auraui_webtask_action,
            auraui_webtask_state,
            auraui_webtask_close
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state = app.state::<Arc<BridgeState>>().inner().clone();

            // Say where the bridge *will* be before it exists, so the window can render
            // "starting" rather than an empty canvas with no explanation.
            let _ = app_handle.emit(STATUS_EVENT, offline_status());

            // Start above whatever the human is working in, from the very first frame.
            // The frontend owns when the overlay hides itself; hiding here would leave a
            // first-run user staring at an empty desktop with no idea the app had started.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                if let Err(e) = window.set_always_on_top(true) {
                    overlay_problem(format!("could not start on top: {e}"));
                }

                // The voice button on a question that needs words. WebKit will not open the
                // microphone until the app answers its permission signal, and the answer has
                // to be installed before the first `getUserMedia` call rather than after.
                #[cfg(target_os = "linux")]
                allow_microphone_requests(&window);
            }

            let attached = state.attached.clone();
            tauri::async_runtime::spawn(async move {
                let sink: Arc<dyn UiSink> = Arc::new(WebviewSink {
                    app: app_handle.clone(),
                    attached,
                });

                match Bridge::start(BridgeConfig::new(sink)).await {
                    Ok(handle) => {
                        log(format!("bridge ready on {}", handle.bridge_url()));
                        {
                            let mut slot = match state.handle.lock() {
                                Ok(slot) => slot,
                                Err(poisoned) => poisoned.into_inner(),
                            };
                            *slot = Some(handle.clone());
                        }
                        // The window may already be mounted and attached; either way a fresh
                        // status tells it the bridge is live.
                        let _ = app_handle.emit(STATUS_EVENT, handle.status());
                    }
                    Err(e) => {
                        log_error(format!("bridge failed to start: {e}"));
                        let _ = app_handle.emit(STATUS_EVENT, offline_status());
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the AuraUI window");
}
