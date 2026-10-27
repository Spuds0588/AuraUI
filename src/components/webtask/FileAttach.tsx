import { useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui";
import type { ReturnedFile } from "@/lib/protocol";

/**
 * How large a file the human may hand back.
 *
 * The bridge refuses a frame over 16 MiB and base64 inflates by a third, so a document that goes
 * back inside an answer has to start well under half of that. The same number is on the Rust side
 * for documents the agent sends, and for the same reason: past this, bytes are the wrong vehicle
 * and a link is the right one.
 */
export const ATTACH_BYTES_LIMIT = 8 * 1024 * 1024;

/**
 * Read a file the human attached, as the answer's shape.
 *
 * `data` is base64 without the `data:` prefix, because it travels inside the same JSON text frame
 * as everything else — the `AudioClip` rule. The size check happens before the read rather than
 * after, so a 2 GB video someone dropped by accident never becomes a string in memory.
 */
export function readReturnedFile(file: File, limit: number = ATTACH_BYTES_LIMIT): Promise<ReturnedFile> {
  return new Promise((resolve, reject) => {
    if (file.size > limit) {
      reject(
        new Error(
          `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB and the cap is ${Math.round(
            limit / (1024 * 1024),
          )} MB. Send the agent the name of the file, or a link to where it lives, instead of the bytes.`,
        ),
      );
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error(`could not read ${file.name}`));
        return;
      }
      resolve({
        mime: file.type || "application/octet-stream",
        filename: file.name,
        size: file.size,
        data: result.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Attach a file, and take it back off again.
 *
 * This is how a signature comes back from a provider link. DocuSign and its kin hand the human a
 * finished PDF through a download, not through an API this canvas has any business calling, so the
 * honest mechanism is the one people already use: the human saves it and points at it. The control
 * says which file it took, because an answer that carries the wrong PDF is worse than no answer.
 */
export default function FileAttach({
  file,
  onFile,
  label = "Attach the signed copy",
  accept = "application/pdf,image/*",
  disabled = false,
  error,
}: {
  file: ReturnedFile | undefined;
  onFile: (file: ReturnedFile | undefined) => void;
  label?: string;
  accept?: string;
  disabled?: boolean;
  error?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = (chosen: File | undefined) => {
    if (!chosen) return;
    setProblem(null);
    void readReturnedFile(chosen)
      .then(onFile)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          pick(event.target.files?.[0]);
          // Cleared so choosing the same file twice in a row still fires a change event.
          if (input.current) input.current.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={file ? "outline" : "primary"}
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          <Paperclip aria-hidden="true" className="size-3.5" />
          {file ? "Replace the attached file" : label}
        </Button>
        {file ? (
          <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <span className="truncate font-mono text-foreground/90">{file.filename}</span>
            <span className="shrink-0">{(file.size / 1024).toFixed(0)} KB</span>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Take the attached file off"
              title="Remove"
              disabled={disabled}
              onClick={() => onFile(undefined)}
            >
              <X aria-hidden="true" className="size-3" />
            </Button>
          </span>
        ) : null}
      </div>
      {problem ?? error ? (
        <p role="alert" className="text-[11px] leading-relaxed text-destructive">
          {problem ?? error}
        </p>
      ) : null}
    </div>
  );
}
