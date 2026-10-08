import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { DiffHunk, DiffLine, DiffReviewProps } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/**
 * "Accept this part of my change, or not."
 *
 * The agent splits its own diff into hunks and marks each line, exactly as it brings its own
 * numbers to a chart. The canvas never computes a diff — it renders what it was handed — so
 * nothing here can disagree with the change the agent is actually holding.
 *
 * Each hunk is decided by pressing one of two buttons, never a checkbox: the same rule as
 * every other question in AuraUI. The decision is written on the button itself, so the state
 * of the review is legible as a column of words rather than a column of tick boxes.
 *
 * The review sends itself. Accept and Reject *are* the answer, so the press that decides the
 * last open hunk submits the review, and a card carrying a single hunk — the usual case — is
 * one press end to end. Asking for one more press to confirm a decision the human just made
 * would make a one-click answer into two, which is the thing this canvas exists to avoid.
 *
 * Colour is doing real work on the lines themselves (green added, red removed), which is the
 * one place in this canvas where a hue carries meaning. It is never the only carrier: every
 * line also opens with `+`, `−` or a space, and every one of those is spelled out for a
 * screen reader.
 */

type Decision = "accept" | "reject";

const LINE_CLASS: Record<DiffLine["kind"], string> = {
  context: "text-muted-foreground",
  add: "bg-emerald-500/10 text-emerald-200",
  del: "bg-rose-500/10 text-rose-200",
};

const LINE_MARK: Record<DiffLine["kind"], string> = {
  context: " ",
  add: "+",
  del: "−",
};

const LINE_WORD: Record<DiffLine["kind"], string> = {
  context: "unchanged line",
  add: "added line",
  del: "removed line",
};

/**
 * Drop a leading `+`/`-` that the agent already put on the line.
 *
 * Agents copy lines straight out of a diff, so the sign is usually in the text as well as in
 * the `kind`. Drawing our own mark on top of it produced `− −  const next = …`, which reads
 * like a typo. The canvas owns the mark, so it removes the duplicate instead of asking every
 * agent author to strip one. Only the first character is touched, so indentation survives.
 */
function withoutLeader(kind: DiffLine["kind"], text: string): string {
  if (kind === "context") return text;
  const first = text[0];
  return first === "+" || first === "-" || first === "−" ? text.slice(1) : text;
}

export default function DiffReview({
  props,
  respond,
  resolved,
}: TaskComponentProps<DiffReviewProps>) {
  const hunks = useMemo<DiffHunk[]>(
    () => (Array.isArray(props?.hunks) ? props.hunks : []),
    [props],
  );

  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [sent, setSent] = useState<Record<string, Decision> | null>(null);
  const locked = resolved || sent !== null;

  if (hunks.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This review arrived with no hunks, so there is nothing to accept or reject.
      </p>
    );
  }

  const send = (final: Record<string, Decision>) => {
    const accepted = hunks.filter((h) => final[h.id] === "accept").map((h) => h.id);
    const rejected = hunks.filter((h) => final[h.id] === "reject").map((h) => h.id);
    setSent(final);
    respond("submit", {
      component: "DiffReview",
      decisions: final,
      accepted,
      rejected,
    });
  };

  const decide = (id: string, choice: Decision) => {
    if (locked) return;
    const next = { ...decisions, [id]: choice };
    setDecisions(next);

    // The deciding press is the answer. Once every hunk has one, the review is finished and
    // sends itself — no `change` first, because there is no longer a moment where the human
    // is still making up their mind about it.
    if (hunks.every((hunk) => next[hunk.id] !== undefined)) {
      send(next);
      return;
    }

    // Still hunks to go: a non-terminal signal, so an agent can watch the review fill up
    // rather than only seeing the finished verdict. `name` is the hunk id, which is what the
    // answer is keyed by.
    respond("change", { name: id, value: choice });
  };

  const undecided = hunks.filter((hunk) => decisions[hunk.id] === undefined);

  return (
    <div className="flex flex-col gap-4">
      {props?.title ? (
        <p className="text-xs font-medium text-foreground/90">{props.title}</p>
      ) : null}

      <ol className="flex flex-col gap-3">
        {hunks.map((hunk) => {
          const decision = decisions[hunk.id];
          const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
          return (
            <li key={hunk.id} className="overflow-hidden rounded-lg border border-border">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-secondary/30 px-4 py-2.5">
                <p className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                  {hunk.header ?? hunk.id}
                </p>
                <div
                  role="group"
                  aria-label={`Decision for ${hunk.header ?? hunk.id}`}
                  className="flex items-center gap-2"
                >
                  <Button
                    size="sm"
                    variant={decision === "accept" ? "primary" : "outline"}
                    aria-pressed={decision === "accept"}
                    onClick={() => decide(hunk.id, "accept")}
                    disabled={locked}
                  >
                    <Check aria-hidden="true" />
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant={decision === "reject" ? "destructive" : "outline"}
                    aria-pressed={decision === "reject"}
                    onClick={() => decide(hunk.id, "reject")}
                    disabled={locked}
                  >
                    <X aria-hidden="true" />
                    Reject
                  </Button>
                </div>
              </div>

              <div className="py-2 font-mono text-[11px] leading-relaxed">
                {lines.map((line, index) => (
                  <div
                    key={index}
                    className={cn("flex gap-2 px-4 py-0.5", LINE_CLASS[line.kind])}
                  >
                    <span aria-hidden="true" className="w-2 shrink-0 select-none opacity-70">
                      {LINE_MARK[line.kind]}
                    </span>
                    <span className="sr-only">{LINE_WORD[line.kind]}: </span>
                    <span className="whitespace-pre">
                      {withoutLeader(line.kind, line.text)}
                    </span>
                  </div>
                ))}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {locked
          ? "Review sent."
          : undecided.length === 0
            ? "Every hunk has a decision."
            : hunks.length === 1
              ? "Accept or reject it. That press sends the review."
              : `${undecided.length} hunk${
                  undecided.length === 1 ? "" : "s"
                } left. The review sends itself as soon as the last one has a decision.`}
      </p>

      {props?.footnote ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{props.footnote}</p>
      ) : null}
    </div>
  );
}
