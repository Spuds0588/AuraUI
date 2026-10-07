"""Constants, errors and frame helpers for protocol version 1.0.

The authoritative contract is ``src/lib/protocol.ts`` and ``docs/PROTOCOL.md``. This module
mirrors the parts an agent author touches, and nothing here should drift from it.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, Optional

PROTOCOL_VERSION = "1.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9090
DEFAULT_URL = f"ws://{DEFAULT_HOST}:{DEFAULT_PORT}"

#: Events that finish a task. Every other event is progress, not an answer.
TERMINAL_EVENTS = frozenset({"action", "submit", "filter", "cancel"})

EVENT_NAMES = (
    "ready",
    "action",
    "submit",
    "select",
    "filter",
    "change",
    "sort",
    "cancel",
    "error",
)

COMPONENT_NAMES = (
    "ActionCard",
    "Notice",
    "WizardForm",
    "SortableList",
    "DataGrid",
    "InteractiveChart",
)

NOTICE_LEVELS = ("info", "success", "warn", "error")
NOTE_KINDS = ("thinking", "progress", "result", "meta")

#: One task frame or event frame above this size is a bug, not a payload.
MAX_FRAME_BYTES = 16 * 1024 * 1024


class AuraUIError(Exception):
    """Base class for every error this client raises."""


class TaskTimeout(AuraUIError, TimeoutError):
    """The human did not answer within the timeout given to :meth:`Agent.task`.

    Subclasses the builtin :class:`TimeoutError`, so ``except TimeoutError`` works too.
    """


class ConnectionLost(AuraUIError, ConnectionError):
    """The bridge went away, or was never reachable.

    Subclasses the builtin :class:`ConnectionError`.
    """


class ProtocolViolation(AuraUIError):
    """AuraUI sent something this client cannot make sense of."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def new_task_id(prefix: str = "task") -> str:
    """A short, collision-resistant task id such as ``task_9f3c1a02``."""
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def frame(frame_type: str, **fields: Any) -> str:
    """Serialise an outgoing frame, omitting keys whose value is ``None``.

    Optional protocol fields stay absent on the wire rather than arriving as JSON null,
    which is what the bridge and the canvas expect.

    The first parameter is ``frame_type`` rather than ``kind`` on purpose: frame fields are
    passed as keywords, and a ``note`` frame carries its own ``kind``. A parameter named
    ``kind`` would collide with it.
    """
    payload: Dict[str, Any] = {"v": PROTOCOL_VERSION, "type": frame_type}
    for key, value in fields.items():
        if value is not None:
            payload[key] = value
    return json.dumps(payload, separators=(",", ":"))


def hello_frame(identity: Dict[str, Any]) -> str:
    """The ``hello`` frame an agent sends immediately after the socket opens."""
    agent = {key: value for key, value in identity.items() if value is not None}
    return frame("hello", agent=agent)


def identity(
    name: str,
    version: Optional[str] = None,
    vendor: Optional[str] = None,
    capabilities: Optional[list] = None,
) -> Dict[str, Any]:
    """Build the ``agent`` block carried by ``hello``."""
    if not isinstance(name, str) or not name:
        raise ValueError("Agent name must be a non-empty string.")
    agent: Dict[str, Any] = {"name": name}
    if version is not None:
        agent["version"] = version
    if vendor is not None:
        agent["vendor"] = vendor
    if capabilities is not None:
        agent["capabilities"] = list(capabilities)
    return agent
