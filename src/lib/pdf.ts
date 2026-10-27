import type { PDFDocument as PdfLibDocument, PDFForm } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
// Vite resolves this to the worker asset and hands back its URL, which is the one form of worker
// setup that survives a production build without a copy step. Only the URL is imported: the
// library itself is loaded on demand below.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { SignField, SignFieldKind } from "./protocol";

/**
 * Reading a PDF, and writing a signature back into it.
 *
 * Two libraries doing two jobs, and the split matters:
 *
 * - **pdf.js renders.** It draws the pages the human is looking at and it reports where the
 *   document's own form widgets are. It never writes.
 * - **pdf-lib writes.** It fills fields, stamps a drawn signature as an image, flattens the form
 *   and serializes the bytes. It never renders.
 *
 * The alternative was a service that does both, which would mean an agent's document leaving this
 * machine to be signed. A lease, a medical form, a tax return: none of those should be uploaded to
 * a third party because the canvas wanted a nicer text field. So it all happens here, in the page,
 * with no network request to anything but the document's own URL.
 *
 * What this cannot do, said plainly because the card says it too: a drawn signature is a *picture*
 * of a signature. pdf-lib has no cryptographic signing, and an encrypted document cannot be loaded
 * at all. Both are reported rather than worked around.
 */

/*
 * Both libraries are loaded on demand rather than at import time.
 *
 * Together they are about 1.5 MB of code, and a canvas that draws one question at a time would be
 * paying that on every launch for a component most sessions never see. The first signature card
 * pulls them in; every other card never knows they exist. The module's own API is unchanged, so
 * nothing above this line has to care.
 */
let pdfjsModule: typeof import("pdfjs-dist") | undefined;
let pdfLibModule: typeof import("pdf-lib") | undefined;

async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsModule) {
    const module = await import("pdfjs-dist");
    module.GlobalWorkerOptions.workerSrc = workerUrl;
    pdfjsModule = module;
  }
  return pdfjsModule;
}

async function loadPdfLib(): Promise<typeof import("pdf-lib")> {
  if (!pdfLibModule) {
    pdfLibModule = await import("pdf-lib");
  }
  return pdfLibModule;
}

/** The kinds of field this module fills. The canvas's `SignFieldKind` is the public vocabulary. */
export interface PdfWidget {
  /** The document's own field name, absent on a widget pdf.js cannot name. */
  name?: string;
  kind: "text" | "checkbox" | "signature";
  /** One-based. */
  page: number;
  /** Fractions of the page, origin top-left: the same coordinates `SignField` uses. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** What the document already has in it, so the canvas can show a filled form. */
  value?: string;
}

export interface PdfOutline {
  pages: number;
  widgets: PdfWidget[];
  /** True when the document carries an AcroForm. */
  hasForm: boolean;
  /** True for a document that is XFA rather than AcroForm, which pdf-lib cannot fill. */
  isXfa: boolean;
}

/** One field's value, on the way into the document. */
export interface FillFieldInput {
  /** Matches the `SignField` id or the document's own field name. */
  id: string;
  kind: SignFieldKind;
  /** One-based. */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** text, date and initials. */
  value?: string;
  /** checkbox. */
  checked?: boolean;
  /** signature: base64 PNG, no `data:` prefix. */
  signaturePng?: string;
}

export class PdfProblem extends Error {
  constructor(
    message: string,
    /** What the card should offer instead when this happens. */
    readonly recoverable: boolean = true,
  ) {
    super(message);
    this.name = "PdfProblem";
  }
}

/* ------------------------------------------------------------------ *
 * Bytes
 * ------------------------------------------------------------------ */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(index, index + chunk)));
  }
  return window.btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Fetch the document's bytes.
 *
 * A `data:` URL is decoded locally, which is how an agent hands over bytes it already has, and
 * anything else is fetched over the network — the bridge has already refused any scheme that is
 * not https (or a loopback tool), so this cannot be talked into reading the disk.
 */
export async function fetchPdfBytes(src: string): Promise<Uint8Array> {
  const comma = src.startsWith("data:") ? src.indexOf(",") : -1;
  if (comma >= 0) {
    const meta = src.slice(5, comma);
    if (!meta.includes("pdf")) {
      throw new PdfProblem("That data URL is not a PDF.", false);
    }
    return base64ToBytes(src.slice(src.indexOf("base64,") >= 0 ? src.indexOf("base64,") + 7 : comma + 1));
  }

  let response: Response;
  try {
    response = await fetch(src, { credentials: "omit", redirect: "follow" });
  } catch (error) {
    throw new PdfProblem(`Could not fetch the document: ${String(error)}`, false);
  }
  if (!response.ok) {
    throw new PdfProblem(
      `The document could not be fetched (${response.status} ${response.statusText}).`,
      false,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

type LoadedPdf = PDFDocumentProxy;

/**
 * Open a document for rendering and inspection.
 *
 * The bytes are copied before they are handed to pdf.js on purpose: pdf.js transfers the buffer to
 * its worker, which *detaches* it, and the same bytes are needed again later by pdf-lib to write
 * the filled document. A detached buffer here would fail at the last step of a signing, which is
 * the worst possible place to find out.
 */
export async function openPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  const pdfjs = await loadPdfjs();
  try {
    // Nothing else is configured on purpose: a document whose fonts are not embedded draws with
    // fallbacks and logs a warning rather than failing, and most documents a person is asked to
    // sign embed their own faces anyway.
    return await pdfjs.getDocument({ data: bytes.slice() }).promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) {
      throw new PdfProblem("That document is password-protected, so it cannot be filled here.");
    }
    throw new PdfProblem(`That document could not be opened as a PDF: ${message}`);
  }
}

/** How far into a document the canvas will look for form fields. */
const WIDGET_PAGE_LIMIT = 200;

/**
 * Where the document's own fields are.
 *
 * pdf.js reports annotation rectangles in PDF user space — points, origin bottom-left — so they are
 * converted through the page's viewport at scale 1 into fractions of the page, which is the
 * coordinate language the whole component speaks. Doing it at scale 1 matters: the fractions have
 * to mean the same thing whatever size the canvas happens to be drawing.
 */
export async function readOutline(document: LoadedPdf): Promise<PdfOutline> {
  const pages = document.numPages;
  const widgets: PdfWidget[] = [];
  const last = Math.min(pages, WIDGET_PAGE_LIMIT);

  for (let number = 1; number <= last; number += 1) {
    let annotations: Awaited<ReturnType<Awaited<ReturnType<LoadedPdf["getPage"]>>["getAnnotations"]>>;
    try {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      annotations = await page.getAnnotations({ intent: "display" });
      for (const annotation of annotations) {
        const widget = annotation as {
          subtype?: string;
          fieldName?: string;
          fieldType?: string;
          fieldValue?: unknown;
          rect?: number[];
        };
        if (widget.subtype !== "Widget" || !widget.rect || widget.rect.length < 4) continue;
        // Two corners rather than a rectangle helper: pdf.js v6 converts points, and a widget rect
        // is just its two opposite corners.
        const rect = widget.rect as [number, number, number, number];
        const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
        const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
        const x1 = Math.min(ax, bx);
        const x2 = Math.max(ax, bx);
        const y1 = Math.min(ay, by);
        const y2 = Math.max(ay, by);
        widgets.push({
          name: widget.fieldName,
          kind: widgetKind(widget.fieldType),
          page: number,
          x: Math.min(x1, x2) / viewport.width,
          y: Math.min(y1, y2) / viewport.height,
          w: Math.abs(x2 - x1) / viewport.width,
          h: Math.abs(y2 - y1) / viewport.height,
          value: widgetValue(widget.fieldValue, widget.fieldType),
        });
      }
      page.cleanup();
    } catch {
      // A page that cannot be read leaves its widgets unknown, which the card will say. It is not
      // a reason to refuse a document that can still be rendered and signed.
      continue;
    }
  }

  return { pages, widgets, hasForm: widgets.length > 0, isXfa: false };
}

function widgetKind(fieldType: string | undefined): PdfWidget["kind"] {
  switch (fieldType) {
    case "Btn":
      return "checkbox";
    case "Sig":
      return "signature";
    default:
      return "text";
  }
}

function widgetValue(fieldValue: unknown, fieldType: string | undefined): string | undefined {
  if (fieldType === "Btn") return fieldValue ? "ticked" : undefined;
  if (typeof fieldValue === "string" && fieldValue.trim() !== "") return fieldValue;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Draw one page onto a canvas.
 *
 * The backing store is multiplied by the device pixel ratio so a page is not blurry on a screen
 * that has more pixels than CSS says it does, while the element's own size stays where the layout
 * put it.
 */
export async function renderPage(
  document: LoadedPdf,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): Promise<void> {
  const page = await document.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });
  const scale = cssWidth / unscaled.width;
  const ratio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * ratio });

  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  canvas.style.width = "100%";
  canvas.style.height = "auto";

  // A 2D context rather than the element: pdf.js 4 asks for the context it draws into, and 5 and
  // later accept the element instead. The dependency is pinned to the 4.x line on purpose — 5 and
  // 6 call JavaScript builtins newer than the engines this shell embeds (Electron 33, WebKitGTK),
  // and the first thing a 6.x worker does is compute a fingerprint with `Uint8Array.toHex`.
  const context = canvas.getContext("2d");
  if (!context) throw new PdfProblem("This browser would not give up a 2D canvas.", false);
  await page.render({ canvasContext: context, viewport }).promise;
  page.cleanup();
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Write the human's answers into the document and hand the bytes back.
 *
 * Fields are matched to the document's own by name when the name exists, and created where they do
 * not — a document with no form at all is still signable, because the agent said where the
 * signature goes and the canvas draws it there. That is the whole reason `fields` exists rather
 * than relying on AcroForm alone: most PDFs a person is asked to sign are flattened scans with no
 * fields in them whatsoever.
 *
 * `flatten` turns the filled form into page content and removes the interactive fields. It is on by
 * default because a signed document that can still be edited afterwards is not what the human
 * meant to send, and off when the agent wants a form that can still be filled by someone else.
 */
export async function fillPdf(
  bytes: Uint8Array,
  fields: FillFieldInput[],
  options: { flatten: boolean; font?: boolean } = { flatten: true },
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await loadPdfLib();
  let document: PdfLibDocument;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt/i.test(message)) {
      throw new PdfProblem(
        "That document is encrypted, so pdf-lib cannot write into it. Attach the signed copy instead.",
      );
    }
    throw new PdfProblem(`That document could not be loaded for filling: ${message}`);
  }

  const form = document.getForm();
  if (form.hasXFA()) {
    throw new PdfProblem(
      "That document uses XFA forms, which cannot be filled here. Attach the signed copy instead.",
    );
  }

  const pages = document.getPages();
  const font = options.font === false ? undefined : await document.embedFont(StandardFonts.Helvetica);
  const skipped: string[] = [];

  for (const field of fields) {
    const index = Math.min(Math.max(1, field.page), pages.length) - 1;
    const page = pages[index];
    if (!page) continue;

    // Fractions of the page come in from the top-left; PDF points come in from the bottom-left.
    const { width, height } = page.getSize();
    const x = field.x * width;
    const y = height - (field.y + field.h) * height;
    const w = Math.max(6, field.w * width);
    const h = Math.max(6, field.h * height);

    try {
      if (field.kind === "signature") {
        if (!field.signaturePng) continue;
        const image = await document.embedPng(base64ToBytes(field.signaturePng));
        page.drawImage(image, { x, y, width: w, height: h });
        continue;
      }

      if (field.kind === "checkbox") {
        const existing = findField(form, field.id);
        if (existing?.constructor && "check" in (existing as object)) {
          const box = existing as unknown as { check: () => void; uncheck: () => void };
          if (field.checked) box.check();
          else box.uncheck();
          continue;
        }
        const created = form.createCheckBox(field.id);
        created.addToPage(page, { x, y, width: h, height: h });
        if (field.checked) created.check();
        continue;
      }

      const text = field.value ?? "";
      const existing = findField(form, field.id);
      if (existing && "setText" in (existing as object)) {
        const box = existing as unknown as { setText: (value: string) => void; setFontSize?: (size: number) => void };
        box.setText(text);
        box.setFontSize?.(Math.max(8, Math.min(16, h * 0.62)));
        continue;
      }

      if (text.trim() === "") continue;
      const created = form.createTextField(field.id);
      created.addToPage(page, { x, y, width: w, height: h });
      created.setText(text);
      if (font) created.updateAppearances(font);
      created.setFontSize(Math.max(8, Math.min(16, h * 0.62)));
    } catch (error) {
      // One field that will not take a value is worth reporting to the human, not worth throwing
      // away a document they have just spent ten minutes signing.
      skipped.push(field.id);
      void error;
    }
  }

  if (options.flatten) {
    try {
      form.flatten();
    } catch {
      // Some documents have fields pdf-lib will not flatten. Leaving them interactive is a worse
      // result than flattening but a far better one than failing the whole signing.
      form.updateFieldAppearances(font ?? undefined);
    }
  }

  const saved = await document.save({ updateFieldAppearances: !options.flatten });
  if (skipped.length > 0) {
    console.warn(`[auraui] could not write these fields: ${skipped.join(", ")}`);
  }
  return saved;
}

function findField(form: PDFForm, name: string): ReturnType<PDFForm["getFields"]>[number] | undefined {
  try {
    return form.getFields().find((field) => field.getName() === name);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Wiring the two halves together
 * ------------------------------------------------------------------ */

/** The fields a card should actually draw: the agent's, plus the document's own. */
export function planFields(
  declared: SignField[] | undefined,
  widgets: PdfWidget[],
  useAcroForm: boolean,
): SignField[] {
  const planned: SignField[] = [];
  const claimed = new Set<string>();

  for (const field of declared ?? []) {
    planned.push({ ...field, page: field.page ?? 1 });
    claimed.add(field.id);
  }

  if (!useAcroForm) return planned;

  widgets.forEach((widget, index) => {
    const id = widget.name && !claimed.has(widget.name) ? widget.name : `pdf-${index + 1}`;
    if (claimed.has(id)) return;
    claimed.add(id);
    planned.push({
      id,
      kind: widget.kind,
      page: widget.page,
      label: widget.name ?? `Field ${index + 1}`,
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      // A form field the document already fills in is already answered; a blank one is required
      // by the document's own rules, not by ours.
      required: false,
      value: widget.value,
    });
  });

  return planned;
}
