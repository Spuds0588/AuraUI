import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Search,
} from "lucide-react";
import { Badge, Button, Input } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { Column, DataGridProps, Row } from "@/lib/protocol";
import { cn, formatNumber } from "@/lib/utils";

/**
 * A table built for finding one row, not for browsing a dataset.
 *
 * The human is usually here to point at the anomaly the agent could not name. So: a filter
 * that searches everything, sorting that is instant locally *and* reported so the agent can
 * re-sort authoritative data, and a selection that is always visible in the footer.
 *
 * A multi-select grid marks rows with real buttons, not checkboxes: the target is the whole
 * cell, it reports its own state through `aria-pressed`, and the label says what pressing it
 * does. AuraUI has no checkbox anywhere, so there is no smaller thing to aim at.
 *
 * A single-select grid answers on the press. The row *is* the choice, exactly like an option
 * in an ActionCard, so reaching it and then reaching for a submit button would make a
 * one-click answer into two. A multi-select keeps its button because the human is assembling
 * a set and only they know when it is complete.
 */

/** The tick inside a row toggle. Filled when the row is part of the answer. */
function SelectionMark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-3.5 items-center justify-center rounded-[3px] border transition-colors",
        on ? "border-primary bg-primary text-primary-foreground" : "border-input",
      )}
    >
      {on ? <Check className="size-2.5" strokeWidth={3} /> : null}
    </span>
  );
}

type SortDirection = "asc" | "desc" | "none";

function cellText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Numbers may arrive as strings ("412ms", "+318%"), and still want numeric sorting. */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[,\s%+]/g, "");
  if (cleaned === "" || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function badgeVariant(text: string): "danger" | "warn" | "success" | "muted" {
  const lower = text.toLowerCase();
  if (/(regress|fail|error|broken|critical|invalid)/.test(lower)) return "danger";
  if (/(slow|warn|degrad|flaky|timeout|retry)/.test(lower)) return "warn";
  if (/(normal|pass|ok|stable|healthy|success|done)/.test(lower)) return "success";
  return "muted";
}

function formatDate(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export default function DataGrid({
  props,
  respond,
  resolved,
}: TaskComponentProps<DataGridProps>) {
  const {
    columns,
    rows,
    rowKey = "id",
    selectMode = "none",
    pageSize,
    filterable = false,
    sortable = false,
    submitLabel = "Submit",
    emptyMessage = "No rows were supplied.",
  } = props;

  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [direction, setDirection] = useState<SortDirection>("none");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [sent, setSent] = useState(false);

  const keyOf = useCallback(
    (row: Row, index: number) => {
      const raw = row[rowKey];
      return raw === undefined || raw === null ? `__row_${index}` : String(raw);
    },
    [rowKey],
  );

  const entries = useMemo(
    () => rows.map((row, index) => ({ key: keyOf(row, index), row })),
    [keyOf, rows],
  );

  const byKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry.row])), [entries]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(({ row }) =>
      columns.some((column) => cellText(row[column.key]).toLowerCase().includes(needle)),
    );
  }, [columns, entries, query]);

  const sorted = useMemo(() => {
    if (!sortKey || direction === "none") return filtered;
    const factor = direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const left = a.row[sortKey];
      const right = b.row[sortKey];
      const leftNumber = asNumber(left);
      const rightNumber = asNumber(right);
      if (leftNumber !== null && rightNumber !== null) return (leftNumber - rightNumber) * factor;
      return cellText(left).localeCompare(cellText(right)) * factor;
    });
  }, [direction, filtered, sortKey]);

  const effectivePageSize =
    typeof pageSize === "number" && pageSize > 0 ? pageSize : Math.max(sorted.length, 1);
  const pageCount = Math.max(1, Math.ceil(sorted.length / effectivePageSize));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * effectivePageSize;
  const visible = sorted.slice(start, start + effectivePageSize);

  // A new filter or a new dataset makes the old page number meaningless.
  useEffect(() => {
    setPage(1);
  }, [query, rows]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // `sent` is local, so the grid locks the moment the answer goes out instead of staying
  // pressable until the agent's `resolve` comes back over the socket.
  const interactive = selectMode !== "none" && !resolved && !sent;

  const commitSelection = (nextIds: string[]) => {
    setSelected(nextIds);
    const rowsForIds = nextIds
      .map((key) => byKey.get(key))
      .filter((row): row is Row => row !== undefined);
    // Non-terminal: the human is still deciding, and the agent can watch it settle.
    respond("select", { rowIds: nextIds, rows: rowsForIds });
  };

  const toggleRow = (key: string) => {
    if (!interactive) return;
    if (selectMode === "single") {
      // Pressing the row that is already chosen takes the choice back; pressing any other
      // row answers the question outright. Nothing here needs typing, so there is nothing
      // left for a second button to confirm.
      if (selectedSet.has(key)) {
        commitSelection([]);
        return;
      }
      setSelected([key]);
      submitRows([key]);
      return;
    }
    const next = selectedSet.has(key)
      ? selected.filter((current) => current !== key)
      : [...selected, key];
    commitSelection(next);
  };

  const allVisibleSelected = visible.length > 0 && visible.every((entry) => selectedSet.has(entry.key));

  const toggleAllVisible = () => {
    if (!interactive || selectMode !== "multi") return;
    const visibleKeys = visible.map((entry) => entry.key);
    const next = allVisibleSelected
      ? selected.filter((key) => !visibleKeys.includes(key))
      : Array.from(new Set([...selected, ...visibleKeys]));
    commitSelection(next);
  };

  const cycleSort = (key: string) => {
    if (!sortable) return;
    let nextDirection: SortDirection;
    if (sortKey !== key) {
      nextDirection = "asc";
    } else if (direction === "asc") {
      nextDirection = "desc";
    } else if (direction === "desc") {
      nextDirection = "none";
    } else {
      nextDirection = "asc";
    }
    setSortKey(nextDirection === "none" ? null : key);
    setDirection(nextDirection);
    setPage(1);
    // Local sorting is for responsiveness; this event is the contract, because the agent may
    // hold the authoritative ordering and want to re-sort its own data.
    respond("sort", { key, direction: nextDirection });
  };

  /** Send the chosen rows and end the question. The one place a grid answers terminally. */
  const submitRows = (ids: string[]) => {
    if (resolved) return;
    const rowsForIds = ids
      .map((key) => byKey.get(key))
      .filter((row): row is Row => row !== undefined);
    setSent(true);
    respond("submit", { component: "DataGrid", rowIds: ids, rows: rowsForIds });
  };

  const columnCount = columns.length + (selectMode === "multi" ? 1 : 0);
  // `interactive` already means "selectable and still open", so the footer is needed when
  // either the rows overflow the page or a selection is still possible.
  const showFooter = sorted.length > effectivePageSize || interactive;

  return (
    <div className="flex flex-col gap-3">
      {filterable ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Filter ${rows.length} row${rows.length === 1 ? "" : "s"}…`}
            aria-label="Filter rows"
            className="h-9 pl-9 text-xs"
          />
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="bg-secondary/40">
              {selectMode === "multi" ? (
                <th scope="col" className="w-11 px-2.5 py-2.5">
                  <button
                    type="button"
                    onClick={toggleAllVisible}
                    aria-pressed={allVisibleSelected}
                    aria-label={
                      allVisibleSelected
                        ? "Deselect every visible row"
                        : "Select every visible row"
                    }
                    disabled={!interactive || visible.length === 0}
                    className={cn(
                      "flex size-6 items-center justify-center rounded border transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      "disabled:pointer-events-none disabled:opacity-50",
                      allVisibleSelected
                        ? "border-primary bg-primary/15"
                        : "border-transparent hover:bg-secondary/60",
                    )}
                  >
                    <SelectionMark on={allVisibleSelected} />
                  </button>
                </th>
              ) : null}
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  aria-sort={
                    sortKey === column.key && direction !== "none"
                      ? direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  className={cn(
                    "px-3.5 py-2.5 font-medium text-muted-foreground",
                    column.align === "right" && "text-right",
                    column.align === "center" && "text-center",
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => cycleSort(column.key)}
                      className={cn(
                        "-mx-1 inline-flex items-center gap-1.5 rounded px-1.5 py-1 transition-colors hover:text-foreground",
                        column.align === "right" && "flex-row-reverse",
                      )}
                    >
                      <span>{column.header}</span>
                      {sortKey === column.key && direction === "asc" ? (
                        <ArrowUp className="size-3" />
                      ) : sortKey === column.key && direction === "desc" ? (
                        <ArrowDown className="size-3" />
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={columnCount}
                  className="px-3 py-10 text-center text-xs text-muted-foreground"
                >
                  {rows.length === 0 ? emptyMessage : `No rows match “${query.trim()}”.`}
                </td>
              </tr>
            ) : (
              visible.map((entry) => {
                const isSelected = selectedSet.has(entry.key);
                return (
                  <tr
                    key={entry.key}
                    onClick={() => toggleRow(entry.key)}
                    // A row is the thing being chosen, so it has to be reachable without a
                    // mouse. `table-row` keeps the table semantics sane while still being
                    // focusable.
                    tabIndex={interactive ? 0 : undefined}
                    onKeyDown={(event) => {
                      if (!interactive) return;
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      toggleRow(entry.key);
                    }}
                    aria-selected={isSelected}
                    className={cn(
                      "border-t border-border transition-colors",
                      interactive && "cursor-pointer hover:bg-secondary/40",
                      isSelected && "bg-primary/10",
                    )}
                  >
                    {selectMode === "multi" ? (
                      // The row itself is clickable, so the toggle stops the click from
                      // reaching it — otherwise one press would select and then deselect.
                      <td className="px-2.5 py-2.5" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => toggleRow(entry.key)}
                          aria-pressed={isSelected}
                          aria-label={`Select row ${entry.key}`}
                          disabled={!interactive}
                          className={cn(
                            "flex size-6 items-center justify-center rounded border transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                            "disabled:pointer-events-none disabled:opacity-50",
                            isSelected
                              ? "border-primary bg-primary/15"
                              : "border-transparent hover:bg-secondary/60",
                          )}
                        >
                          <SelectionMark on={isSelected} />
                        </button>
                      </td>
                    ) : null}
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          "px-3.5 py-2.5 align-top text-foreground/90",
                          column.align === "right" && "text-right",
                          column.align === "center" && "text-center",
                          column.align !== "right" && column.align !== "center" && "text-left",
                        )}
                      >
                        <Cell column={column} value={entry.row[column.key]} />
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showFooter ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {sorted.length > effectivePageSize
              ? `Showing ${start + 1}–${Math.min(start + effectivePageSize, sorted.length)} of ${sorted.length}`
              : `${sorted.length} row${sorted.length === 1 ? "" : "s"}`}
            {interactive && selected.length > 0
              ? ` · ${selected.length} selected`
              : ""}
          </p>
          {sorted.length > effectivePageSize ? (
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage(Math.max(1, currentPage - 1))}
                disabled={currentPage <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft />
              </Button>
              <span className="px-1 text-[11px] tabular-nums text-muted-foreground">
                {currentPage} / {pageCount}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
                disabled={currentPage >= pageCount}
                aria-label="Next page"
              >
                <ChevronRight />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {resolved || sent ? (
        <p className="text-[11px] text-muted-foreground">
          {selected.length > 0
            ? `You submitted: ${selected.join(", ")}`
            : "Answered without a row selected."}
        </p>
      ) : selectMode === "single" ? (
        <p className="text-[11px] text-muted-foreground">
          Press the row you mean. That press is the answer.
        </p>
      ) : interactive ? (
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={() => submitRows(selected)}
            disabled={selected.length === 0}
          >
            {submitLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One cell, rendered according to its declared column type. */
function Cell({ column, value }: { column: Column; value: unknown }) {
  switch (column.type) {
    case "number": {
      // Sort numerically (`asNumber`), but *display* exactly what the agent sent. A string
      // like "+318%" or "412ms" carries a sign and a unit, and re-formatting it as a bare
      // number silently deletes meaning the human needs to read the row correctly.
      return (
        <span className="tabular-nums">
          {typeof value === "number" && Number.isFinite(value)
            ? formatNumber(value)
            : cellText(value)}
        </span>
      );
    }
    case "mono":
      return <span className="font-mono text-[11px]">{cellText(value)}</span>;
    case "date":
      return <span>{formatDate(value)}</span>;
    case "badge": {
      const text = cellText(value);
      if (text === "—") return <span className="text-muted-foreground">—</span>;
      return <Badge variant={badgeVariant(text)}>{text}</Badge>;
    }
    default: {
      const text = cellText(value);
      return text === "—" ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span>{text}</span>
      );
    }
  }
}
