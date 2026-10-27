import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileSignature, PenLine, Send, X } from "lucide-react";
import { Button, Input } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { ReturnedFile, ESignProps, SignField, Signer } from "@/lib/protocol";
import {
  bytesToBase64,
  fetchPdfBytes,
  fillPdf,
  openPdf,
  planFields,
  readOutline,
  type FillFieldInput,
  type PdfOutline,
} from "@/lib/pdf";
import {
  closeWebTask,
  measureSlot,
  openInBrowser,
  openWebTask,
  sessionOrigins,
  subscribeWebTaskStatus,
  trustOrigin,
  trustedOrigins,
  useWebHost,
  useWebTaskSlot,
  webTaskAction,
  type WebTaskStatus,
  type WebTaskView,
} from "@/lib/webview";
import ConsentSheet from "@/components/webtask/ConsentSheet";
import FileAttach from "@/components/webtask/FileAttach";
import PdfDocument from "@/components/webtask/PdfDocument";
import SessionToolbar from "@/components/webtask/SessionToolbar";
import type { SignatureValue } from "@/components/webtask/SignaturePad";

/** The most a returned document may weigh, matching the bridge's half of the frame budget. */
const DOCUMENT_BYTES_LIMIT = 8 * 1024 * 1024;

const SLOT_HEIGHT = 440;

type LoadedPdf = Awaited<ReturnType<typeof openPdf>>;

/**
 * "Sign this."
 *
 * Two shapes, because there are two real situations and pretending they are one makes both worse.
 *
 * **A signing link.** A page at DocuSign or its kin. The human signs there, in the provider's own
 * flow, and what comes back is a confirmation, who signed, and whatever copy they attach. No API
 * keys, no vendor integration: the card is a browser with a "done" button and a place to put the
 * file, which is what a provider link actually needs.
 *
 * **A document.** The PDF itself. Here the canvas can do better than a link, so it does: it renders
 * the pages, puts a box exactly where each field goes, takes a drawn or typed signature, fills the
 * document with pdf-lib and hands the signed bytes back. No round trip, no upload, no account.
 *
 * What it will not pretend: a drawn signature is a picture of a signature, not a cryptographic
 * one. This fills documents; it does not notarise them. Encrypted and XFA documents cannot be
 * written by pdf-lib at all, and both are said out loud with the attach-a-copy path offered instead.
 */
export default function ESign({ taskId, props, respond, resolved }: TaskComponentProps<ESignProps>) {
  const host = useWebHost();
  const providerUrl = typeof props?.url === "string" && props.url ? props.url : undefined;
  const document = props?.document;
  const src = document?.src;
  const useAcroForm = props?.useAcroForm !== false;
  const flatten = props?.flatten !== false;
  const offerAttach = props?.returnSignedCopy !== false;

  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [outline, setOutline] = useState<PdfOutline | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [values, setValues] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [signatures, setSignatures] = useState<Record<string, SignatureValue>>({});
  const [typedName, setTypedName] = useState(() => props?.signer?.name ?? "");
  const [signerEmail, setSignerEmail] = useState(() => props?.signer?.email ?? "");
  const [attached, setAttached] = useState<ReturnedFile | undefined>();

  const [view, setView] = useState<WebTaskView | null>(null);
  const [status, setStatus] = useState<WebTaskStatus | undefined>();
  const [consent, setConsent] = useState(false);
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const slot = useRef<HTMLDivElement>(null);
  const openedHere = useRef(false);
  const locked = resolved || sent;

  /* ---- the document -------------------------------------------------- */

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    let opened: LoadedPdf | null = null;

    void (async () => {
      try {
        const fetched = await fetchPdfBytes(src);
        const documentProxy = await openPdf(fetched);
        opened = documentProxy;
        const read = await readOutline(documentProxy);
        if (cancelled) return;
        setBytes(fetched);
        setPdf(documentProxy);
        setOutline(read);
        setLoadError(null);
      } catch (problem) {
        if (cancelled) return;
        setLoadError(problem instanceof Error ? problem.message : String(problem));
      }
    })();

    return () => {
      cancelled = true;
      // Hand the document's cached pages back, or a run of signature cards holds one document's
      // worth of rendered pages per card. The worker itself is shared and reused by pdf.js.
      if (opened) void opened.cleanup().catch(() => undefined);
    };
  }, [src]);

  const fields = useMemo<SignField[]>(
    () => (outline ? planFields(props?.fields, outline.widgets, useAcroForm) : (props?.fields ?? [])),
    [outline, props?.fields, useAcroForm],
  );

  // Values a document already carries are worth showing: a half-filled form that arrives with the
  // name on it is a form the human only has to sign.
  useEffect(() => {
    if (fields.length === 0) return;
    setValues((current) => {
      const next = { ...current };
      for (const field of fields) {
        if (next[field.id] === undefined && field.value) next[field.id] = field.value;
      }
      return next;
    });
  }, [fields]);

  const filledCount = fields.filter((field) => {
    if (field.kind === "signature") return Boolean(signatures[field.id]);
    if (field.kind === "checkbox") return Boolean(checked[field.id]);
    return ((values[field.id] ?? field.value ?? "") as string).trim() !== "";
  }).length;
  const missingRequired = fields.filter((field) => {
    if (!field.required) return false;
    if (field.kind === "signature") return !signatures[field.id];
    if (field.kind === "checkbox") return !checked[field.id];
    return ((values[field.id] ?? field.value ?? "") as string).trim() === "";
  });

  /* ---- the shell's view of this card (provider links) ----------------- */

  useWebTaskSlot(slot, taskId, host === "embedded" && view !== null);

  useEffect(() => subscribeWebTaskStatus((next) => {
    if (next.taskId !== taskId) return;
    setStatus((current) => ({ ...current, ...next }));
  }), [taskId]);

  useEffect(
    () => () => {
      if (openedHere.current) void closeWebTask(taskId, false);
    },
    [taskId],
  );

  const silent = useRef(false);
  silent.current = locked;

  const emitProgress = useCallback(() => {
    // A progress frame after the answer is a frame the bridge has already closed the task for.
    if (fields.length === 0 || silent.current) return;
    respond("change", {
      name: "esign-fields",
      value: filledCount,
      filled: filledCount,
      totalFields: fields.length,
    });
  }, [fields.length, filledCount, respond]);

  useEffect(() => {
    emitProgress();
  }, [emitProgress]);

  const openProvider = useCallback(
    async (withSession: boolean) => {
      if (!providerUrl) return;
      setError(null);
      try {
        const opened = await openWebTask({
          taskId,
          url: providerUrl,
          session: withSession ? props?.session : undefined,
          rect: slot.current ? measureSlot(slot.current) : undefined,
        });
        openedHere.current = true;
        setView(opened);
        setStatus({ taskId, url: providerUrl, title: "", loading: true });
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
      }
    },
    [props?.session, providerUrl, taskId],
  );

  const startProvider = () => {
    if (locked) return;
    if (host !== "embedded") {
      openInBrowser(providerUrl ?? "");
      return;
    }
    const origins = sessionOrigins(props?.session);
    const trusted = trustedOrigins();
    if (props?.session && !consented && origins.length > 0 && !origins.every((o) => trusted.includes(o))) {
      setConsent(true);
      return;
    }
    void openProvider(Boolean(props?.session));
  };

  /* ---- answering ------------------------------------------------------ */

  const signer = (): Signer => ({
    name: typedName.trim() || undefined,
    email: signerEmail.trim() || undefined,
    signedAt: new Date().toISOString(),
  });

  const submitProvider = () => {
    if (locked) return;
    setSent(true);
    respond("submit", {
      component: "ESign",
      completed: true,
      source: attached ? "attached" : "provider",
      document: attached,
      signer: signer(),
      note: undefined,
    });
    if (openedHere.current) void closeWebTask(taskId, false);
  };

  const submitDocument = async () => {
    if (locked || busy) return;
    setError(null);

    // An attached copy wins over anything this card could build: the human has the document that
    // a provider produced, and that one is the real one.
    if (attached) {
      setSent(true);
      respond("submit", {
        component: "ESign",
        completed: true,
        source: "attached",
        document: attached,
        signer: signer(),
        fields: textValues(values),
      });
      return;
    }

    if (!bytes) {
      setSent(true);
      respond("submit", {
        component: "ESign",
        completed: true,
        source: "provider",
        signer: signer(),
        fields: textValues(values),
      });
      return;
    }

    setBusy(true);
    try {
      const inputs: FillFieldInput[] = fields.map((field) => ({
        id: field.id,
        kind: field.kind,
        page: field.page ?? 1,
        x: field.x,
        y: field.y,
        w: field.w,
        h: field.h,
        value: values[field.id] ?? field.value,
        checked: checked[field.id],
        signaturePng: signatures[field.id]?.png,
      }));
      const filled = await fillPdf(bytes, inputs, { flatten });
      if (filled.length > DOCUMENT_BYTES_LIMIT) {
        throw new Error(
          `The filled document is ${(filled.length / (1024 * 1024)).toFixed(1)} MB and the cap is ${
            DOCUMENT_BYTES_LIMIT / (1024 * 1024)
          } MB. Attach a link to it instead of the bytes.`,
        );
      }
      setSent(true);
      respond("submit", {
        component: "ESign",
        completed: true,
        source: "filled",
        document: {
          mime: "application/pdf",
          filename: document?.filename ?? "signed.pdf",
          size: filled.length,
          data: bytesToBase64(filled),
        },
        signer: signer(),
        fields: {
          ...textValues(values),
          ...Object.fromEntries(
            Object.entries(signatures).map(([id, value]) => [
              id,
              value.typed ? `typed signature (${typedName})` : "drawn signature",
            ]),
          ),
        },
      });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  if (!providerUrl && !document) {
    return (
      <p className="text-xs text-muted-foreground">
        This signature request arrived with neither a link nor a document to sign, so there is
        nothing to open. The agent needs to send `url` or `document`.
      </p>
    );
  }

  const title = props?.title ?? (providerUrl ? "A document to sign" : "Sign the document");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <FileSignature aria-hidden="true" className="size-4 text-primary" />
          {title}
        </span>
        {document?.filename ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {document.filename}
          </span>
        ) : null}
      </div>

      {props?.intro ? (
        <p className="text-xs leading-relaxed text-foreground/85">{props.intro}</p>
      ) : null}

      {/* A signing link, in the embedded browser. */}
      {providerUrl ? (
        <div className="flex flex-col gap-2">
          {view ? (
            <SessionToolbar
              view={view}
              status={status}
              onAction={(action) => void webTaskAction(taskId, action).catch(() => undefined)}
              onExternal={() => openInBrowser(status?.url || view.url)}
              onClose={() => {
                void closeWebTask(taskId, false);
                openedHere.current = false;
                setView(null);
              }}
            />
          ) : null}
          <div
            ref={slot}
            style={{ height: view ? SLOT_HEIGHT : undefined }}
            className="overflow-hidden rounded-lg border border-border/60 bg-secondary/20"
          >
            {view ? (
              <p className="p-3 text-[11px] text-muted-foreground/70">
                The signing page is drawn by the shell over this card.
              </p>
            ) : (
              <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
                <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
                  {host === "embedded"
                    ? "The signing page opens here, inside this card, with the agent's session if you approve it. When the provider is done with you, attach the signed copy below or just say you signed it."
                    : "The signing page opens in your own browser, where you are already signed in. When the provider is done with you, attach the signed copy below or just say you signed it."}
                </p>
                <Button size="sm" variant="primary" disabled={locked} onClick={startProvider}>
                  <PenLine aria-hidden="true" className="size-3.5" />
                  {host === "embedded" ? "Open the signing page" : "Open in your browser"}
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {consent && props?.session ? (
        <ConsentSheet
          session={props.session}
          subject="the signing page"
          onAllow={() => {
            setConsented(true);
            setConsent(false);
            void openProvider(true);
          }}
          onAllowAndRemember={() => {
            for (const origin of sessionOrigins(props.session)) trustOrigin(origin);
            setConsented(true);
            setConsent(false);
            void openProvider(true);
          }}
          onDecline={() => {
            setConsent(false);
            void openProvider(false);
          }}
        />
      ) : null}

      {/* A document the canvas can fill. */}
      {document ? (
        loadError ? (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-amber-200">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{loadError}</span>
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The document can still go back to the agent the other way: open it where it lives,
              sign it, and attach the finished file below.
            </p>
          </div>
        ) : pdf ? (
          <PdfDocument
            pdf={pdf}
            fields={fields}
            values={values}
            checked={checked}
            signatures={signatures}
            typedName={typedName}
            onTypedName={setTypedName}
            onValue={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
            onChecked={(id, value) => setChecked((current) => ({ ...current, [id]: value }))}
            onSignature={(id, value) =>
              setSignatures((current) => {
                const next = { ...current };
                if (value) next[id] = value;
                else delete next[id];
                return next;
              })
            }
            disabled={locked}
          />
        ) : (
          <p className="text-[11px] text-muted-foreground">Loading the document…</p>
        )
      ) : null}

      {offerAttach ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-input bg-background/50 p-3">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Or hand back a copy
          </span>
          <FileAttach
            file={attached}
            onFile={setAttached}
            label={providerUrl ? "Attach the signed copy" : "Attach a signed copy instead"}
            disabled={locked}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {providerUrl
              ? "Most signing services give you a finished PDF at the end. Save it and attach it here and the agent gets the document, not just your word for it."
              : "If the copy you signed lives somewhere else, or this document could not be filled here, attach it and that is what goes back."}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[160px] flex-1 flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Your name</span>
          <Input
            value={typedName}
            disabled={locked}
            placeholder="Who is signing"
            onChange={(event) => setTypedName(event.target.value)}
            className="h-9"
          />
        </label>
        <label className="flex min-w-[160px] flex-1 flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Email (optional)</span>
          <Input
            value={signerEmail}
            disabled={locked}
            placeholder="you@example.com"
            onChange={(event) => setSignerEmail(event.target.value)}
            className="h-9"
          />
        </label>
      </div>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      {missingRequired.length > 0 && !locked ? (
        <p className="text-[11px] leading-relaxed text-amber-300">
          {missingRequired.length} field{missingRequired.length === 1 ? "" : "s"} still need
          {missingRequired.length === 1 ? "s" : ""} you: {missingRequired.map((f) => f.label ?? f.id).join(", ")}.
        </p>
      ) : null}

      {fields.length > 0 && filledCount === 0 && !attached && !locked ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Nothing filled in yet. Sending now would tell the agent the document is signed with
          nothing on it, so it is worth a second look.
        </p>
      ) : null}

      {!locked ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            size="sm"
            variant="primary"
            disabled={busy || (!providerUrl && missingRequired.length > 0 && !attached)}
            onClick={() => {
              if (providerUrl && !document) submitProvider();
              else void submitDocument();
            }}
          >
            <Send aria-hidden="true" className="size-3.5" />
            {busy ? "Filling the document…" : (props?.submitLabel ?? "Send it back")}
          </Button>
          {providerUrl && document === undefined ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={submitProvider}
              title="Say it is signed without attaching anything"
            >
              I signed it
            </Button>
          ) : null}
          {view ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void closeWebTask(taskId, false);
                openedHere.current = false;
                setView(null);
              }}
            >
              <X aria-hidden="true" className="size-3.5" />
              Close the signing page
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {props?.help ??
          "A signature here is drawn onto the page, not sealed with a certificate. The document never leaves this machine: it is filled in the browser and sent back to the agent as bytes."}
      </p>
    </div>
  );
}

/** Only the text-shaped answers: a signature is described, never echoed. */
function textValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => typeof value === "string" && value.trim() !== ""),
  );
}
