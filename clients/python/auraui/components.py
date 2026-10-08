"""Prop builders for the eight AuraUI components.

Use these instead of hand-writing dicts. They spell the wire keys correctly (``taskId``,
``vegaSchema``, ``defaultValue``), keep optional keys out of the payload when unset, and
reject the mistakes that would otherwise only surface as an error frame from the bridge —
an empty option list, a bad notice level, a choice field with nothing to choose from.

Every builder returns the ``props`` object for :meth:`auraui.Agent.task`::

    from auraui import Agent, components as c

    agent.task(
        component="ActionCard",
        instruction="Which release should ship?",
        props=c.action_card([c.option("ship", "Ship 2026.10.4", {"variant": "primary"})]),
    )
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence

from .protocol import NOTICE_LEVELS

_VARIANTS = ("default", "primary", "destructive", "ghost")
_FIELD_TYPES = ("text", "textarea", "number", "date", "choice", "multi")
_COLUMN_TYPES = ("text", "number", "date", "badge", "mono")
_ALIGNMENTS = ("left", "right", "center")
_SELECT_MODES = ("none", "single", "multi")
_DIFF_LINE_KINDS = ("context", "add", "del")
_RATING_MIN_POINTS = 2
_RATING_MAX_POINTS = 10


def _drop_none(mapping: Dict[str, Any]) -> Dict[str, Any]:
    """Keep optional keys absent instead of sending JSON null."""
    return {key: value for key, value in mapping.items() if value is not None}


def _require_text(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{what} must be a non-empty string.")
    return value


def _require_items(value: Any, what: str) -> Sequence[Any]:
    if not isinstance(value, (list, tuple)) or len(value) == 0:
        raise ValueError(f"{what} must be a non-empty list.")
    return value


def _require_one_of(value: Any, allowed: Iterable[str], what: str) -> str:
    allowed = tuple(allowed)
    if value not in allowed:
        raise ValueError(f"{what} must be one of {', '.join(allowed)}.")
    return value


# --------------------------------------------------------------------------
# Sub-objects
# --------------------------------------------------------------------------


def option(
    id: str,
    label: str,
    description: Optional[str] = None,
    variant: Optional[str] = None,
    icon: Optional[str] = None,
) -> Dict[str, Any]:
    """One clickable choice inside an ActionCard or Notice."""
    _require_text(id, "option id")
    _require_text(label, "option label")
    if variant is not None:
        _require_one_of(variant, _VARIANTS, "option variant")
    return _drop_none(
        {"id": id, "label": label, "description": description, "variant": variant, "icon": icon}
    )


def field_option(value: str, label: str, description: Optional[str] = None) -> Dict[str, Any]:
    """One option of a ``choice`` or ``multi`` field.

    Both are drawn as buttons, so the option *is* the control: there is no box to tick and
    no menu to open. A ``multi`` field's option can carry a description for the second line.
    """
    return _drop_none(
        {
            "value": _require_text(value, "field option value"),
            "label": _require_text(label, "field option label"),
            "description": description,
        }
    )


def field(
    name: str,
    label: str,
    type: str = "text",
    options: Optional[Sequence[Dict[str, Any]]] = None,
    placeholder: Optional[str] = None,
    help: Optional[str] = None,
    required: Optional[bool] = None,
    default: Optional[Any] = None,
    min: Optional[float] = None,
    max: Optional[float] = None,
    step: Optional[float] = None,
    validate: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """One input inside a wizard step.

    ``default`` is sent as ``defaultValue``, matching the wire contract: a string for
    ``choice``, a list of strings for ``multi``.

    ``choice`` and ``multi`` are painted as rows of buttons. AuraUI has no checkboxes, radio
    buttons or dropdowns, so a yes/no question is a ``choice`` with two options — which also
    makes the agent say what each answer means instead of labelling a box.
    """
    _require_text(name, "field name")
    _require_text(label, "field label")
    _require_one_of(type, _FIELD_TYPES, "field type")
    if type in ("choice", "multi"):
        _require_items(options, f'options for the "{name}" {type} field')
    return _drop_none(
        {
            "name": name,
            "label": label,
            "type": type,
            "options": list(options) if options is not None else None,
            "placeholder": placeholder,
            "help": help,
            "required": required,
            "defaultValue": default,
            "min": min,
            "max": max,
            "step": step,
            "validate": validate,
        }
    )


def step(
    id: str,
    title: str,
    fields: Sequence[Dict[str, Any]],
    description: Optional[str] = None,
) -> Dict[str, Any]:
    """One page of a WizardForm."""
    _require_text(id, "step id")
    _require_text(title, "step title")
    _require_items(fields, f'fields for step "{id}"')
    return _drop_none(
        {"id": id, "title": title, "description": description, "fields": list(fields)}
    )


def item(
    id: str,
    label: str,
    description: Optional[str] = None,
    badge: Optional[str] = None,
) -> Dict[str, Any]:
    """One draggable row of a SortableList."""
    _require_text(id, "item id")
    _require_text(label, "item label")
    return _drop_none({"id": id, "label": label, "description": description, "badge": badge})


def column(
    key: str,
    header: str,
    type: Optional[str] = None,
    align: Optional[str] = None,
    width: Optional[int] = None,
) -> Dict[str, Any]:
    """One column of a DataGrid."""
    _require_text(key, "column key")
    _require_text(header, "column header")
    if type is not None:
        _require_one_of(type, _COLUMN_TYPES, "column type")
    if align is not None:
        _require_one_of(align, _ALIGNMENTS, "column align")
    return _drop_none({"key": key, "header": header, "type": type, "align": align, "width": width})


def diff_line(kind: str, text: str) -> Dict[str, Any]:
    """One line of a diff hunk.

    ``kind`` is ``context``, ``add`` or ``del``. Use ``""`` for a blank line: an empty string
    is a line, a missing one is a bug.
    """
    _require_one_of(kind, _DIFF_LINE_KINDS, "diff_line kind")
    if not isinstance(text, str):
        raise ValueError("diff_line text must be a string.")
    return {"kind": kind, "text": text}


def diff_hunk(
    id: str,
    lines: Sequence[Dict[str, Any]],
    header: Optional[str] = None,
) -> Dict[str, Any]:
    """One reviewable chunk of a change.

    The agent splits its own diff and marks each line. AuraUI renders what it is handed and
    never computes a diff itself — the same rule as charts, where the agent brings the query
    and the rows and the canvas only draws them.
    """
    _require_text(id, "diff_hunk id")
    _require_items(lines, f'lines for hunk "{id}"')
    return _drop_none({"id": id, "header": header, "lines": list(lines)})


# --------------------------------------------------------------------------
# Component props
# --------------------------------------------------------------------------


def action_card(
    options: Sequence[Dict[str, Any]],
    columns: Optional[int] = None,
    footnote: Optional[str] = None,
) -> Dict[str, Any]:
    """Props for ActionCard: a short list of mutually exclusive choices."""
    _require_items(options, "action_card options")
    if columns is not None and columns not in (1, 2, 3):
        raise ValueError("action_card columns must be 1, 2 or 3.")
    return _drop_none({"options": list(options), "columns": columns, "footnote": footnote})


def notice(
    level: str,
    title: Optional[str] = None,
    body: Optional[str] = None,
    bullets: Optional[Sequence[str]] = None,
    actions: Optional[Sequence[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Props for Notice: a non-blocking callout, optionally with buttons."""
    _require_one_of(level, NOTICE_LEVELS, "notice level")
    return _drop_none(
        {
            "level": level,
            "title": title,
            "body": body,
            "bullets": list(bullets) if bullets is not None else None,
            "actions": list(actions) if actions is not None else None,
        }
    )


def wizard_form(
    steps: Sequence[Dict[str, Any]],
    submit_label: Optional[str] = None,
    live: Optional[bool] = None,
) -> Dict[str, Any]:
    """Props for WizardForm: one or more steps of fields, answered in order."""
    _require_items(steps, "wizard_form steps")
    return _drop_none({"steps": list(steps), "submitLabel": submit_label, "live": live})


def sortable_list(
    items: Sequence[Dict[str, Any]],
    require_all: Optional[bool] = None,
    submit_label: Optional[str] = None,
) -> Dict[str, Any]:
    """Props for SortableList: the human drags items into the correct order."""
    _require_items(items, "sortable_list items")
    return _drop_none(
        {"items": list(items), "requireAll": require_all, "submitLabel": submit_label}
    )


def data_grid(
    columns: Sequence[Dict[str, Any]],
    rows: Sequence[Dict[str, Any]],
    row_key: Optional[str] = None,
    select_mode: Optional[str] = None,
    page_size: Optional[int] = None,
    filterable: Optional[bool] = None,
    sortable: Optional[bool] = None,
    submit_label: Optional[str] = None,
    empty_message: Optional[str] = None,
) -> Dict[str, Any]:
    """Props for DataGrid: real rows, sortable and selectable."""
    _require_items(columns, "data_grid columns")
    if not isinstance(rows, (list, tuple)):
        raise ValueError("data_grid rows must be a list.")
    if select_mode is not None:
        _require_one_of(select_mode, _SELECT_MODES, "data_grid select_mode")
    return _drop_none(
        {
            "columns": list(columns),
            "rows": list(rows),
            "rowKey": row_key,
            "selectMode": select_mode,
            "pageSize": page_size,
            "filterable": filterable,
            "sortable": sortable,
            "submitLabel": submit_label,
            "emptyMessage": empty_message,
        }
    )


def interactive_chart(
    vega_schema: Dict[str, Any],
    data: Sequence[Dict[str, Any]],
    height: Optional[int] = None,
    drillable: Optional[bool] = None,
    hint: Optional[str] = None,
) -> Dict[str, Any]:
    """Props for InteractiveChart.

    ``vega_schema`` is a Vega-Lite v5 spec whose ``data`` is a *named* source, and ``data``
    carries the real rows. The renderer binds them together. This split is the point of the
    design: an agent that writes numbers into a spec can invent numbers.
    """
    if not isinstance(vega_schema, dict):
        raise ValueError("interactive_chart vega_schema must be a Vega-Lite spec dict.")
    if not isinstance(data, (list, tuple)):
        raise ValueError("interactive_chart data must be a list of rows.")
    return _drop_none(
        {
            "vegaSchema": vega_schema,
            "data": list(data),
            "height": height,
            "drillable": drillable,
            "hint": hint,
        }
    )


def rating_scale(
    max: int,
    *,
    min: int = 1,
    labels: Optional[Sequence[str]] = None,
    legend: Optional[Dict[str, str]] = None,
    default_value: Optional[int] = None,
    help: Optional[str] = None,
) -> Dict[str, Any]:
    """Props for RatingScale: one bounded scale, answered by pressing a single point.

    AuraUI has no slider, no star rating and no dropdown, so a scale is a row of buttons with
    the numbers on them. Every point is on screen and reachable by keyboard, and the press is
    the answer: nothing is sent until the human presses, and nothing is asked afterwards.
    There is no label to give a confirm button because there is no confirm button.

    The agent owns the words: ``labels`` names each point and ``legend`` names the two ends.
    AuraUI never invents "1 = terrible".
    """
    if not isinstance(max, int) or isinstance(max, bool) or not (
        _RATING_MIN_POINTS <= max <= _RATING_MAX_POINTS
    ):
        raise ValueError(
            f"rating_scale max must be an integer between {_RATING_MIN_POINTS} and "
            f"{_RATING_MAX_POINTS}: a wider scale stops being one row of buttons."
        )
    if not isinstance(min, int) or isinstance(min, bool) or min >= max:
        raise ValueError(f"rating_scale min must be an integer below max ({max}).")

    points = max - min + 1
    if labels is not None:
        labels = list(labels)
        if len(labels) != points:
            raise ValueError(
                f"rating_scale labels must have {points} entries, one for each point from "
                f"{min} to {max}."
            )
        for label in labels:
            if not isinstance(label, str) or not label:
                raise ValueError("rating_scale labels must all be non-empty strings.")
    if default_value is not None and (
        not isinstance(default_value, int)
        or isinstance(default_value, bool)
        or not (min <= default_value <= max)
    ):
        raise ValueError(f"rating_scale default_value must be an integer between {min} and {max}.")

    return _drop_none(
        {
            "min": min,
            "max": max,
            "labels": labels,
            "legend": legend,
            "defaultValue": default_value,
            "help": help,
        }
    )


def diff_review(
    hunks: Sequence[Dict[str, Any]],
    *,
    title: Optional[str] = None,
    footnote: Optional[str] = None,
) -> Dict[str, Any]:
    """Props for DiffReview: "accept this part of my change, or not".

    Every hunk needs a decision, and each one is made by pressing a button per hunk — there is
    no checkbox to tick, which is the point: the human has to look at each hunk and choose.

    The decision is also the submit. The press that settles the last open hunk sends the
    review, so one hunk on a card is one press end to end — which is why the examples send one
    hunk per card rather than a wall of decisions.
    """
    _require_items(hunks, "diff_review hunks")
    for index, hunk in enumerate(hunks):
        if not isinstance(hunk, dict):
            raise ValueError(
                f"diff_review hunk {index + 1} must be a dict built with diff_hunk()."
            )
        hunk_id = _require_text(hunk.get("id"), f"diff_review hunk {index + 1} id")
        lines = _require_items(hunk.get("lines"), f'lines for hunk "{hunk_id}"')
        for line in lines:
            if not isinstance(line, dict):
                raise ValueError(f'every line in hunk "{hunk_id}" must be a dict.')
            _require_one_of(line.get("kind"), _DIFF_LINE_KINDS, f'line kind in hunk "{hunk_id}"')
            if not isinstance(line.get("text"), str):
                raise ValueError(f'every line in hunk "{hunk_id}" needs string text.')

    return _drop_none(
        {
            "hunks": list(hunks),
            "title": title,
            "footnote": footnote,
        }
    )
