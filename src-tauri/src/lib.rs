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
//! Tauri converts camelCase arguments from JavaScript to snake_case Rust parameters, so the
//! webview calls `invoke("auraui_emit", { taskId, event, payload })`.

pub mod bridge;
pub mod protocol;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::bridge::{
    log, log_error, offline_status, Bridge, BridgeConfig, BridgeHandle, Delivery, UiSink,
};
use crate::protocol::{AgentFrame, BridgeStatus, EventFrame, EventName};

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
        match self.app.emit(FRAME_EVENT, frame.clone()) {
            Ok(()) => Delivery::Attached,
            Err(e) => {
                // Treat a failed emit as "nobody saw it" rather than losing the frame.
                log_error(format!("could not push a frame to the window: {e}"));
                Delivery::Queued
            }
        }
    }

    fn status(&self, status: &BridgeStatus) {
        if let Err(e) = self.app.emit(STATUS_EVENT, status.clone()) {
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
 * Commands
 * ------------------------------------------------------------------ */

/// The human answered a task. Forwards the interaction to every connected agent and returns
/// the stamped event so the caller can log exactly what the agent will see.
#[tauri::command]
fn auraui_emit(
    state: tauri::State<'_, Arc<BridgeState>>,
    task_id: String,
    event: EventName,
    payload: Value,
) -> Result<EventFrame, String> {
    let handle = current_handle(state.inner())
        .ok_or_else(|| "the AuraUI bridge is not running yet".to_string())?;
    Ok(handle.emit_event(&task_id, event, payload))
}

/// Current connection state, safe to poll at any time (including before the bridge is up).
#[tauri::command]
fn auraui_status(state: tauri::State<'_, Arc<BridgeState>>) -> BridgeStatus {
    current_handle(state.inner())
        .map(|handle| handle.status())
        .unwrap_or_else(offline_status)
}

/// The window mounted and can render. Flips the sink to attached, replays anything that was
/// queued while it was loading, then pushes a fresh status.
#[tauri::command]
fn auraui_attach(app: tauri::AppHandle, state: tauri::State<'_, Arc<BridgeState>>) {
    state.attached.store(true, Ordering::SeqCst);

    let Some(handle) = current_handle(state.inner()) else {
        // Bridge still starting: the sink will see `attached` once it exists.
        let _ = app.emit(STATUS_EVENT, offline_status());
        return;
    };

    for frame in handle.drain_pending() {
        if let Err(e) = app.emit(FRAME_EVENT, frame) {
            log_error(format!("could not flush a queued frame: {e}"));
        }
    }
    let _ = app.emit(STATUS_EVENT, handle.status());
}

/// The window is hidden or closing. Frames are queued again instead of emitted into a
/// webview nobody is looking at.
#[tauri::command]
fn auraui_detach(state: tauri::State<'_, Arc<BridgeState>>) {
    state.attached.store(false, Ordering::SeqCst);
    if let Some(handle) = current_handle(state.inner()) {
        handle.notify_status();
    }
}

/// Show or hide the overlay window.
///
/// `active` is true whenever the canvas has a question to put in front of the human, and
/// false when it has none. Hiding rather than click-through is deliberate: an invisible
/// window cannot block the desktop, and a frameless overlay parked on top of everything is
/// the thing users hate most about this class of app.
#[tauri::command]
fn auraui_set_overlay(app: tauri::AppHandle, active: bool) -> Result<(), String> {
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
 * Entry point
 * ------------------------------------------------------------------ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(BridgeState::new()))
        .invoke_handler(tauri::generate_handler![
            auraui_emit,
            auraui_status,
            auraui_attach,
            auraui_detach,
            auraui_set_overlay
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
