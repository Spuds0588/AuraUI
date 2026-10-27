import type { WebTaskItem, WebTaskItemStatus, WebTaskState } from "./protocol";

/**
 * A delegated list that outlives the card it arrived on.
 *
 * The case this exists for is the one the component was built for: an agent hands over someone's
 * morning, and they get through four of the nine stops before the machine is put to sleep, the app
 * is restarted, or the agent reconnects and re-sends the same task. Losing the four is not a
 * cosmetic bug, it is the thing that makes a queue of delegated tasks not worth using.
 *
 * So progress is kept under the task id rather than the component instance. A card that mounts
 * over a stored run picks the notes and the done marks straight back up, and the agent's second
 * send of the same list becomes a resume rather than a reset.
 *
 * What is *not* stored is file bytes. A returned PDF is base64 in a string, which is exactly the
 * shape that makes a browser's local storage grow without a bound, and a signed document is the
 * sort of thing that should live in the answer that carried it rather than in a cache the human
 * has forgotten about.
 */
const KEY_PREFIX = "auraui.webtask.";

/** How many unfinished lists are remembered at once, newest first. */
const REMEMBERED = 24;

/** One row's persisted state: everything except the bytes of a returned file. */
export interface StoredRow {
  status: WebTaskItemStatus;
  note?: string;
  lastUrl?: string;
  openedAt?: number;
  completedAt?: number;
}

export interface WebTaskProgress {
  /** Rows by item id, so an item the agent later re-orders or renames still lines up. */
  rows: Record<string, StoredRow>;
  /** The card-level note, which is usually the best part of someone's answer. */
  notes?: string;
  /** Whether the human said to keep the handed-over session. */
  sessionKept?: boolean;
  updatedAt: number;
}

function key(taskId: string): string {
  return `${KEY_PREFIX}${taskId}`;
}

export function loadWebTaskProgress(taskId: string): WebTaskProgress | undefined {
  try {
    const raw = window.localStorage.getItem(key(taskId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as WebTaskProgress;
    if (!parsed || typeof parsed !== "object" || typeof parsed.rows !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Persist a run.
 *
 * Failures are swallowed on purpose. This is a convenience for the human, not part of the answer:
 * a browser with storage disabled or full must still be able to hand back the list they just
 * worked through, so the answer path never touches this one.
 */
export function saveWebTaskProgress(taskId: string, progress: WebTaskProgress): void {
  try {
    window.localStorage.setItem(key(taskId), JSON.stringify(progress));
    prune();
  } catch {
    // Out of quota, or storage refused. The card still answers; it just will not resume.
  }
}

export function clearWebTaskProgress(taskId: string): void {
  try {
    window.localStorage.removeItem(key(taskId));
  } catch {
    // Nothing stored to clear.
  }
}

/** Drop the oldest runs once there are more than [`REMEMBERED`]. */
function prune(): void {
  try {
    const entries: { key: string; at: number }[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const name = window.localStorage.key(index);
      if (!name || !name.startsWith(KEY_PREFIX)) continue;
      const value = window.localStorage.getItem(name);
      let at = 0;
      try {
        at = (JSON.parse(value ?? "{}") as { updatedAt?: number }).updatedAt ?? 0;
      } catch {
        at = 0;
      }
      entries.push({ key: name, at });
    }
    if (entries.length <= REMEMBERED) return;
    entries
      .sort((a, b) => a.at - b.at)
      .slice(0, entries.length - REMEMBERED)
      .forEach((entry) => window.localStorage.removeItem(entry.key));
  } catch {
    // Pruning is housekeeping. Losing it costs some space, not correctness.
  }
}

/**
 * The rows a card starts with: the agent's list, with anything remembered folded back in.
 *
 * An item the stored run never saw starts `pending`; one it saw keeps its status and note. Ids
 * are the join, which is why the bridge insists every item has one and that no two share it.
 */
export function resumeStates(
  items: WebTaskItem[],
  saved: WebTaskProgress | undefined,
): Record<string, WebTaskState> {
  const states: Record<string, WebTaskState> = {};
  for (const item of items) {
    const row = saved?.rows?.[item.id];
    states[item.id] = {
      id: item.id,
      status: row?.status ?? "pending",
      note: row?.note,
      lastUrl: row?.lastUrl,
      openedAt: row?.openedAt,
      completedAt: row?.completedAt,
    };
  }
  return states;
}

/** Strip the parts of a row that must not be cached, for storage. */
export function toStored(rows: Record<string, WebTaskState>): Record<string, StoredRow> {
  const out: Record<string, StoredRow> = {};
  for (const [id, row] of Object.entries(rows)) {
    out[id] = {
      status: row.status,
      note: row.note,
      lastUrl: row.lastUrl,
      openedAt: row.openedAt,
      completedAt: row.completedAt,
    };
  }
  return out;
}
