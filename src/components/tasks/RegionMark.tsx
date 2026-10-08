import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScanSearch, Send } from "lucide-react";
import { Button } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { RegionBox, RegionMarkProps, RegionPoint } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/**
 * "Show me where."
 *
 * The Oracle case from the PRD — *draw a box around the element that is rendering wrong* — used
 * to need a webview, a native screenshot and a canvas library. It only needs a picture and a
 * place on it, so this takes the picture the agent already has and returns the place.
 *
 * The answer is a **fraction of the image**, never a pixel. The agent knows the size of what it
 * sent; the canvas knows only how large it managed to draw it on whatever screen it landed on.
 * A fraction is the one coordinate both sides agree on without either being told the other's
 * size, and it survives the window being resized between the question and the answer.
 *
 * A `point` is answered by the press that makes it, like a rating point or a row in a table: one
 * gesture, one answer. A `box` is not, and pretending otherwise would be worse than the extra
 * button: releasing a drag is the moment a human is *least* sure they got the edge right, and a
 * rectangle is the one thing here that is easier to get wrong than to say. So a drawn box can be
 * redrawn as many times as it takes and is sent when it looks right.
 *
 * Everything works from the keyboard, because a card that appears over someone's work should
 * never be the one thing they have to reach for the mouse to finish. A crosshair starts at the
 * middle of the picture; the arrow keys move it (Shift for a bigger step), Enter drops the first
 * corner and again the second, and Enter a third time sends the box. In `point` mode Enter
 * simply marks the spot and answers.
 */

/** How close to the edge of the picture a mark has to be, as a fraction, to count as a size. */
const MIN_SPAN = 0.005;

/** A click that moves less than this many pixels is a click, not a drag. */
const DRAG_SLOP_PX = 4;

interface Editable {
  /** Top-left corner, already normalised. */
  anchor: RegionPoint;
  /** The opposite corner while the human is still choosing. */
  cursor: RegionPoint;
  /** True once both corners are dropped, i.e. the box is a box and not a preview. */
  complete: boolean;
}

function boxOf(anchor: RegionPoint, cursor: RegionPoint): RegionBox {
  const x = Math.min(anchor.x, cursor.x);
  const y = Math.min(anchor.y, cursor.y);
  return {
    x,
    y,
    w: Math.abs(cursor.x - anchor.x),
    h: Math.abs(cursor.y - anchor.y),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Trim a fraction to something an agent can read and a human can recognise. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export default function RegionMark({ props, respond, resolved }: TaskComponentProps<RegionMarkProps>) {
  const mode = props?.mode === "point" ? "point" : "box";
  const src = typeof props?.src === "string" ? props.src : "";

  const image = useRef<HTMLImageElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ from: RegionPoint; moved: boolean } | null>(null);

  const [crosshair, setCrosshair] = useState<RegionPoint>({ x: 0.5, y: 0.5 });
  const [edit, setEdit] = useState<Editable | null>(null);
  const [marked, setMarked] = useState<RegionPoint | null>(null);
  const [sent, setSent] = useState(false);
  const [broken, setBroken] = useState(false);
  const locked = resolved || sent;

  // Aspect ratio for the frame, so the picture does not push the card's height around once it
  // loads. Falls back to the image's own reported size, then to a landscape default.
  const ratio = useMemo(() => {
    const width = typeof props?.width === "number" && props.width > 0 ? props.width : undefined;
    const height = typeof props?.height === "number" && props.height > 0 ? props.height : undefined;
    if (width && height) return width / height;
    const natural = image.current;
    if (natural && natural.naturalWidth > 0) return natural.naturalWidth / natural.naturalHeight;
    return 16 / 9;
  }, [props?.height, props?.width, broken]);

  const region = mode === "box" && edit?.complete ? boxOf(edit.anchor, edit.cursor) : null;
  const canSend = mode === "box" && region !== null && !locked;

  /** Screen coordinates to a fraction of the picture. */
  const locate = useCallback((event: { clientX: number; clientY: number }): RegionPoint => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0.5, y: 0.5 };
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  }, []);

  const sendPoint = useCallback(
    (point: RegionPoint) => {
      if (locked) return;
      setSent(true);
      setCrosshair(point);
      setMarked(point);
      respond("submit", {
        component: "RegionMark",
        mode: "point",
        point: { x: round(point.x), y: round(point.y) },
      });
    },
    [locked, respond],
  );

  const sendBox = useCallback(() => {
    const box = region;
    if (!box || locked) return;
    if (box.w < MIN_SPAN || box.h < MIN_SPAN) return;
    setSent(true);
    respond("submit", {
      component: "RegionMark",
      mode: "box",
      region: { x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) },
    });
  }, [locked, region, respond]);

  /** One pointer press: start a box, finish one, or answer outright in point mode. */
  const press = (event: React.PointerEvent<HTMLDivElement>) => {
    if (locked || broken) return;
    const at = locate(event);
    setCrosshair(at);

    if (mode === "point") {
      // Held, not answered yet: a press that turns into a drag is someone gesturing around the
      // picture rather than choosing a spot, and a spot chosen by accident cannot be taken back.
      dragging.current = { from: at, moved: false };
      return;
    }

    dragging.current = { from: at, moved: false };
    setEdit((current) => {
      if (!current || current.complete) return { anchor: at, cursor: at, complete: false };
      // A second click completes the box the first click started.
      return { anchor: current.anchor, cursor: at, complete: true };
    });
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (locked || broken) return;
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

    if (mode === "box" && edit && !edit.complete) {
      setEdit({ anchor: edit.anchor, cursor: at, complete: false });
    }
  };

  const release = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    dragging.current = null;
    if (locked || broken || !drag) return;
    const at = locate(event);

    if (mode === "point") {
      if (!drag.moved) sendPoint(at);
      return;
    }
    // A drag that travelled is a box: the release is the second corner, the same as a second
    // click would be. A press that stayed put leaves the anchor down, waiting for that click.
    if (drag.moved) {
      setEdit((current) =>
        current && !current.complete ? { anchor: current.anchor, cursor: at, complete: true } : current,
      );
    }
  };

  /** Shift moves the crosshair further, which is how a whole card is crossed in a few presses. */
  const nudge = useCallback(
    (dx: number, dy: number, big: boolean) => {
      const step = big ? 0.1 : 0.01;
      setCrosshair((current) => {
        const next = {
          x: clamp01(Number((current.x + dx * step).toFixed(4))),
          y: clamp01(Number((current.y + dy * step).toFixed(4))),
        };
        setEdit((open) => (open && !open.complete ? { ...open, cursor: next } : open));
        return next;
      });
    },
    [],
  );

  // The keys are the whole keyboard story: arrows to aim, Enter to place, Enter again to send.
  // Escape belongs to the card, not to the picture, so a box is never cleared with it.
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
      if (event.key !== "Enter" || event.repeat) return;
      event.preventDefault();
      if (mode === "point") {
        sendPoint(crosshair);
        return;
      }
      if (!edit || edit.complete) {
        setEdit({ anchor: crosshair, cursor: crosshair, complete: false });
      } else if (boxOf(edit.anchor, edit.cursor).w < MIN_SPAN && boxOf(edit.anchor, edit.cursor).h < MIN_SPAN) {
        // Two Enters in the same spot would be a zero-area box; the first press is still live.
        setEdit({ anchor: edit.anchor, cursor: crosshair, complete: false });
      } else {
        setEdit({ anchor: edit.anchor, cursor: crosshair, complete: true });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [broken, crosshair, edit, locked, mode, nudge, sendPoint]);

  if (src === "") {
    return (
      <p className="text-xs text-muted-foreground">
        This mark-up arrived without a picture, so there is nothing to draw on.
      </p>
    );
  }

  const preview = mode === "box" && edit ? boxOf(edit.anchor, edit.cursor) : null;

  return (
    <div className="flex flex-col gap-3.5">
      {props?.label ? (
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {props.label}
        </p>
      ) : null}

      <div
        ref={frame}
        role="group"
        aria-label={props?.alt ?? "Picture to mark"}
        // Touch-action off so a drag draws a box instead of scrolling the card underneath it.
        className={cn(
          "relative select-none overflow-hidden rounded-lg border border-input bg-background/60",
          broken ? "cursor-default" : mode === "point" ? "cursor-crosshair" : "cursor-crosshair",
        )}
        style={{ aspectRatio: `${ratio}` }}
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
              The picture this question is about did not load, so there is nothing to mark. The
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

        {/* The drawing itself. The dim outside it is one enormous outer shadow on the box
            rather than a cut-out layer: the frame already clips its overflow, so the shadow
            covers the rest of the picture and stops dead at its edge — no clip-path,
            no winding rules and no second element to keep in step with this one. */}
        {preview ? (
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute border-2",
              edit?.complete ? "border-primary bg-primary/10" : "border-primary/70 border-dashed",
            )}
            style={{
              left: `${preview.x * 100}%`,
              top: `${preview.y * 100}%`,
              width: `${preview.w * 100}%`,
              height: `${preview.h * 100}%`,
              boxShadow: "0 0 0 9999px rgba(8, 12, 23, 0.55)",
            }}
          />
        ) : null}

        {/* The crosshair. Always drawn while the question is open, because it is also the keyboard
            cursor and an invisible cursor is one nobody can aim. */}
        {!locked && !broken ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{ left: `${crosshair.x * 100}%`, top: `${crosshair.y * 100}%` }}
          >
            <div className="absolute -left-px -top-px size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary bg-primary/40" />
          </div>
        ) : null}

        {/* Once answered, the mark stays on the picture: it is the receipt. */}
        {marked ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-primary/25 ring-2 ring-background/60"
            style={{ left: `${marked.x * 100}%`, top: `${marked.y * 100}%` }}
          />
        ) : null}
      </div>

      {mode === "box" && !locked && !broken ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant={canSend ? "primary" : "outline"} onClick={sendBox} disabled={!canSend}>
            <Send aria-hidden="true" className="size-3.5" />
            {props?.submitLabel ?? "Send this area"}
          </Button>
          {edit && !edit.complete ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEdit(null)}
              title="Clear the corner you just dropped"
            >
              Start over
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {props?.help ??
          (broken
            ? "Nothing to mark until the picture loads."
            : sent
              ? mode === "point"
                ? `Marked ${marked ? percent(marked.x) : ""} across, ${marked ? percent(marked.y) : ""} down.`
                : region
                  ? `Sent ${percent(region.w)} by ${percent(region.h)} at ${percent(region.x)}, ${percent(region.y)}.`
                  : "Sent."
              : mode === "point"
                ? "Click the spot. That click is the answer. Arrow keys aim, Enter marks."
                : edit?.complete
                  ? "Send it, or drag again to redraw."
                  : edit
                    ? "Release to finish the box, or click opposite corner. Arrow keys aim, Enter drops a corner."
                    : "Drag across the thing that is wrong. Arrow keys aim, Enter drops a corner.")}
      </p>
    </div>
  );
}
