import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Pencil,
  ScanSearch,
  Send,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { Button, KeyHint } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import { useOptionKeys } from "@/lib/keyboard";
import {
  describeShapes,
  MARK_TOOLS,
  type MarkPoint,
  type MarkShape,
  type MarkTool,
  type RegionMarkProps,
} from "@/lib/protocol";
import { cn } from "@/lib/utils";

/**
 * "Show me where", as a drawing surface.
 *
 * The first version of this card existed to collect one box, and one box is a poor vocabulary for
 * "here is what is wrong". The useful answer is usually several marks and the relationship between
 * them — circle the panel, then an arrow from it to the number that went wrong, then an X on the
 * thing that should not be there — and asking for a single selection made people describe that in
 * their head instead of drawing it. So this is a canvas: five pens, as many marks as the answer
 * needs, undo for the ones that came out wrong.
 *
 * Everything is a vector in fractions of the picture, never a flattened screenshot of a drawing.
 * An agent gets `shapes` it can read, place, and reason about; a rasterised image would give it a
 * picture of an answer instead of an answer. Fractions rather than pixels for the same reason as
 * before: the agent knows the size of the image it sent and the canvas knows only how large it
 * drew it on this screen, so a fraction is the coordinate that needs no agreement about size.
 *
 * Two of the five pens need one point and three need two. A `cross` is placed by the press that
 * makes it. A `rect`, `ellipse` or `arrow` is drawn and then sent, because a drag is a shape the
 * human is still choosing and the release is the moment they are least sure of it — so a drawing
 * keeps a button, and every mark between the first and the last is undoable.
 *
 * The keyboard is a first-class way to draw, not a fallback. Digits pick the pen (each is printed
 * on its button), the arrow keys aim a crosshair, Enter drops the first point and again the second,
 * Backspace takes back the last mark, and Enter on an empty pen sends the drawing.
 */

/** How small a drag can be and still be a shape, as a fraction of the picture. */
const MIN_SPAN = 0.01;

/** Moves under this many pixels are a click, not a drag. */
const DRAG_SLOP_PX = 4;

/** Freehand points closer together than this are noise, so they are not kept. */
const PATH_STEP = 0.004;

const TOOL_META: Record<MarkTool, { label: string; Glyph: typeof Square }> = {
  rect: { label: "Box", Glyph: Square },
  ellipse: { label: "Circle", Glyph: Circle },
  arrow: { label: "Arrow", Glyph: ArrowUpRight },
  cross: { label: "X", Glyph: X },
  path: { label: "Pen", Glyph: Pencil },
};

interface Draft {
  /** The pen this draft is being drawn with. */
  tool: MarkTool;
  anchor: MarkPoint;
  cursor: MarkPoint;
  /** Freehand only: the line as it is being drawn. */
  points?: MarkPoint[];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Trim a fraction to something an agent can read and a human can recognise. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundPoint(point: MarkPoint): MarkPoint {
  return { x: round(point.x), y: round(point.y) };
}

/** True for the two marks drawn as a box. A predicate rather than the same test inline, because
 * `MarkBoxShape` carries both kinds in one interface and TypeScript will not narrow it away from
 * a compound `kind` comparison on its own. */
function isBox(shape: MarkShape): shape is Extract<MarkShape, { kind: "rect" | "ellipse" }> {
  return shape.kind === "rect" || shape.kind === "ellipse";
}

function boxOf(anchor: MarkPoint, cursor: MarkPoint) {
  return {
    x: Math.min(anchor.x, cursor.x),
    y: Math.min(anchor.y, cursor.y),
    w: Math.abs(cursor.x - anchor.x),
    h: Math.abs(cursor.y - anchor.y),
  };
}

/** A draft becomes the shape that gets sent, or nothing at all when it is too small to mean it. */
function commit(draft: Draft): MarkShape | null {
  if (draft.tool === "path") {
    const points = draft.points ?? [];
    if (points.length < 2) return null;
    return { kind: "path", points: points.map(roundPoint) };
  }
  if (draft.tool === "cross") {
    return { kind: "cross", at: roundPoint(draft.cursor) };
  }

  const box = boxOf(draft.anchor, draft.cursor);
  if (box.w < MIN_SPAN && box.h < MIN_SPAN) return null;

  if (draft.tool === "arrow") {
    // An arrow is a direction, so it keeps the two ends as they were drawn rather than being
    // normalised into a box: which end is the head is half of what it says. A perfectly
    // horizontal or vertical arrow is legitimate; only the dot the check above rejects is not.
    return { kind: "arrow", from: roundPoint(draft.anchor), to: roundPoint(draft.cursor) };
  }
  if (draft.tool === "ellipse") {
    return { kind: "ellipse", x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) };
  }
  return { kind: "rect", x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) };
}

export default function RegionMark({ props, respond, resolved }: TaskComponentProps<RegionMarkProps>) {
  const src = typeof props?.src === "string" ? props.src : "";

  const offered = useMemo<MarkTool[]>(() => {
    const asked = Array.isArray(props?.tools) ? props.tools : [];
    const known = asked.filter((tool): tool is MarkTool =>
      (MARK_TOOLS as readonly string[]).includes(tool),
    );
    return known.length > 0 ? known : [...MARK_TOOLS];
  }, [props?.tools]);

  const [tool, setTool] = useState<MarkTool>(() =>
    (MARK_TOOLS as readonly string[]).includes(props?.tool ?? "") ? (props.tool as MarkTool) : offered[0],
  );

  const image = useRef<HTMLImageElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ from: MarkPoint; moved: boolean } | null>(null);

  const [shapes, setShapes] = useState<MarkShape[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [crosshair, setCrosshair] = useState<MarkPoint>({ x: 0.5, y: 0.5 });
  const [sent, setSent] = useState(false);
  const [broken, setBroken] = useState(false);
  const locked = resolved || sent;

  // The aspect box, so the picture does not shove the card's height around once it loads.
  const ratio = useMemo(() => {
    const width = typeof props?.width === "number" && props.width > 0 ? props.width : undefined;
    const height = typeof props?.height === "number" && props.height > 0 ? props.height : undefined;
    if (width && height) return width / height;
    const natural = image.current;
    if (natural && natural.naturalWidth > 0) return natural.naturalWidth / natural.naturalHeight;
    return 16 / 9;
  }, [props?.height, props?.width, broken]);

  /** Screen coordinates to a fraction of the picture. */
  const locate = useCallback((event: { clientX: number; clientY: number }): MarkPoint => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0.5, y: 0.5 };
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  }, []);

  const addShape = useCallback((shape: MarkShape | null) => {
    if (shape) setShapes((current) => [...current, shape]);
  }, []);

  const undo = useCallback(() => {
    setShapes((current) => (current.length === 0 ? current : current.slice(0, -1)));
  }, []);

  const clear = useCallback(() => {
    setShapes([]);
    setDraft(null);
  }, []);

  const send = useCallback(() => {
    if (locked || shapes.length === 0) return;
    setSent(true);
    respond("submit", { component: "RegionMark", shapes });
  }, [locked, respond, shapes]);

  const press = (event: React.PointerEvent<HTMLDivElement>) => {
    if (locked || broken) return;
    const at = locate(event);
    setCrosshair(at);
    dragging.current = { from: at, moved: false };

    // A click with the X pen is answered there and then: it needs one point, and a drag with it
    // would not say anything a press does not.
    setDraft({ tool, anchor: at, cursor: at, points: tool === "path" ? [at] : undefined });
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (locked || broken || !draft) return;
    const at = locate(event);
    setCrosshair(at);

    const drag = dragging.current;
    if (drag) {
      const rect = frame.current?.getBoundingClientRect();
      const slop = rect ? DRAG_SLOP_PX / Math.max(rect.width, 1) : 0;
      if (Math.abs(at.x - drag.from.x) > slop || Math.abs(at.y - drag.from.y) > slop) {
        drag.moved = true;
      }
    }

    if (draft.tool === "path") {
      const points = draft.points ?? [];
      const last = points[points.length - 1];
      // Freehand keeps the line, not every pixel of the pointer's travel.
      if (last && Math.hypot(at.x - last.x, at.y - last.y) < PATH_STEP) return;
      setDraft({ ...draft, cursor: at, points: [...points, at] });
      return;
    }
    setDraft({ ...draft, cursor: at });
  };

  const release = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    dragging.current = null;
    if (locked || broken || !draft) return;
    const at = locate(event);
    const finished: Draft = { ...draft, cursor: at, points: draft.tool === "path" ? [...(draft.points ?? []), at] : draft.points };

    // A two-point pen needs a drag to be a shape. A press that stayed put leaves the draft open
    // for the keyboard — the crosshair picks the second corner with Enter — rather than adding a
    // dot nobody meant.
    if (draft.tool !== "cross" && draft.tool !== "path" && !drag?.moved) {
      setDraft(finished);
      return;
    }
    if (draft.tool === "path" && !drag?.moved) {
      setDraft(null);
      return;
    }
    addShape(commit(finished));
    setDraft(null);
  };

  /** Shift moves the crosshair further, which is how a mark is placed from the keyboard. */
  const nudge = useCallback((dx: number, dy: number, big: boolean) => {
    const step = big ? 0.05 : 0.01;
    setCrosshair((current) => {
      const next = {
        x: clamp01(Number((current.x + dx * step).toFixed(4))),
        y: clamp01(Number((current.y + dy * step).toFixed(4))),
      };
      setDraft((open) =>
        open
          ? { ...open, cursor: next, points: open.tool === "path" ? [...(open.points ?? []), next] : open.points }
          : open,
      );
      return next;
    });
  }, []);

  // Arrows aim, Enter places, Backspace takes the last mark back. The keys a drawing needs are
  // few; Escape stays the card's, so a drawing is never thrown away by aiming at it.
  useEffect(() => {
    if (locked || broken) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }

      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const arrow = arrows[event.key];
      if (arrow) {
        event.preventDefault();
        nudge(arrow[0], arrow[1], event.shiftKey);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        if (draft) setDraft(null);
        else undo();
        return;
      }

      if (event.key !== "Enter" || event.repeat) return;
      event.preventDefault();
      if (!draft) {
        // Nothing open: drop the first point with this pen, exactly as a press would.
        if (tool === "cross") {
          addShape({ kind: "cross", at: roundPoint(crosshair) });
        } else {
          setDraft({ tool, anchor: crosshair, cursor: crosshair, points: tool === "path" ? [crosshair] : undefined });
        }
        return;
      }
      addShape(commit({ ...draft, cursor: crosshair }));
      setDraft(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addShape, broken, crosshair, draft, locked, nudge, tool, undo]);

  // Digits pick the pen, and the digit is printed on its button, so the keyboard route is visible
  // rather than advertised somewhere else.
  const keys = useMemo(() => offered.slice(0, 9).map((_, index) => String(index + 1)), [offered]);
  useOptionKeys(() =>
    offered.slice(0, 9).map((name, index) => ({
      key: keys[index] ?? "",
      run: () => {
        setTool(name);
        setDraft(null);
      },
      disabled: locked,
    })),
  );

  if (src === "") {
    return (
      <p className="text-xs text-muted-foreground">
        This mark-up arrived without a picture, so there is nothing to draw on.
      </p>
    );
  }

  /** What the open draft would become if it were committed right now. */
  const preview = draft
    ? draft.tool === "cross"
      ? ({ kind: "cross", at: draft.cursor } as MarkShape)
      : commit(draft)
    : null;

  return (
    <div className="flex flex-col gap-3.5">
      {props?.label ? (
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {props.label}
        </p>
      ) : null}

      {!locked && !broken ? (
        <div className="flex flex-wrap items-center gap-2">
          {offered.slice(0, 9).map((name, index) => {
            const meta = TOOL_META[name];
            const on = tool === name;
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setTool(name);
                  setDraft(null);
                }}
                className={cn(
                  "flex min-h-9 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  on
                    ? "border-primary bg-primary/20 text-foreground ring-1 ring-primary/50"
                    : "border-input bg-background/60 text-foreground/80 hover:bg-secondary/60",
                )}
              >
                <meta.Glyph aria-hidden="true" className="size-3.5" />
                {meta.label}
                <KeyHint keys={keys[index]} />
              </button>
            );
          })}

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={shapes.length === 0}
              onClick={undo}
              title="Take back the last mark (Backspace)"
            >
              <Undo2 aria-hidden="true" className="size-3.5" />
              Undo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={shapes.length === 0}
              onClick={clear}
              title="Clear the drawing"
            >
              <Eraser aria-hidden="true" className="size-3.5" />
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      <div
        ref={frame}
        role="group"
        aria-label={props?.alt ?? "Picture to draw on"}
        className="relative select-none overflow-hidden rounded-lg border border-input bg-background/60"
        style={{ aspectRatio: `${ratio}`, cursor: broken ? "default" : "crosshair", touchAction: "none" }}
        onPointerDown={press}
        onPointerMove={move}
        onPointerUp={release}
        onPointerLeave={() => {
          dragging.current = null;
        }}
      >
        {broken ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <ScanSearch aria-hidden="true" className="size-5 text-muted-foreground" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              The picture this question is about did not load, so there is nothing to draw on. The
              agent needs to send an <span className="font-mono">https:</span> image or the bytes
              themselves as a <span className="font-mono">data:</span> URL.
            </p>
          </div>
        ) : (
          <img
            ref={image}
            src={src}
            alt={props?.alt ?? ""}
            draggable={false}
            onError={() => setBroken(true)}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        )}

        {/* The marks. Boxes and circles are elements and arrows and lines are SVG, because a
            stroke in a scaled SVG would otherwise be stretched by the picture's aspect ratio —
            `non-scaling-stroke` keeps every line the same weight however the frame is shaped. */}
        {!broken
          ? shapes.map((shape, index) => (
              <Shape key={index} shape={shape} index={index + 1} />
            ))
          : null}

        {preview && !broken ? <Shape shape={preview} draft index={shapes.length + 1} /> : null}

        {/* The crosshair: the keyboard's pointer, drawn because an invisible one cannot be aimed. */}
        {!locked && !broken ? (
          <span aria-hidden="true" className="pointer-events-none absolute" style={{ left: `${crosshair.x * 100}%`, top: `${crosshair.y * 100}%` }}>
            <span className="absolute -left-px -top-px size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary bg-primary/40" />
          </span>
        ) : null}
      </div>

      {!locked && !broken ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant={shapes.length > 0 ? "primary" : "outline"} disabled={shapes.length === 0} onClick={send}>
            <Send aria-hidden="true" className="size-3.5" />
            {props?.submitLabel ?? "Send this drawing"}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {shapes.length === 0
              ? "Nothing drawn yet."
              : `${shapes.length} mark${shapes.length === 1 ? "" : "s"} drawn.`}
          </span>
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {props?.help ??
          (broken
            ? "Nothing to draw on until the picture loads."
            : locked
              ? describeShapes(shapes)
              : draft
                ? "Release to finish this mark, or aim with the arrow keys and press Enter."
                : "Pick a pen and draw. An X needs one press; a box, circle or arrow needs a drag. Arrow keys aim, Enter draws, Backspace undoes.")}
      </p>
    </div>
  );
}

/**
 * One mark, drawn over the picture.
 *
 * A box or a circle is an element with percentage geometry, which stays crisp at any size and any
 * aspect ratio. Arrows and freehand lines are SVG, whose `viewBox` is a 1000x1000 unit space
 * stretched to the frame — so a coordinate in it is just the fraction times a thousand — with
 * `vector-effect: non-scaling-stroke`, because a stroke in a stretched viewBox would otherwise be
 * thicker along one axis than the other.
 *
 * Every mark carries its number, in the order it was drawn. That is not decoration: "the arrow
 * from mark 1" is a sentence the agent and the human can both check, and without numbers the only
 * way to refer to a mark is to describe where it is.
 */
function Shape({ shape, index, draft = false }: { shape: MarkShape; index: number; draft?: boolean }) {
  const stroke = draft ? "hsl(var(--primary) / 0.7)" : "hsl(var(--primary))";
  const dash = draft ? "6 6" : undefined;
  const unit = (value: number) => value * 1000;
  const at = (point: MarkPoint) => `${unit(point.x)} ${unit(point.y)}`;

  const badge = (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground shadow"
    >
      {index}
    </span>
  );

  if (isBox(shape)) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute border-2",
          shape.kind === "ellipse" ? "rounded-[50%]" : "rounded-sm",
          draft ? "border-primary/70 border-dashed" : "border-primary",
        )}
        style={{
          left: `${shape.x * 100}%`,
          top: `${shape.y * 100}%`,
          width: `${shape.w * 100}%`,
          height: `${shape.h * 100}%`,
        }}
      >
        <span className="absolute -left-2 -top-2">{badge}</span>
      </span>
    );
  }

  // Where the number hangs. Only the three stroke kinds get here — a box or a circle carries its
  // number at its own top-left corner, a few lines up.
  const origin =
    shape.kind === "cross"
      ? shape.at
      : shape.kind === "arrow"
        ? shape.from
        : (shape.points[0] ?? { x: 0.5, y: 0.5 });

  // The arrow's head: two short lines back from the tip, at the angle it arrived from. The
  // maths is in the 1000-unit space and the stretch distorts the angle a little; a sketched
  // arrow is not a diagram, and being able to see which end is the head is all it has to do.
  let head: MarkPoint[] = [];
  if (shape.kind === "arrow") {
    const dx = shape.to.x - shape.from.x;
    const dy = shape.to.y - shape.from.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const spread = 0.5;
    const back = 0.03;
    head = [0, -1].map((side) => {
      const angle = side * spread;
      const nx = ux * Math.cos(angle) - uy * Math.sin(angle);
      const ny = ux * Math.sin(angle) + uy * Math.cos(angle);
      return { x: shape.to.x - back * nx, y: shape.to.y - back * ny };
    });
  }

  return (
    <>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
      >
        <g stroke={stroke} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round">
          {shape.kind === "cross" ? (
            <>
              <line x1={unit(shape.at.x - 0.018)} y1={unit(shape.at.y - 0.018)} x2={unit(shape.at.x + 0.018)} y2={unit(shape.at.y + 0.018)} vectorEffect="non-scaling-stroke" />
              <line x1={unit(shape.at.x - 0.018)} y1={unit(shape.at.y + 0.018)} x2={unit(shape.at.x + 0.018)} y2={unit(shape.at.y - 0.018)} vectorEffect="non-scaling-stroke" />
            </>
          ) : null}
          {shape.kind === "arrow" ? (
            <>
              <line x1={unit(shape.from.x)} y1={unit(shape.from.y)} x2={unit(shape.to.x)} y2={unit(shape.to.y)} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
              {head.map((point, side) => (
                <line
                  key={side}
                  x1={unit(shape.to.x)}
                  y1={unit(shape.to.y)}
                  x2={unit(point.x)}
                  y2={unit(point.y)}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </>
          ) : null}
          {shape.kind === "path" ? (
            <polyline points={shape.points.map(at).join(" ")} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
          ) : null}
        </g>
      </svg>
      <span className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${origin.x * 100}%`, top: `${origin.y * 100}%` }}>
        {badge}
      </span>
    </>
  );
}
