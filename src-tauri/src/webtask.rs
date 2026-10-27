//! Delegated web tasks: the embedded browser a `WebTask` or `ESign` card drives.
//!
//! A card of either kind is not answered by a press, it is answered by *doing something* on a
//! real site — renewing an insurance policy, finishing a checkout, signing a lease. So the
//! canvas needs a webview, and the human needs it to arrive already logged in, because the
//! whole point of delegating the boring part is not to log in twice.
//!
//! Three decisions are worth stating out loud, because each one was a choice:
//!
//! **It is a child webview inside the overlay, not a second window and not an iframe.** An
//! iframe is refused by `X-Frame-Options` on most of the sites worth delegating to; a second
//! window is a second thing to manage on someone's desktop; and the embedded view is what lets
//! the card stay the one surface: the agent's sentence, the toolbar, the page, the notes, in
//! that order, inside one card that grows.
//!
//! **The session is injected before the first navigation**, because a protected page that
//! loads logged out bounces to a login form and the human has already lost. Cookies go in
//! through the cookie API (so `HttpOnly` works and `document.cookie` is not involved) and
//! `localStorage` goes in through an initialization script, which is the only hook that runs
//! after the JS global exists but before the page's own scripts do. Both are origin-guarded:
//! the script looks up `window.location.origin` and writes nothing when it has no entry.
//!
//! **Every run gets its own data directory**, and it is deleted when the card is done with
//! unless the human said to keep the login. Two runs of two tasks never share a cookie jar, so
//! a bank session cannot leak into the next task an agent hands over.
//!
//! The other half of this module is what it *refuses*: no scheme but `https` (plus `http` on
//! loopback, because a local tool is a legitimate target), no navigation away from those, and
//! no IPC for the child webview at all. The canvas is the only webview in this process that
//! may talk to the app, and `lib.rs` enforces that on every command rather than trusting the
//! capability file alone.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::cookie::{Cookie, SameSite};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

use crate::bridge::{log, log_error};
use crate::MAIN_WINDOW;

/// Emitted to the canvas whenever the embedded view moves: a navigation, a page load, a title.
pub const WEBTASK_EVENT: &str = "auraui://webtask";

/// Prefix of every child webview label. Also the thing the command guard refuses to answer.
pub const WEBTASK_LABEL_PREFIX: &str = "webtask-";

/// How many child webviews may exist at once.
///
/// One per card is the design, and the canvas only ever shows one card, but a human can leave
/// several unfinished tasks behind them. The cap is here so a misbehaving agent cannot ask for
/// a thousand embedded browsers; the canvas is told when it is reached rather than silently
/// getting a window it did not ask for.
pub const WEBTASK_LIMIT: usize = 8;

/// The fewest pixels worth embedding. Below this the page is a sliver and the human is better
/// off in their own browser, which the card offers instead.
const MIN_VIEW_PX: f64 = 200.0;

/* ------------------------------------------------------------------ *
 * Payloads from the canvas
 * ------------------------------------------------------------------ */

/// Where the card wants the embedded view, in CSS pixels relative to the window.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn clamped(self) -> Self {
        Self {
            x: self.x.max(0.0),
            y: self.y.max(0.0),
            width: self.width.max(MIN_VIEW_PX),
            height: self.height.max(MIN_VIEW_PX),
        }
    }
}

/// One cookie the agent wants carried into the embedded view.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub same_site: Option<String>,
    /// Unix seconds. Absent means a session cookie, which is the honest default: the session
    /// lives as long as this run does.
    #[serde(default)]
    pub expires: Option<i64>,
}

/// One `localStorage` entry, as a pair rather than an object because that is the shape it is
/// written back out in and the shape Playwright's `storageState` uses.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageItem {
    pub name: String,
    pub value: String,
}

/// One origin's `localStorage`, seeded before the page's own scripts run.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOrigin {
    pub origin: String,
    #[serde(default)]
    pub local_storage: Vec<StorageItem>,
}

/// What the agent hands over so the human picks up where it left off.
///
/// The shape is deliberately `storageState`-shaped (cookies plus per-origin localStorage) so an
/// agent that was driving a browser itself can dump what it had instead of inventing a format.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSession {
    /// What to call this session on the consent sheet: "your bank login", "the cart you built".
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub cookies: Vec<SessionCookie>,
    #[serde(default)]
    pub origins: Vec<SessionOrigin>,
}

impl WebSession {
    /// Every origin named by the cookie domains and the storage entries, deduplicated.
    ///
    /// This is what the consent sheet shows and what the guard checks the item URLs against, so
    /// it deliberately does not include the item's own URL: the question being answered is
    /// "whose session is being handed over", and the answer has to be self-contained.
    pub fn origins(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for origin in &self.origins {
            if seen.insert(origin.origin.clone()) {
                out.push(origin.origin.clone());
            }
        }
        for cookie in &self.cookies {
            if seen.insert(cookie.domain.clone()) {
                out.push(cookie.domain.clone());
            }
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.cookies.is_empty() && self.origins.is_empty()
    }
}

/// An open request from a card: which item, which session, and where to put the view.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub task_id: String,
    /// The item inside the card, echoed back so the canvas can tell which row is live.
    #[serde(default)]
    pub item_id: Option<String>,
    pub url: String,
    #[serde(default)]
    pub session: Option<WebSession>,
    #[serde(default)]
    pub rect: Option<Rect>,
}

/// What the canvas is told about an embedded view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebTaskView {
    pub task_id: String,
    pub label: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    /// How many cookies were actually placed. The card says so, so a session that silently
    /// failed to inject is visible rather than looking like a login the human has to redo.
    pub injected: usize,
    /// The item this session is showing, so a queue can follow the embedded view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
}

/// Whether this machine can embed a page at all, and if not, why not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebTaskCapability {
    pub embedded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Pushed to the canvas as the embedded view navigates.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebTaskStatus {
    pub task_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    /// Set when a navigation was refused, so the card can say so instead of appearing frozen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

/* ------------------------------------------------------------------ *
 * URL policy
 * ------------------------------------------------------------------ */

/// Check a URL an agent wants the human to open.
///
/// The policy itself lives in [`crate::protocol::url_is_allowed`], because the bridge has to
/// apply it before a card exists and the shell has to apply it again before a window exists —
/// and two copies of a rule about which addresses may be opened is one copy too many. What this
/// adds is the parsed URL the runtime needs.
pub fn parse_web_url(raw: &str) -> Result<Url, String> {
    crate::protocol::url_is_allowed(raw)?;
    Url::parse(raw).map_err(|e| format!("`{raw}` is not a URL: {e}"))
}

/// Whether a page the embedded view is navigating to is allowed to load.
///
/// Kept separate from [`parse_web_url`] because a running page navigates on its own: a form
/// POST, a redirect, a `mailto:` a human clicked. `about:` and `blob:` are allowed because that
/// is how a page draws its own content; everything else goes back through the same policy. A
/// refusal is reported to the card, so it can say what happened rather than appearing frozen on
/// the last good page.
pub fn allowed_navigation(url: &Url) -> Result<(), String> {
    match url.scheme() {
        "about" | "blob" => Ok(()),
        _ => crate::protocol::url_is_allowed(url.as_str())
            .map_err(|_| format!("the page tried to navigate to `{}`", url.scheme())),
    }
}

/* ------------------------------------------------------------------ *
 * The manager
 * ------------------------------------------------------------------ */

/// One live embedded view, and what it will take to undo it.
struct Session {
    label: String,
    webview: Webview,
    data_dir: PathBuf,
    /// Only the cookies we placed, so cleanup deletes ours and nothing the page set itself.
    injected: Vec<InjectedCookie>,
    item_id: Option<String>,
    title: String,
}

struct InjectedCookie {
    name: String,
    domain: String,
    path: String,
}

/// Every embedded view in this process, keyed by the task that asked for it.
#[derive(Default)]
pub struct WebTaskManager {
    sessions: Mutex<HashMap<String, Session>>,
    counter: AtomicU64,
}

impl WebTaskManager {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        // A poisoned lock means a previous holder panicked. Nothing here is worth taking the
        // process down over, and the map is still usable, so the poison is stepped over.
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Open (or re-point) the embedded view for a task.
    ///
    /// Reusing the view for the same task is the point: a list of tasks that all need the same
    /// login logs in once, because the second item navigates the browser the human already
    /// signed into rather than starting a fresh one.
    pub fn open(&self, app: &AppHandle, request: OpenRequest) -> Result<WebTaskView, String> {
        let url = parse_web_url(&request.url)?;
        let rect = request.rect.unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 960.0,
            height: 640.0,
        });

        let canvas_label = canvas_webview_label(app);
        let host = host_webview(app, &canvas_label)?;

        if let Some(existing) = self.lock().get(&request.task_id) {
            let webview = existing.webview.clone();
            let label = existing.label.clone();
            let already: HashSet<(String, String, String)> = existing
                .injected
                .iter()
                .map(|c| (c.name.clone(), c.domain.clone(), c.path.clone()))
                .collect();

            let injected = match request.session.as_ref() {
                Some(session) if !session.is_empty() => {
                    inject_cookies(&webview, session, url.host_str().unwrap_or_default(), &already)?
                }
                _ => 0,
            };

            place_webview(&webview, rect)?;
            webview.show().map_err(|e| format!("could not show the web view: {e}"))?;
            webview
                .navigate(url.clone())
                .map_err(|e| format!("could not open {url}: {e}"))?;
            webview.set_focus().ok();

            if let Some(session) = self.lock().get_mut(&request.task_id) {
                if let Some(item_id) = request.item_id.clone() {
                    session.item_id = Some(item_id);
                }
                for cookie in &request.session.as_ref().map(|s| s.cookies.clone()).unwrap_or_default() {
                    let entry = InjectedCookie {
                        name: cookie.name.clone(),
                        domain: cookie.domain.clone(),
                        path: cookie.path.clone().unwrap_or_else(|| "/".to_string()),
                    };
                    if !already.contains(&(
                        entry.name.clone(),
                        entry.domain.clone(),
                        entry.path.clone(),
                    )) {
                        session.injected.push(entry);
                    }
                }
            }

            return Ok(WebTaskView {
                task_id: request.task_id,
                label,
                url: url.to_string(),
                title: String::new(),
                loading: true,
                injected,
                item_id: request.item_id,
            });
        }

        if self.len() >= WEBTASK_LIMIT {
            return Err(format!(
                "AuraUI is already holding {WEBTASK_LIMIT} embedded web sessions; close one before opening another."
            ));
        }

        let index = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let label = format!("{WEBTASK_LABEL_PREFIX}{index}");
        let data_dir = data_directory(app, &label)?;
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            log_error(format!(
                "webtask: could not create {}: {e}",
                data_dir.display()
            ));
        }

        let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
            .data_directory(data_dir.clone())
            .background_color(tauri::window::Color(17, 17, 19, 255))
            .focused(true)
            .on_navigation({
                let app = app.clone();
                let task_id = request.task_id.clone();
                let reported = Mutex::new(String::new());
                move |url| {
                    match allowed_navigation(url) {
                        Ok(()) => {
                            let mut last = reported.lock().unwrap_or_else(|e| e.into_inner());
                            if *last != url.as_str() {
                                *last = url.as_str().to_string();
                                emit_status(
                                    &app,
                                    WebTaskStatus {
                                        task_id: task_id.clone(),
                                        url: url.to_string(),
                                        title: String::new(),
                                        loading: true,
                                        blocked: None,
                                    },
                                );
                            }
                            true
                        }
                        Err(reason) => {
                            log(format!("webtask: refused navigation for {task_id}: {reason}"));
                            emit_status(
                                &app,
                                WebTaskStatus {
                                    task_id: task_id.clone(),
                                    url: url.to_string(),
                                    title: String::new(),
                                    loading: false,
                                    blocked: Some(reason),
                                },
                            );
                            false
                        }
                    }
                }
            })
            .on_page_load({
                let app = app.clone();
                let task_id = request.task_id.clone();
                move |_webview, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        emit_status(
                            &app,
                            WebTaskStatus {
                                task_id: task_id.clone(),
                                url: payload.url().to_string(),
                                title: String::new(),
                                loading: false,
                                blocked: None,
                            },
                        );
                        // The page's title arrives through `on_document_title_changed` below,
                        // which is where the card gets a name for the page as well as its host.
                    }
                }
            })
            .on_document_title_changed({
                let app = app.clone();
                let task_id = request.task_id.clone();
                let manager_task = request.task_id.clone();
                // The title lives on the session so `state` can report it; the manager is
                // reached through the app state rather than captured, which keeps this closure
                // free of an Arc cycle.
                let handle = app.clone();
                move |_webview, title| {
                    if let Some(manager) = handle.try_state::<WebTaskManager>() {
                        if let Some(session) = manager.lock().get_mut(&manager_task) {
                            session.title = title.clone();
                        }
                    }
                    emit_status(
                        &app,
                        WebTaskStatus {
                            task_id: task_id.clone(),
                            url: String::new(),
                            title,
                            loading: false,
                            blocked: None,
                        },
                    );
                }
            })
            .on_new_window(|_url, _features| {
                // A page that opens its own window (a signing vendor does) is allowed its own
                // window rather than a second embedded view we would have to manage. It has no
                // capability and no IPC, so it is just a browser window like any other.
                tauri::webview::NewWindowResponse::Allow
            });

        if let Some(session) = request.session.as_ref().filter(|s| !s.is_empty()) {
            let script = storage_seed_script(session);
            if let Some(script) = script {
                builder = builder.initialization_script(script);
            }
        }

        let webview = host
            .add_child(
                builder,
                LogicalPosition::new(rect.x, rect.y),
                LogicalSize::new(rect.width, rect.height),
            )
            .map_err(|e| format!("could not embed a web view: {e}"))?;

        let mut injected = Vec::new();
        let mut placed = 0usize;
        if let Some(session) = request.session.as_ref().filter(|s| !s.is_empty()) {
            placed = inject_cookies(
                &webview,
                session,
                url.host_str().unwrap_or_default(),
                &HashSet::new(),
            )?;
            injected = session
                .cookies
                .iter()
                .map(|cookie| InjectedCookie {
                    name: cookie.name.clone(),
                    domain: cookie.domain.clone(),
                    path: cookie.path.clone().unwrap_or_else(|| "/".to_string()),
                })
                .collect();
        }

        // Navigate last: the view was built with the URL so the child exists at the right size,
        // and this is the load that must happen with the cookies already in place.
        if let Err(e) = webview.navigate(url.clone()) {
            log_error(format!("webtask: could not load {url}: {e}"));
        }
        let _ = webview.set_focus();

        let view = WebTaskView {
            task_id: request.task_id.clone(),
            label: label.clone(),
            url: url.to_string(),
            title: String::new(),
            loading: true,
            injected: placed,
            item_id: request.item_id.clone(),
        };

        self.lock().insert(
            request.task_id,
            Session {
                label,
                webview,
                data_dir,
                injected,
                item_id: request.item_id,
                title: String::new(),
            },
        );

        Ok(view)
    }

    /// Move or resize the embedded view to match the card's layout.
    pub fn place(&self, task_id: &str, rect: Rect) -> Result<(), String> {
        let webview = self
            .lock()
            .get(task_id)
            .map(|session| session.webview.clone());
        match webview {
            Some(webview) => place_webview(&webview, rect),
            None => Ok(()),
        }
    }

    /// Show or hide without closing: a card that is not the one on screen must not paint over
    /// the card that is, and a native layer does not participate in CSS layout.
    pub fn set_visible(&self, task_id: &str, visible: bool) -> Result<(), String> {
        let webview = self
            .lock()
            .get(task_id)
            .map(|session| session.webview.clone());
        let Some(webview) = webview else {
            return Ok(());
        };
        if visible {
            webview.show().map_err(|e| format!("could not show the web view: {e}"))
        } else {
            webview.hide().map_err(|e| format!("could not hide the web view: {e}"))
        }
    }

    pub fn navigate(&self, task_id: &str, url: &str) -> Result<WebTaskView, String> {
        let parsed = parse_web_url(url)?;
        let mut guard = self.lock();
        let session = guard
            .get_mut(task_id)
            .ok_or_else(|| format!("no web session is open for `{task_id}`"))?;
        session
            .webview
            .navigate(parsed.clone())
            .map_err(|e| format!("could not open {parsed}: {e}"))?;
        Ok(WebTaskView {
            task_id: task_id.to_string(),
            label: session.label.clone(),
            url: parsed.to_string(),
            title: String::new(),
            loading: true,
            injected: 0,
            item_id: session.item_id.clone(),
        })
    }

    /// Back, forward, reload: the three buttons an embedded view has to own, because it has no
    /// browser chrome of its own.
    pub fn action(&self, task_id: &str, action: &str) -> Result<(), String> {
        let webview = self
            .lock()
            .get(task_id)
            .map(|session| session.webview.clone())
            .ok_or_else(|| format!("no web session is open for `{task_id}`"))?;
        let script = match action {
            "back" => "history.back()",
            "forward" => "history.forward()",
            "reload" => "location.reload()",
            other => {
                return Err(format!(
                    "`{other}` is not a web view action; it takes back, forward or reload."
                ))
            }
        };
        webview
            .eval(script)
            .map_err(|e| format!("could not run {action}: {e}"))
    }

    pub fn state(&self, task_id: &str) -> Option<WebTaskView> {
        let guard = self.lock();
        let session = guard.get(task_id)?;
        Some(WebTaskView {
            task_id: task_id.to_string(),
            label: session.label.clone(),
            url: session.webview.url().map(|u| u.to_string()).unwrap_or_default(),
            title: session.title.clone(),
            loading: false,
            injected: session.injected.len(),
            item_id: session.item_id.clone(),
        })
    }

    /// Close one embedded view and clean up after it.
    ///
    /// `keep_session` is the human's answer to "keep me signed in for this list". Cleaning up by
    /// default is the whole reason the consent sheet is a fair trade: a session handed over for
    /// one task does not stay behind on the disk afterwards.
    pub fn close(&self, task_id: &str, keep_session: bool) {
        let session = self.lock().remove(task_id);
        let Some(session) = session else {
            return;
        };

        // Kept means kept. The view is hidden instead of closed, so the login the human asked to
        // keep is still in front of them if the same task comes back; it is still one of the
        // bounded sessions, still cleared by the cap, and still cleaned up for real on shutdown.
        // Deleting a kept session's cookies here would make the control a lie, which is worse
        // than not offering it: the human ticked a box that promised the login would survive.
        if keep_session {
            if let Err(e) = session.webview.hide() {
                log(format!("webtask: could not hide the kept view: {e}"));
            }
            self.lock().insert(task_id.to_string(), session);
            return;
        }

        for cookie in &session.injected {
            let mut builder = Cookie::build((cookie.name.as_str(), ""));
            if !cookie.domain.is_empty() {
                builder = builder.domain(cookie.domain.as_str());
            }
            builder = builder.path(cookie.path.as_str());
            let cookie = builder.build();
            if let Err(e) = session.webview.delete_cookie(cookie) {
                log(format!("webtask: could not clear a cookie on close: {e}"));
            }
        }

        if let Err(e) = session.webview.close() {
            log(format!("webtask: could not close the embedded view: {e}"));
        }

        if let Err(e) = std::fs::remove_dir_all(&session.data_dir) {
            // Not fatal: the directory is inert once the view is gone, and a locked file on a
            // busy engine is not a reason to fail a card the human has finished with.
            log(format!(
                "webtask: could not remove {}: {e}",
                session.data_dir.display()
            ));
        }
    }

    /// Hide every embedded view, without closing any.
    ///
    /// Called when the overlay goes away. A live session survives being hidden — the human may
    /// be coming back to it, and the login is worth more than the pixels.
    pub fn hide_all(&self) {
        for session in self.lock().values() {
            let _ = session.webview.hide();
        }
    }

    /// Close every embedded view. Used on shutdown.
    pub fn close_all(&self) {
        let ids: Vec<String> = self.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id, false);
        }
    }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/// The label of the canvas webview, read from the running app rather than assumed.
///
/// Every command compares the caller against this, so it is worth being exact: if a future
/// version names the canvas webview something else, this follows instead of locking the canvas
/// out of its own commands.
pub fn canvas_webview_label(app: &AppHandle) -> String {
    app.get_webview_window(MAIN_WINDOW)
        .map(|window| window.as_ref().label().to_string())
        .unwrap_or_else(|| MAIN_WINDOW.to_string())
}

/// The host window the canvas lives in, which is also the window a child webview belongs to.
fn host_webview(app: &AppHandle, canvas_label: &str) -> Result<tauri::Window, String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| format!("the `{MAIN_WINDOW}` overlay window is not available"))?;
    // `WebviewWindow::as_ref` is the webview; the window that hosts it is what takes children.
    let _ = canvas_label;
    Ok(window.as_ref().window())
}

/// One directory per run, under the app's own data directory.
fn data_directory(app: &AppHandle, label: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?;
    Ok(base.join(format!("webtask-{label}")))
}

fn place_webview(webview: &Webview, rect: Rect) -> Result<(), String> {
    let rect = rect.clamped();
    webview
        .set_position(LogicalPosition::new(rect.x, rect.y))
        .map_err(|e| format!("could not move the web view: {e}"))?;
    webview
        .set_size(LogicalSize::new(rect.width, rect.height))
        .map_err(|e| format!("could not size the web view: {e}"))
}

/// Build the script that seeds `localStorage` for the origins the agent named.
///
/// Guarded by `window.location.origin` and wrapped in a `try` because it runs on every
/// top-level navigation in this webview, including ones into a different origin, and because a
/// page whose storage is full must not be broken by a failed seed. The map is embedded as JSON
/// rather than interpolated string by string, so a token containing a quote cannot end the
/// string literal and become code.
fn storage_seed_script(session: &WebSession) -> Option<String> {
    let origins: Vec<&SessionOrigin> = session
        .origins
        .iter()
        .filter(|origin| !origin.local_storage.is_empty())
        .collect();
    if origins.is_empty() {
        return None;
    }

    let mut map = serde_json::Map::new();
    for origin in origins {
        let entries: Vec<serde_json::Value> = origin
            .local_storage
            .iter()
            .map(|item| serde_json::json!([item.name, item.value]))
            .collect();
        map.insert(origin.origin.clone(), serde_json::Value::Array(entries));
    }

    let json = serde_json::Value::Object(map).to_string();
    // `<` is escaped so the script can never be read as markup if it is ever echoed somewhere
    // that parses HTML.
    let json = json.replace('<', "\\u003c");

    Some(format!(
        "(function () {{\n  \
           try {{\n    \
             var seeds = {json};\n    \
             var items = seeds[window.location.origin];\n    \
             if (!items) return;\n    \
             for (var i = 0; i < items.length; i++) {{\n      \
               window.localStorage.setItem(items[i][0], items[i][1]);\n    \
             }}\n  \
           }} catch (e) {{}}\n\
         }})();"
    ))
}

/// Put the session's cookies into the webview, for the host being opened.
///
/// Only cookies whose domain covers the target host are placed: a payload naming three sites
/// must not spray bank cookies at a shopping cart. `already` is the set placed by earlier items
/// in the same run, so a queue reusing one webview does not place the same cookie twice.
fn inject_cookies(
    webview: &Webview,
    session: &WebSession,
    host: &str,
    already: &HashSet<(String, String, String)>,
) -> Result<usize, String> {
    let mut placed = 0;
    for cookie in &session.cookies {
        if cookie.name.trim().is_empty() {
            continue;
        }
        let bare = cookie.domain.trim_start_matches('.').to_ascii_lowercase();
        let covered = !bare.is_empty()
            && (host.eq_ignore_ascii_case(&bare) || host.to_ascii_lowercase().ends_with(&format!(".{bare}")));
        if !covered {
            continue;
        }
        let path = cookie.path.clone().unwrap_or_else(|| "/".to_string());
        if already.contains(&(cookie.name.clone(), cookie.domain.clone(), path.clone())) {
            continue;
        }

        let mut builder = Cookie::build((cookie.name.as_str(), cookie.value.as_str()))
            .domain(cookie.domain.as_str())
            .path(path.as_str())
            .secure(cookie.secure)
            .http_only(cookie.http_only);
        if let Some(same_site) = cookie.same_site.as_deref() {
            builder = builder.same_site(match same_site.to_ascii_lowercase().as_str() {
                "strict" => SameSite::Strict,
                "none" => SameSite::None,
                _ => SameSite::Lax,
            });
        }
        if let Some(seconds) = cookie.expires {
            if let Ok(at) = tauri::webview::cookie::time::OffsetDateTime::from_unix_timestamp(seconds) {
                builder = builder.expires(at);
            }
        }

        webview
            .set_cookie(builder.build())
            .map_err(|e| format!("could not hand over a cookie named `{}`: {e}", cookie.name))?;
        placed += 1;
    }
    Ok(placed)
}

fn emit_status(app: &AppHandle, status: WebTaskStatus) {
    let label = canvas_webview_label(app);
    if let Err(e) = app.emit_to(
        EventTarget::Webview { label },
        WEBTASK_EVENT,
        status,
    ) {
        log_error(format!("webtask: could not report web view state: {e}"));
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn refuses_schemes_that_are_not_an_address() {
        for bad in [
            "javascript:alert(1)",
            "data:text/html,<b>hi</b>",
            "file:///etc/passwd",
            "about:blank",
            "ftp://example.com/x.pdf",
            "not a url",
        ] {
            assert!(parse_web_url(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn allows_https_and_loopback_http() {
        for good in [
            "https://portal.example.com/renew/8842",
            "http://localhost:8000/x",
            "http://127.0.0.1:5173/",
            "http://[::1]:9090/",
        ] {
            assert!(parse_web_url(good).is_ok(), "{good} should be allowed");
        }
        assert!(parse_web_url("http://example.com/").is_err());
    }

    #[test]
    fn a_running_page_may_not_leave_https() {
        let ok = Url::parse("https://sign.example.com/envelope/9f3").unwrap();
        assert!(allowed_navigation(&ok).is_ok());
        let downgrade = Url::parse("http://sign.example.com/").unwrap();
        assert!(allowed_navigation(&downgrade).is_err());
        let script = Url::parse("javascript:alert(1)").unwrap();
        assert!(allowed_navigation(&script).is_err());
    }

    #[test]
    fn seeds_storage_as_json_and_never_as_code() {
        let session = WebSession {
            label: Some("a bank login".into()),
            cookies: vec![],
            origins: vec![SessionOrigin {
                origin: "https://bank.example".into(),
                local_storage: vec![StorageItem {
                    name: "token".into(),
                    // A value that would end a naive string literal and start code.
                    value: "\"; alert(1); //".into(),
                }],
            }],
        };
        let script = storage_seed_script(&session).expect("a script for one seeded origin");
        assert!(script.contains("\\\"; alert(1); //"));
        assert!(!script.contains(";\n alert(1)"));
        assert!(script.contains("window.location.origin"));
    }

    #[test]
    fn names_every_origin_a_session_touches() {
        let session = WebSession {
            label: None,
            cookies: vec![SessionCookie {
                name: "sid".into(),
                value: "x".into(),
                domain: ".bank.example".into(),
                path: None,
                secure: true,
                http_only: true,
                same_site: None,
                expires: None,
            }],
            origins: vec![SessionOrigin {
                origin: "https://bank.example".into(),
                local_storage: vec![],
            }],
        };
        // Named origins first — they are what the agent wrote and what the consent sheet leads
        // with — then the domains the cookies came from, so a session that only ever named a
        // cookie domain is still described by where its cookies go.
        assert_eq!(
            session.origins(),
            vec!["https://bank.example".to_string(), ".bank.example".to_string()]
        );
    }

    #[test]
    fn a_rect_never_becomes_a_sliver() {
        let rect = Rect {
            x: -20.0,
            y: -5.0,
            width: 10.0,
            height: 10.0,
        }
        .clamped();
        assert_eq!((rect.x, rect.y), (0.0, 0.0));
        assert_eq!((rect.width, rect.height), (MIN_VIEW_PX, MIN_VIEW_PX));
    }
}
