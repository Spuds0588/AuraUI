import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Vega } from "react-vega";
import { compile, type TopLevelSpec } from "vega-lite";
import { AlertTriangle } from "lucide-react";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { InteractiveChartProps, Row } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/**
 * A drill-down chart that cannot hallucinate.
 *
 * The agent supplies a Vega-Lite v5 spec and the rows separately. That split is the whole
 * point: the agent writes the *query and the encoding*, the database supplies the numbers,
 * and the two never mix. So the spec references a named data source and the renderer binds
 * `props.data` into it — `props.data` is never inlined into the spec, and the spec is never
 * trusted to contain values.
 *
 * Selections come back as `filter` events, which are terminal: clicking a bar is the answer.
 */

const DEFAULT_DATASET = "auraui";
const SELECTION = "aurauiSel";
const DEFAULT_HEIGHT = 280;

/**
 * AuraUI is a dark-only surface, and Vega-Lite's default theme is a light one: it paints an
 * opaque white plot with near-black labels, which reads as a hole punched in the card. This
 * is the same chart in the canvas's own colours, applied only where the agent did not ask
 * for something specific — a spec carrying its own `config` or `background` still wins.
 */
const DARK_CHART_CONFIG: Record<string, unknown> = {
  background: "transparent",
  view: { stroke: "transparent" },
  axis: {
    domainColor: "hsl(217 33% 28%)",
    gridColor: "hsl(217 33% 20%)",
    labelColor: "hsl(215 20% 68%)",
    titleColor: "hsl(215 20% 58%)",
    tickColor: "hsl(217 33% 32%)",
    labelFontSize: 11,
    titleFontSize: 11,
    titleFontWeight: "normal",
  },
  legend: {
    labelColor: "hsl(215 20% 68%)",
    titleColor: "hsl(215 20% 58%)",
    labelFontSize: 11,
    titleFontSize: 11,
  },
  title: { color: "hsl(210 40% 96%)", fontSize: 12, fontWeight: "normal" },
};


type VegaSpec = ComponentProps<typeof Vega>["spec"];

interface Picked {
  field: string;
  value: unknown;
  values: unknown[];
  datum?: Row;
  all: Row[];
}

/** Which named source the rows should be bound to. */
function datasetName(schema: Record<string, unknown>): string {
  const source = schema.data;
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    const name = (source as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return DEFAULT_DATASET;
}

/** The field of the x encoding, used to synthesise a selection when the spec declares none. */
function firstXField(schema: Record<string, unknown>): string | null {
  const encoding = schema.encoding;
  if (typeof encoding !== "object" || encoding === null) return null;
  const x = (encoding as Record<string, unknown>).x;
  if (typeof x !== "object" || x === null) return null;
  const field = (x as { field?: unknown }).field;
  return typeof field === "string" ? field : null;
}

/**
 * Make a spec renderable: guarantee a named data source, and guarantee a selection param to
 * observe when the agent asked for a drill-down but forgot to declare one.
 */
/**
 * Width taken up by things that are *not* the plot: the holder's padding and border, plus the
 * y-axis gutter (rotated title and tick labels such as "15,000"). Vega-Lite's `width` is the
 * plot area only, so the total graphic is this much wider — subtract it or the graphic
 * overflows the card and clips the last x-axis label.
 */
const CHROME_WIDTH = 72;
/** Never let a measured width get so small that the chart degenerates into a strip. */
const MIN_PLOT_WIDTH = 180;

/**
 * Drop every `bind` from the spec.
 *
 * Vega draws a real checkbox, radio button or dropdown for a bound signal, and a control
 * like that is worse here than a missing one: its changes edit a Vega signal that no AuraUI
 * event carries, so the human would be clicking something the agent never hears about. The
 * bridge refuses a bound spec outright; this is the renderer declining to draw one even if a
 * spec reaches it by another road.
 */
function withoutBinds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBinds);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "bind") continue;
    out[key] = withoutBinds(entry);
  }
  return out;
}

/**
 * Make a spec renderable: guarantee a named data source, a usable width, and a selection
 * param to observe when the agent asked for a drill-down but forgot to declare one.
 *
 * The width is measured here and passed in as a real number rather than handed to Vega-Lite
 * as `"container"`. Container sizing depends on vega-embed measuring its parent at embed
 * time, which silently yields a degenerate plot when it measures zero; a number always
 * renders. An agent that asked for an explicit width still gets it.
 */
function prepare(
  schema: Record<string, unknown>,
  drillable: boolean,
  measuredWidth: number | null,
): Record<string, unknown> {
  // A deep copy, so the pruned spec is never the agent's object and the params below can be
  // edited without touching what arrived.
  const bound: Record<string, unknown> = withoutBinds(schema) as Record<string, unknown>;
  if (!bound.data) bound.data = { name: DEFAULT_DATASET };

  if (bound.width === undefined && measuredWidth !== null) {
    bound.width = Math.max(MIN_PLOT_WIDTH, Math.round(measuredWidth - CHROME_WIDTH));
  }

  if (bound.background === undefined) bound.background = "transparent";
  bound.config =
    bound.config === undefined
      ? DARK_CHART_CONFIG
      : { ...DARK_CHART_CONFIG, ...(bound.config as Record<string, unknown>) };

  const params = Array.isArray(bound.params)
    ? [...(bound.params as Array<Record<string, unknown>>)]
    : [];
  const declared = params.some((param) => param && param.name === SELECTION);

  if (drillable && !declared) {
    const field = firstXField(bound);
    if (field) {
      params.push({
        name: SELECTION,
        select: { type: "point", fields: [field], on: "click", clear: "dblclick" },
      });
    }
  }
  if (params.length > 0) bound.params = params;
  return bound;
}

/** Turn a Vega selection value into something an agent can act on. */
function pick(value: unknown, rows: Row[]): Picked | null {
  if (typeof value !== "object" || value === null) return null;

  // Vega adds `_vgsid_` alongside the real fields; the real one is what the agent asked for.
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key, entry]) =>
      !key.startsWith("_") && entry !== null && entry !== undefined && entry !== "",
  );
  if (entries.length === 0) return null;

  const [field, raw] = entries[0];
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0) return null;

  const all = rows.filter((row) =>
    values.some((candidate) => looseEqual(row[field], candidate)),
  );

  return { field, value: values[0], values, datum: all[0], all };
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

export default function InteractiveChart({
  props,
  respond,
  resolved,
}: TaskComponentProps<InteractiveChartProps>) {
  const { vegaSchema, data, height = DEFAULT_HEIGHT, drillable = false, hint } = props;

  // Measure the card instead of asking Vega to do it. See `prepare`.
  const holderRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      // Round: a fractional difference must not recompile the spec on every frame.
      setMeasuredWidth(width > 0 ? Math.round(width) : null);
    });
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  const compiled = useMemo(() => {
    try {
      const bound = prepare(vegaSchema, drillable, measuredWidth);
      const result = compile(bound as unknown as TopLevelSpec);
      return {
        spec: result.spec as VegaSpec,
        dataset: datasetName(bound),
        error: null as string | null,
      };
    } catch (error) {
      return {
        spec: null,
        dataset: DEFAULT_DATASET,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [drillable, measuredWidth, vegaSchema]);

  const [picked, setPicked] = useState<Picked | null>(null);

  // The signal listener outlives a single render, so it reads these through refs rather than
  // closing over stale props.
  const dataRef = useRef(data);
  const respondRef = useRef(respond);
  const resolvedRef = useRef(resolved);
  const lastSignature = useRef("");

  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  useEffect(() => {
    respondRef.current = respond;
  }, [respond]);
  useEffect(() => {
    resolvedRef.current = resolved;
  }, [resolved]);

  const onSelection = useCallback((_name: string, value: unknown) => {
    if (resolvedRef.current) return;

    const next = pick(value, dataRef.current);
    if (!next) {
      // A cleared selection is not an answer, but re-picking the same mark later should
      // still be reported, so forget the previous signature.
      lastSignature.current = "";
      setPicked(null);
      return;
    }

    const signature = JSON.stringify([next.field, next.value]);
    if (signature === lastSignature.current) return; // a drag fires the signal repeatedly
    lastSignature.current = signature;

    setPicked(next);
    respondRef.current("filter", next);
  }, []);

  // Let vega-embed own the listener lifecycle through `signalListeners`. Attaching by hand
  // from `onNewView` looked equivalent but silently did nothing: vega-embed replaces the
  // view underneath when the spec changes, so a handler bound to the previous view stopped
  // receiving selections, and a `try/catch` around `addSignalListener` hid why.
  const signalListeners = useMemo(
    () => (drillable ? { [SELECTION]: onSelection } : undefined),
    [drillable, onSelection],
  );

  const datasets = useMemo(() => ({ [compiled.dataset]: data }), [compiled.dataset, data]);
  const chartHeight = typeof height === "number" && height > 0 ? height : DEFAULT_HEIGHT;
  const failed = Boolean(compiled.error) || !compiled.spec;

  return (
    <div className="flex flex-col gap-3">
      {failed ? (
        <div
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
          style={{ minHeight: chartHeight }}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 text-xs">
            <p className="font-medium text-destructive">This chart spec could not be compiled.</p>
            <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-destructive/90">
              {compiled.error ?? "The compiled spec was empty."}
            </p>
          </div>
        </div>
      ) : (
        <div
          ref={holderRef}
          className={cn(
            "overflow-hidden rounded-lg border border-border bg-background/40 p-2.5",
            !resolved && drillable && "ring-1 ring-inset ring-accent/20",
          )}
          style={{ height: chartHeight }}
        >
          <Vega
            spec={compiled.spec as VegaSpec}
            data={datasets}
            signalListeners={signalListeners}
            // SVG, not the canvas default. Selections are the whole point of this component
            // and the canvas renderer's coordinate hit-testing silently swallowed every
            // click, so `filter` never fired. SVG also makes marks real DOM nodes, which
            // keeps the plot inspectable. A human-scale HITL chart does not need canvas.
            renderer="svg"
            // No embed menu: it floats over the plot and offers "view source" for a spec
            // the agent already owns. The card is the artifact here, not an image export.
            actions={false}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
        {hint ? <span>{hint}</span> : null}
        {!resolved && drillable && !failed ? (
          <span className="text-accent">Click a mark to drill in.</span>
        ) : null}
        {picked ? (
          <span>
            Selected{" "}
            <span className="font-medium text-foreground">{String(picked.value)}</span>
            {picked.all.length > 1 ? ` (${picked.all.length} rows)` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}
