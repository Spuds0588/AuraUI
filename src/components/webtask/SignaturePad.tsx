import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

/** A signature the human made: a PNG, base64, no `data:` prefix. */
export interface SignatureValue {
  /** The mark itself, as a transparent PNG. */
  png: string;
  /** True when it was typed rather than drawn, which the answer says out loud. */
  typed: boolean;
}

/** The backing store, in pixels. Larger than it is drawn, so a signature stays crisp in a PDF. */
const WIDTH = 720;
const HEIGHT = 220;

/** [sRGB black with the alpha the PDF will draw through]. */
const INK = "#0b1220";

/**
 * Draw a signature, or type one.
 *
 * Two ways in because there are two kinds of person and two kinds of document: a lease wants the
 * mark you have signed a thousand times, and a form field on a phone is easier to type. Both
 * produce the same thing — a PNG with a transparent background — so the PDF path does not care
 * which was used, and the answer still records which it was, because "typed" is a fact a reviewer
 * may care about.
 *
 * What this is not: a cryptographic signature. It is a picture of a signature, drawn onto a page.
 * The card says so, and the protocol doc says so, because an e-sign tool that implies more than it
 * does is worse than one that is plainly a form filler.
 */
export default function SignaturePad({
  value,
  onChange,
  disabled = false,
  label = "Sign here",
  typedName,
  onTypedName,
}: {
  value: SignatureValue | undefined;
  onChange: (value: SignatureValue | undefined) => void;
  disabled?: boolean;
  label?: string;
  typedName: string;
  onTypedName: (name: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<"draw" | "type">(value?.typed ? "type" : "draw");
  const [hasInk, setHasInk] = useState(false);

  const context = useCallback((): CanvasRenderingContext2D | null => {
    const element = canvas.current;
    if (!element) return null;
    const ctx = element.getContext("2d");
    if (!ctx) return null;
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    return ctx;
  }, []);

  const clear = useCallback(() => {
    const element = canvas.current;
    const ctx = context();
    if (!element || !ctx) return;
    ctx.clearRect(0, 0, element.width, element.height);
    setHasInk(false);
    onChange(undefined);
  }, [context, onChange]);

  // Start from an empty pad, and put back a typed signature if this field arrives with one.
  useEffect(() => {
    const element = canvas.current;
    const ctx = context();
    if (!element || !ctx) return;
    ctx.clearRect(0, 0, element.width, element.height);
    setHasInk(false);
    if (value?.typed && typedName.trim() !== "") {
      drawTyped(ctx, typedName);
      setHasInk(true);
    }
    // Deliberately not re-running on `value`: a drawn signature is already on the canvas, and
    // clearing it whenever the parent re-rendered would erase the stroke under the pen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  const emit = useCallback(() => {
    const element = canvas.current;
    if (!element) return;
    const png = element.toDataURL("image/png");
    const comma = png.indexOf(",");
    onChange({ png: png.slice(comma + 1), typed: mode === "type" });
  }, [mode, onChange]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const element = canvas.current;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const scaleX = element.width / Math.max(1, box.width);
    const scaleY = element.height / Math.max(1, box.height);
    return {
      x: (event.clientX - box.left) * scaleX,
      y: (event.clientY - box.top) * scaleY,
    };
  };

  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || mode !== "draw") return;
    const ctx = context();
    const at = point(event);
    if (!ctx || !at) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    last.current = at;
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
    // A tap is a dot: without this a single press draws nothing and the human thinks it is broken.
    ctx.lineTo(at.x + 0.1, at.y + 0.1);
    ctx.stroke();
    setHasInk(true);
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || mode !== "draw") return;
    const ctx = context();
    const at = point(event);
    if (!ctx || !at) return;
    const from = last.current ?? at;
    // Quadratic through the midpoint: a stroke from a pointer is a series of samples, and joining
    // them with straight lines makes a signature look like it was signed by a plotter.
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(from.x, from.y, (from.x + at.x) / 2, (from.y + at.y) / 2);
    ctx.stroke();
    last.current = at;
  };

  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    emit();
  };

  const typeIt = (name: string) => {
    onTypedName(name);
    const element = canvas.current;
    const ctx = context();
    if (!element || !ctx) return;
    ctx.clearRect(0, 0, element.width, element.height);
    if (name.trim() === "") {
      setHasInk(false);
      onChange(undefined);
      return;
    }
    drawTyped(ctx, name);
    setHasInk(true);
    const png = element.toDataURL("image/png");
    onChange({ png: png.slice(png.indexOf(",") + 1), typed: true });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <div className="flex items-center gap-1.5">
          {/* Two buttons rather than a toggle: the canvas has no switches, and a label that says
              which one is live reads at a glance in a way a thumb on a track does not. */}
          <Button
            size="sm"
            variant={mode === "draw" ? "primary" : "ghost"}
            disabled={disabled}
            onClick={() => {
              setMode("draw");
              clear();
            }}
          >
            Draw
          </Button>
          <Button
            size="sm"
            variant={mode === "type" ? "primary" : "ghost"}
            disabled={disabled}
            onClick={() => {
              setMode("type");
              clear();
            }}
          >
            Type
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || !hasInk}
            onClick={clear}
            title="Clear the signature"
          >
            <Eraser aria-hidden="true" className="size-3.5" />
            Clear
          </Button>
        </div>
      </div>

      {mode === "type" ? (
        <Input
          value={typedName}
          disabled={disabled}
          placeholder="Type your name"
          aria-label="Your name"
          onChange={(event) => typeIt(event.target.value)}
          className="h-9"
        />
      ) : null}

      <canvas
        ref={canvas}
        width={WIDTH}
        height={HEIGHT}
        aria-label={`${label}: draw your signature`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        onPointerCancel={up}
        onKeyDown={(event) => {
          if (event.key === "Delete" || event.key === "Backspace") clear();
        }}
        tabIndex={disabled ? -1 : 0}
        className={cn(
          "h-[130px] w-full touch-none rounded-lg border border-dashed border-input bg-background/70",
          mode === "type" ? "pointer-events-none opacity-60" : "cursor-crosshair",
          disabled ? "opacity-50" : null,
        )}
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {mode === "type"
          ? "Your name is drawn onto the page as it is typed."
          : "Draw with the pointer or a finger. Delete clears it."}{" "}
        This seals nothing: it is a picture of your signature drawn onto the document, not a
        cryptographic one.
      </p>
    </div>
  );
}

/** Draw a typed name in a hand-ish face, centred, at a size that fits the pad. */
function drawTyped(ctx: CanvasRenderingContext2D, name: string): void {
  const text = name.trim();
  if (text === "") return;
  let size = 96;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  do {
    ctx.font = `italic ${size}px "Segoe Script", "Bradley Hand", "URW Chancery L", cursive`;
    if (ctx.measureText(text).width <= WIDTH - 48) break;
    size -= 6;
  } while (size > 24);
  ctx.fillText(text, WIDTH / 2, HEIGHT / 2);
}
