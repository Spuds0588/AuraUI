import { useEffect, useRef, useState } from "react";
import { Check, PenLine, Square } from "lucide-react";
import { Button, Input } from "@/components/ui";
import type { SignField } from "@/lib/protocol";
import { renderPage } from "@/lib/pdf";
import SignaturePad, { type SignatureValue } from "./SignaturePad";

type LoadedPdf = Awaited<ReturnType<typeof import("@/lib/pdf")["openPdf"]>>;

/**
 * The document, drawn, with the places to write marked on it.
 *
 * Two surfaces for the same state, on purpose. On the page every field is a dashed box exactly
 * where it goes, which is what makes a filled document *checkable* — you can see at a glance that
 * the signature landed on the signature line and not in the margin. Under the page is the list
 * that actually gets typed into, because a text input sized to the box a form designer drew is
 * eleven pixels tall and nobody can fill in a form like that.
 *
 * Pressing a box scrolls to its row and puts the caret in it: the page is the index, the list is
 * the desk.
 */
export default function PdfDocument({
  pdf,
  fields,
  values,
  checked,
  signatures,
  typedName,
  onTypedName,
  onValue,
  onChecked,
  onSignature,
  disabled,
}: {
  pdf: LoadedPdf;
  fields: SignField[];
  values: Record<string, string>;
  checked: Record<string, boolean>;
  signatures: Record<string, SignatureValue>;
  typedName: string;
  onTypedName: (name: string) => void;
  onValue: (id: string, value: string) => void;
  onChecked: (id: string, value: boolean) => void;
  onSignature: (id: string, value: SignatureValue | undefined) => void;
  disabled: boolean;
}) {
  const [active, setActive] = useState<string | null>(null);
  const rows = useRef<Record<string, HTMLDivElement | null>>({});
  const pages = Array.from({ length: pdf.numPages }, (_, index) => index + 1);

  const focusRow = (id: string) => {
    const row = rows.current[id];
    if (!row) return;
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const control = row.querySelector<HTMLElement>("input, textarea, button");
    control?.focus();
    setActive(id);
  };

  const filled = (field: SignField) => {
    if (field.kind === "signature") return Boolean(signatures[field.id]);
    if (field.kind === "checkbox") return Boolean(checked[field.id]);
    return (values[field.id] ?? field.value ?? "").trim() !== "";
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4">
        {pages.map((page) => (
          <div key={page} className="relative">
            <PdfPage pdf={pdf} page={page} />
            {fields
              .filter((field) => (field.page ?? 1) === page)
              .map((field) => (
                <button
                  key={field.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => focusRow(field.id)}
                  title={`${field.label ?? field.id}: go to this field`}
                  className={[
                    "absolute flex items-center justify-center overflow-hidden rounded-[3px] border-2 border-dashed text-[10px] leading-none transition-colors",
                    filled(field)
                      ? "border-emerald-400/80 bg-emerald-400/15 text-emerald-200"
                      : "border-primary/70 bg-primary/10 text-primary hover:bg-primary/20",
                    active === field.id ? "ring-2 ring-primary/60" : "",
                    disabled ? "cursor-default" : "cursor-pointer",
                  ].join(" ")}
                  style={{
                    left: `${field.x * 100}%`,
                    top: `${field.y * 100}%`,
                    width: `${field.w * 100}%`,
                    height: `${field.h * 100}%`,
                  }}
                >
                  <span className="truncate px-1">
                    {field.kind === "signature"
                      ? signatures[field.id]
                        ? "signed"
                        : "sign"
                      : field.kind === "checkbox"
                        ? checked[field.id]
                          ? "ticked"
                          : "tick"
                        : (values[field.id] ?? field.value ?? "") || (field.label ?? "type")}
                  </span>
                </button>
              ))}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2.5 rounded-lg border border-input bg-background/50 p-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {fields.length === 1 ? "One field to fill" : `${fields.length} fields to fill`}
        </p>
        {fields.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            This document has no fields in it and the agent did not say where anything goes, so
            there is nothing to fill in. Attach the signed copy instead, or ask the agent where to
            sign.
          </p>
        ) : null}

        {fields.map((field) => (
          <div
            key={field.id}
            ref={(element) => {
              rows.current[field.id] = element;
            }}
            className={[
              "flex flex-col gap-2 rounded-lg border p-2.5 transition-colors",
              active === field.id ? "border-primary/50 bg-primary/5" : "border-border/60",
            ].join(" ")}
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xs font-medium text-foreground">
                {field.label ?? field.id}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {field.kind} · page {field.page ?? 1}
              </span>
              {filled(field) ? (
                <span className="flex items-center gap-1 text-[10px] text-emerald-300">
                  <Check aria-hidden="true" className="size-3" />
                  filled
                </span>
              ) : field.required ? (
                <span className="text-[10px] text-amber-300">needs you</span>
              ) : null}
            </div>

            <FieldControl
              field={field}
              value={values[field.id] ?? field.value ?? ""}
              checked={Boolean(checked[field.id])}
              signature={signatures[field.id]}
              typedName={typedName}
              disabled={disabled}
              onTypedName={onTypedName}
              onValue={(value) => onValue(field.id, value)}
              onChecked={(value) => onChecked(field.id, value)}
              onSignature={(value) => onSignature(field.id, value)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One page, rendered at the container's width. */
function PdfPage({ pdf, page }: { pdf: LoadedPdf; page: number }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  // The page is drawn at whatever width the card gives it, so the canvas has to be sized before it
  // is rendered and re-rendered when that changes.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (width <= 0 || !canvas.current) return;
    let cancelled = false;
    void renderPage(pdf, page, canvas.current, width).catch((error: unknown) => {
      if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, page, width]);

  return (
    <div ref={host} className="overflow-hidden rounded-lg border border-border/60 bg-white">
      <canvas ref={canvas} aria-label={`Page ${page}`} className="block w-full" />
      {problem ? (
        <p role="alert" className="bg-background/90 p-3 text-[11px] text-destructive">
          Page {page} could not be drawn: {problem}
        </p>
      ) : null}
    </div>
  );
}

/** The control for one field kind, in the list under the document. */
function FieldControl({
  field,
  value,
  checked,
  signature,
  typedName,
  disabled,
  onTypedName,
  onValue,
  onChecked,
  onSignature,
}: {
  field: SignField;
  value: string;
  checked: boolean;
  signature: SignatureValue | undefined;
  typedName: string;
  disabled: boolean;
  onTypedName: (name: string) => void;
  onValue: (value: string) => void;
  onChecked: (value: boolean) => void;
  onSignature: (value: SignatureValue | undefined) => void;
}) {
  if (field.kind === "signature") {
    return (
      <div className="flex flex-col gap-2">
        {signature ? (
          <div className="flex flex-wrap items-center gap-2">
            <img
              src={`data:image/png;base64,${signature.png}`}
              alt="Your signature"
              className="h-10 rounded border border-border/60 bg-white/90 px-1"
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onSignature(undefined)}
            >
              Sign again
            </Button>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <PenLine aria-hidden="true" className="size-3.5" />
            Draw or type your signature below.
          </p>
        )}
        <SignaturePad
          value={signature}
          onChange={onSignature}
          disabled={disabled}
          label={field.label ?? "Signature"}
          typedName={typedName}
          onTypedName={onTypedName}
        />
      </div>
    );
  }

  if (field.kind === "checkbox") {
    // Two buttons rather than a checkbox. AuraUI has no checkboxes anywhere — a control that hides
    // its own state behind a gesture cannot be read at a glance — and a document's tick box is no
    // exception: this draws the same mark, by pressing the button that names what it does.
    return (
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={checked ? "primary" : "outline"}
          disabled={disabled}
          onClick={() => onChecked(true)}
        >
          <Check aria-hidden="true" className="size-3.5" />
          {field.label ? `Tick “${field.label}”` : "Tick this box"}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChecked(false)}>
          <Square aria-hidden="true" className="size-3.5" />
          Leave it clear
        </Button>
      </div>
    );
  }

  return (
    <Input
      value={value}
      disabled={disabled}
      type={field.kind === "date" ? "date" : "text"}
      placeholder={
        field.kind === "initials"
          ? "Initials"
          : field.kind === "date"
            ? undefined
            : (field.label ?? "Type here")
      }
      aria-label={field.label ?? field.id}
      onChange={(event) => onValue(event.target.value)}
      className="h-9"
    />
  );
}
