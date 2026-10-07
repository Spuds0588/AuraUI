"""AuraUI — a local Human-in-the-Loop bridge for AI agents.

An agent summons an interactive component in the AuraUI window and blocks until the human
answers it::

    from auraui import Agent, components as c

    with Agent(name="release-bot") as agent:
        agent.note("Loaded 3 candidate releases from CI history.", kind="progress")
        answer = agent.task(
            component="ActionCard",
            instruction="Deploy 2026.10.4 failed twice on staging. How do you want to proceed?",
            props=c.action_card([
                c.option("investigate", "Investigate the diff", variant="primary"),
                c.option("rollback", "Roll back", variant="destructive"),
            ]),
        )
        print(answer["payload"]["actionId"])

Protocol version 1.0. The wire contract lives in ``src/lib/protocol.ts`` and
``docs/PROTOCOL.md``; this package has no dependencies beyond the standard library.
"""

from . import components
from .client import Agent
from .protocol import (
    COMPONENT_NAMES,
    DEFAULT_URL,
    EVENT_NAMES,
    NOTE_KINDS,
    NOTICE_LEVELS,
    PROTOCOL_VERSION,
    TERMINAL_EVENTS,
    AuraUIError,
    ConnectionLost,
    ProtocolViolation,
    TaskTimeout,
    new_task_id,
)

__version__ = "0.1.0"

__all__ = [
    "Agent",
    "components",
    "COMPONENT_NAMES",
    "DEFAULT_URL",
    "EVENT_NAMES",
    "NOTE_KINDS",
    "NOTICE_LEVELS",
    "PROTOCOL_VERSION",
    "TERMINAL_EVENTS",
    "AuraUIError",
    "ConnectionLost",
    "ProtocolViolation",
    "TaskTimeout",
    "new_task_id",
    "__version__",
]
