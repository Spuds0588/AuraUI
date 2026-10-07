"""The AuraUI agent client.

An agent connects to a local AuraUI window over a WebSocket, summons an interactive
component, and blocks until the human answers::

    from auraui import Agent, components as c

    with Agent(name="release-bot") as agent:
        answer = agent.task(
            component="ActionCard",
            instruction="Deploy 2026.10.4 failed twice on staging. How do you want to proceed?",
            props=c.action_card([
                c.option("investigate", "Investigate the diff", variant="primary"),
                c.option("rollback", "Roll back", variant="destructive"),
            ]),
        )
        print(answer["payload"]["actionId"])

The API is deliberately synchronous. An agent script is a sequence of questions, and a
reader thread plus a pending map keeps that shape while still reacting to events that
arrive out of band (progress signals, a dropped connection).
"""

from __future__ import annotations

import json
import random
import threading
from typing import Any, Callable, Dict, List, Optional, Sequence

from ._ws import ConnectionClosed, HandshakeError, RawWebSocket, WebSocketError
from .protocol import (
    DEFAULT_URL,
    MAX_FRAME_BYTES,
    TERMINAL_EVENTS,
    AuraUIError,
    ConnectionLost,
    ProtocolViolation,
    TaskTimeout,
    frame,
    hello_frame,
    identity,
    new_task_id,
)

Handler = Callable[..., None]


class _Pending:
    """One task awaiting a human answer."""

    __slots__ = ("done", "result", "error", "signals")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: Optional[Dict[str, Any]] = None
        self.error: Optional[BaseException] = None
        self.signals: List[Dict[str, Any]] = []

    def resolve(self, answer: Dict[str, Any]) -> None:
        self.result = answer
        self.done.set()

    def fail(self, error: BaseException) -> None:
        if not self.done.is_set():
            self.error = error
            self.done.set()


class Agent:
    """A connection to the AuraUI bridge.

    :param name: Human-readable agent name, shown in the AuraUI window.
    :param version: Optional agent version, also shown to the human.
    :param vendor: Optional vendor string.
    :param url: Bridge address. Defaults to ``ws://127.0.0.1:9090``.
    :param reconnect: Reconnect with exponential backoff and jitter after a drop.
    :param capabilities: Free-form labels describing what this agent can do.
    :param connect_timeout: Seconds to wait for the socket and for ``welcome``.
    """

    def __init__(
        self,
        name: str,
        version: Optional[str] = None,
        vendor: Optional[str] = None,
        url: str = DEFAULT_URL,
        reconnect: bool = True,
        capabilities: Optional[Sequence[str]] = None,
        connect_timeout: float = 10.0,
    ) -> None:
        self.identity = identity(name, version, vendor, capabilities)
        self.url = url
        self.reconnect = bool(reconnect)
        self._connect_timeout = connect_timeout

        self._ws: Optional[RawWebSocket] = None
        self._reader: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._connected = threading.Event()
        self._welcome_event = threading.Event()
        self._closed_by_user = False

        self._welcome: Optional[Dict[str, Any]] = None
        self._session_id: Optional[str] = None
        self._server: Optional[Dict[str, Any]] = None
        self._seq: Optional[int] = None
        self._gaps = 0
        self._reconnect_attempts = 0

        self._pending: Dict[str, _Pending] = {}
        self._pending_lock = threading.Lock()
        self._handlers: Dict[str, List[Handler]] = {}

    # -- state --------------------------------------------------------

    @property
    def connected(self) -> bool:
        """True once AuraUI has sent ``welcome`` on the current socket."""
        return self._connected.is_set()

    @property
    def session_id(self) -> Optional[str]:
        """One per AuraUI process; stable across reconnects."""
        return self._session_id

    @property
    def server(self) -> Optional[Dict[str, Any]]:
        """The ``server`` block from ``welcome``: name, version, protocol, bridgeUrl."""
        return self._server

    @property
    def pending_task_ids(self) -> List[str]:
        """Task ids still waiting for an answer."""
        with self._pending_lock:
            return list(self._pending)

    @property
    def seq_gaps(self) -> int:
        """How many times AuraUI skipped an event ``seq``."""
        return self._gaps

    # -- connection ---------------------------------------------------

    def connect(self, timeout: Optional[float] = None) -> Dict[str, Any]:
        """Open the socket, send ``hello``, and wait for AuraUI's ``welcome``.

        :param timeout: Overrides ``connect_timeout`` for this call.
        :returns: The ``welcome`` frame.
        :raises ConnectionLost: If the bridge is unreachable.
        :raises TaskTimeout: If the socket opens but ``welcome`` never arrives.
        """
        if self.connected and self._welcome is not None:
            return self._welcome

        timeout = self._connect_timeout if timeout is None else timeout
        self._closed_by_user = False
        self._stop.clear()

        self._open_socket(timeout)
        self._start_reader()

        if not self._welcome_event.wait(timeout):
            raise TaskTimeout(
                f'AuraUI did not send "welcome" within {timeout}s at {self.url}. '
                "Is the AuraUI window open?"
            )
        if self._welcome is None:  # pragma: no cover - the reader clears it on disconnect
            raise ConnectionLost(f"Lost the AuraUI connection at {self.url} while connecting.")
        return self._welcome

    def close(self, timeout: float = 2.0) -> None:
        """Close the connection and fail anything still in flight. Safe to call twice."""
        self._closed_by_user = True
        self._stop.set()
        self._connected.clear()

        ws, self._ws = self._ws, None
        self._session_id = None
        self._welcome = None
        self._fail_all_pending(ConnectionLost("The AuraUI client was closed."))

        if ws is not None:
            try:
                ws.close()
            except Exception:  # noqa: BLE001 - closing must never raise
                pass

        reader = self._reader
        if reader is not None and reader.is_alive() and reader is not threading.current_thread():
            reader.join(timeout=timeout)

    def __enter__(self) -> "Agent":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def _open_socket(self, timeout: float) -> None:
        ws = RawWebSocket(self.url, connect_timeout=timeout)
        try:
            ws.connect()
        except HandshakeError as exc:
            raise ConnectionLost(str(exc)) from exc

        self._welcome = None
        self._welcome_event.clear()
        self._ws = ws
        ws.send_text(hello_frame(self.identity))

    def _start_reader(self) -> None:
        if self._reader is not None and self._reader.is_alive():
            return
        self._reader = threading.Thread(target=self._read_loop, name="auraui-reader", daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        while not self._stop.is_set():
            ws = self._ws
            if ws is None:
                return
            try:
                text = ws.receive_text()
            except ConnectionClosed as exc:
                self._on_disconnect(exc)
                if self._stop.is_set() or not self.reconnect:
                    return
                if not self._reconnect_with_backoff():
                    return
                continue
            except WebSocketError as exc:
                self._on_disconnect(exc)
                return

            try:
                message = json.loads(text)
            except ValueError:
                self._report(
                    "error",
                    ProtocolViolation("client", f"AuraUI sent a frame that is not JSON: {text[:200]}"),
                )
                continue

            if isinstance(message, dict):
                self._dispatch(message)
            else:
                self._report(
                    "error",
                    ProtocolViolation("client", "AuraUI sent a JSON value that is not an object."),
                )

    def _on_disconnect(self, exc: BaseException) -> None:
        code = getattr(exc, "code", 1006)
        reason = getattr(exc, "reason", "") or str(exc)
        self._ws = None
        self._connected.clear()
        self._session_id = None
        self._welcome = None
        self._fail_all_pending(
            ConnectionLost(
                f"The AuraUI connection was lost (code {code}"
                f"{': ' + reason if reason else ''}) before the human answered."
            )
        )
        self._report("close", {"code": code, "reason": reason})

    def _reconnect_with_backoff(self) -> bool:
        """Retry until connected or the client is closed. Returns True when reconnected."""
        attempt = 0
        while not self._stop.is_set():
            attempt += 1
            self._reconnect_attempts = attempt
            ceiling = min(15.0, 0.5 * (2 ** (attempt - 1)))
            # Full jitter over the lower half of the interval: spread retries, no stall.
            delay = ceiling / 2 + random.random() * (ceiling / 2)
            self._report("reconnecting", {"attempt": attempt, "delay": delay})

            if self._stop.wait(delay):
                return False

            try:
                self._open_socket(self._connect_timeout)
                if self._welcome_event.wait(self._connect_timeout):
                    self._reconnect_attempts = 0
                    self._report("reconnect", self._welcome)
                    return True
                raise ConnectionLost(
                    f'AuraUI accepted the socket but never sent "welcome" at {self.url}.'
                )
            except (AuraUIError, ConnectionClosed, WebSocketError, OSError) as exc:
                self._report("reconnect_failed", {"attempt": attempt, "error": exc})
                self._ws = None
                self._connected.clear()
        return False

    # -- sending ------------------------------------------------------

    def _send(self, frame_type: str, **fields: Any) -> None:
        # Named `frame_type`, not `kind`: a frame's own fields are passed as keywords, and
        # `note` legitimately sends `kind=`. A parameter called `kind` swallows it.
        ws = self._ws
        if ws is None or not self._connected.is_set():
            raise ConnectionLost(f"Not connected to AuraUI at {self.url}. Call connect() first.")
        text = frame(frame_type, **fields)
        if len(text) > MAX_FRAME_BYTES:
            raise ValueError(f"Refusing to send a {len(text)}-byte frame; the bridge limit is 16 MiB.")
        try:
            ws.send_text(text)
        except ConnectionClosed as exc:
            raise ConnectionLost(str(exc)) from exc

    def task(
        self,
        component: str,
        props: Dict[str, Any],
        task_id: Optional[str] = None,
        instruction: Optional[str] = None,
        urgent: bool = False,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Summon a component and block until the human answers it.

        Resolves on the first *terminal* event for this task: ``action``, ``submit``,
        ``filter`` or ``cancel``. Non-terminal events (``ready``, ``select``, ``change``,
        ``sort``, ``error``) are delivered to :meth:`on_event` and :meth:`on_signal` and
        never end the wait.

        :param component: One of the eight AuraUI components.
        :param props: Props built with the :mod:`auraui.components` helpers.
        :param task_id: Generated when omitted.
        :param instruction: Shown to the human above the component.
        :param urgent: Marks the task as needing a decision now.
        :param timeout: Seconds to wait. Waits indefinitely by default.
        :returns: ``{"taskId", "event", "payload", "seq", "at"}``.
        :raises TaskTimeout: If ``timeout`` elapses first.
        :raises ConnectionLost: If the bridge drops before the human answers.
        """
        if not isinstance(component, str) or not component:
            raise ValueError("task() needs a non-empty `component`.")
        if not isinstance(props, dict):
            raise ValueError("task() needs a `props` dict built with the components helpers.")

        task_id = task_id or new_task_id()
        self._await_connection()

        pending = _Pending()
        with self._pending_lock:
            if task_id in self._pending:
                raise ValueError(
                    f'Duplicate task id "{task_id}" is already awaiting an answer. '
                    "Every task needs a unique id."
                )
            self._pending[task_id] = pending

        try:
            self._send(
                "task",
                taskId=task_id,
                component=component,
                instruction=instruction,
                props=props,
                urgent=True if urgent else None,
            )
        except BaseException:
            with self._pending_lock:
                self._pending.pop(task_id, None)
            raise

        if not pending.done.wait(timeout):
            with self._pending_lock:
                self._pending.pop(task_id, None)
            raise TaskTimeout(f'No answer for task "{task_id}" within {timeout}s.')

        if pending.error is not None:
            raise pending.error
        assert pending.result is not None
        return pending.result

    def resolve(self, task_id: str, reason: Optional[str] = None) -> None:
        """Withdraw a task before the human answers it."""
        if not task_id:
            raise ValueError("resolve() needs a task_id.")
        self._send("resolve", taskId=task_id, reason=reason)
        with self._pending_lock:
            pending = self._pending.pop(task_id, None)
        if pending is not None:
            pending.fail(ConnectionLost(f'Task "{task_id}" was withdrawn by the agent.'))

    def notify(self, level: str, message: str) -> None:
        """Queue a transient toast in the AuraUI window. Does not expect a reply."""
        from .protocol import NOTICE_LEVELS

        if level not in NOTICE_LEVELS:
            raise ValueError(f"notify level must be one of {', '.join(NOTICE_LEVELS)}.")
        self._send("notify", level=level, message=message)

    def note(self, text: str, kind: str = "meta") -> None:
        """Narrate what the agent is doing, in one line.

        The canvas shows only the newest note, and only while it is idle, so narrating
        freely costs the human nothing and is never mistaken for a question.
        """
        from .protocol import NOTE_KINDS

        if kind not in NOTE_KINDS:
            raise ValueError(f"note kind must be one of {', '.join(NOTE_KINDS)}.")
        self._send("note", text=text, kind=kind)

    def update(
        self,
        task_id: str,
        props: Optional[Dict[str, Any]] = None,
        instruction: Optional[str] = None,
    ) -> None:
        """Patch a live task, e.g. to feed a chart drill-down after a ``filter`` event."""
        self._send("update", taskId=task_id, props=props, instruction=instruction)

    def ping(self) -> None:
        """Liveness probe. AuraUI answers with a ``pong``, delivered to :meth:`on_pong`."""
        self._send("ping")

    # -- receiving ----------------------------------------------------

    def _dispatch(self, message: Dict[str, Any]) -> None:
        kind = message.get("type")

        if kind == "welcome":
            self._welcome = message
            self._session_id = message.get("sessionId")
            self._server = message.get("server")
            self._reconnect_attempts = 0
            self._connected.set()
            self._welcome_event.set()
            self._report("welcome", message)
            return

        if kind == "event":
            self._handle_event(message)
            return

        if kind == "ack":
            self._report("ack", message)
            return

        if kind == "error":
            error = ProtocolViolation(
                str(message.get("code", "bad_frame")), str(message.get("message", "unknown error"))
            )
            self._report("error", error, message)
            task_id = message.get("taskId")
            if isinstance(task_id, str):
                self._fail_pending(task_id, error)
            return

        if kind == "pong":
            self._report("pong", message)
            return

        self._report(
            "error",
            ProtocolViolation("client", f"Unknown frame type {message.get('type')!r} from AuraUI."),
            message,
        )

    def _handle_event(self, message: Dict[str, Any]) -> None:
        seq = message.get("seq")
        if isinstance(seq, int):
            if self._seq is not None and seq > self._seq + 1:
                self._gaps += 1
                self._report(
                    "gap",
                    {"expected": self._seq + 1, "received": seq, "missed": seq - self._seq - 1},
                )
            self._seq = seq if self._seq is None else max(self._seq, seq)

        task_id = message.get("taskId")
        answer = {
            "taskId": task_id,
            "event": message.get("event"),
            "payload": message.get("payload") or {},
            "seq": seq,
            "at": message.get("at"),
        }
        self._report("event", answer)

        with self._pending_lock:
            pending = self._pending.get(task_id) if isinstance(task_id, str) else None

        if pending is None:
            # A late answer for an already-resolved task, or one this client never sent.
            self._report("orphan", answer)
            print(
                f'[auraui] Ignoring "{answer["event"]}" for unknown taskId {task_id!r}. '
                f"Known tasks: {', '.join(self.pending_task_ids) or '(none)'}"
            )
            return

        if answer["event"] in TERMINAL_EVENTS:
            with self._pending_lock:
                self._pending.pop(task_id, None)
            pending.resolve(answer)
            self._report("answered", answer)
        else:
            pending.signals.append(answer)
            self._report("signal", answer)

    def _fail_pending(self, task_id: str, error: BaseException) -> bool:
        with self._pending_lock:
            pending = self._pending.pop(task_id, None)
        if pending is None:
            return False
        pending.fail(error)
        return True

    def _fail_all_pending(self, error: BaseException) -> None:
        with self._pending_lock:
            pendings = list(self._pending.values())
            self._pending.clear()
        for pending in pendings:
            pending.fail(error)

    def _await_connection(self, timeout: Optional[float] = None) -> None:
        if self.connected and self._ws is not None:
            return
        if self._closed_by_user:
            raise ConnectionLost("The AuraUI client was closed.")
        if not self.reconnect:
            raise ConnectionLost(f"Not connected to AuraUI at {self.url}. Call connect() first.")
        if not self._connected.wait(self._connect_timeout if timeout is None else timeout):
            raise ConnectionLost(f"AuraUI at {self.url} is still unreachable.")

    # -- handlers -----------------------------------------------------

    def on(self, kind: str, handler: Handler) -> Handler:
        """Register a handler for a client event. Returns the handler for chaining."""
        if not callable(handler):
            raise TypeError("on(kind, handler) needs a callable.")
        self._handlers.setdefault(kind, []).append(handler)
        return handler

    def off(self, kind: str, handler: Handler) -> None:
        """Remove a handler registered with :meth:`on`."""
        handlers = self._handlers.get(kind)
        if handlers and handler in handlers:
            handlers.remove(handler)

    def on_welcome(self, handler: Handler) -> Handler:
        """Called with AuraUI's ``welcome`` frame, on connect and on every reconnect."""
        return self.on("welcome", handler)

    def on_event(self, handler: Handler) -> Handler:
        """Called with every event frame as ``{"taskId","event","payload","seq","at"}``."""
        return self.on("event", handler)

    def on_signal(self, handler: Handler) -> Handler:
        """Called only for non-terminal events: ``select``, ``change``, ``sort``, ``ready``."""
        return self.on("signal", handler)

    def on_answered(self, handler: Handler) -> Handler:
        """Called when a task is finished by a terminal event."""
        return self.on("answered", handler)

    def on_ack(self, handler: Handler) -> Handler:
        """Called with each ``ack`` frame AuraUI sends for a task."""
        return self.on("ack", handler)

    def on_error(self, handler: Handler) -> Handler:
        """Called with an error, either a transport error or AuraUI's ``error`` frame."""
        return self.on("error", handler)

    def on_close(self, handler: Handler) -> Handler:
        """Called with ``{"code","reason"}`` when the connection drops."""
        return self.on("close", handler)

    def on_gap(self, handler: Handler) -> Handler:
        """Called when AuraUI skips an event ``seq``, so an answer may have been lost."""
        return self.on("gap", handler)

    def on_orphan(self, handler: Handler) -> Handler:
        """Called for an event whose taskId this client is not waiting on."""
        return self.on("orphan", handler)

    def on_reconnecting(self, handler: Handler) -> Handler:
        """Called with ``{"attempt","delay"}`` before each reconnect."""
        return self.on("reconnecting", handler)

    def on_reconnect(self, handler: Handler) -> Handler:
        """Called with the fresh ``welcome`` after a successful reconnect."""
        return self.on("reconnect", handler)

    def on_reconnect_failed(self, handler: Handler) -> Handler:
        """Called with ``{"attempt","error"}`` when a reconnect attempt fails."""
        return self.on("reconnect_failed", handler)

    def on_pong(self, handler: Handler) -> Handler:
        """Called with each ``pong`` frame."""
        return self.on("pong", handler)

    def _report(self, kind: str, *args: Any) -> None:
        """Invoke handlers, containing any exception they raise.

        A user callback must never be able to kill the reader thread: that would silently
        stop the agent from ever hearing an answer.
        """
        for handler in list(self._handlers.get(kind, ())):
            try:
                handler(*args)
            except Exception as exc:  # noqa: BLE001 - deliberate containment
                print(f'[auraui] Handler for "{kind}" raised: {exc!r}')
                for fallback in list(self._handlers.get("handler_error", ())):
                    try:
                        fallback({"kind": kind, "error": exc})
                    except Exception:  # noqa: BLE001 - a reporting callback must not cascade
                        pass
