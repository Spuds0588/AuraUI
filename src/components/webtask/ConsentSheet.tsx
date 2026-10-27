import { KeyRound, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui";
import type { WebSession } from "@/lib/protocol";
import { describeSession } from "@/lib/webview";

/**
 * The gate in front of every session handover.
 *
 * This is the one control in the whole canvas that stands between an agent's request and
 * somebody's live login, so it says exactly what is being handed over and nothing else: the
 * sites by name, how many cookies and stored values travel, and the consequence. What it never
 * shows is a value — not a cookie, not a token — because the sheet is read by a person, it sits in
 * a card that gets screenshotted, and a secret on screen is a secret in a bug report.
 *
 * There is no checkbox for "remember this site", because AuraUI has no checkboxes: the choice is
 * made by pressing one of three buttons, and the third one is the one that remembers.
 */
export default function ConsentSheet({
  session,
  subject,
  onAllow,
  onAllowAndRemember,
  onDecline,
}: {
  session: WebSession;
  /** What is about to be opened, so the sentence is about a real thing. */
  subject: string;
  onAllow: () => void;
  onAllowAndRemember: () => void;
  onDecline: () => void;
}) {
  const { origins, cookies, storage } = describeSession(session);
  const label = session.label?.trim();

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
      <div className="flex items-start gap-3">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-400" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-sm font-semibold text-foreground">
            {label ? `Hand over ${label}?` : "Hand over the session?"}
          </p>
          <p className="text-xs leading-relaxed text-foreground/90">
            The agent has a session open and wants to pass it to {subject}, so you carry on where it
            stopped instead of signing in again.
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-1">
        {origins.map((origin) => (
          <li key={origin} className="flex items-center gap-2 text-[11px]">
            <KeyRound aria-hidden="true" className="size-3 shrink-0 text-amber-300/80" />
            <span className="truncate font-mono text-foreground/90">{origin}</span>
          </li>
        ))}
      </ul>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {cookies > 0
          ? `${cookies} cookie${cookies === 1 ? "" : "s"}`
          : "No cookies"}
        {storage > 0
          ? ` and ${storage} saved value${storage === 1 ? "" : "s"}`
          : " and no saved values"}{" "}
        travel with it. Their contents are never shown, here or anywhere else. Anywhere this page is
        signed in, it can act as you — so only hand it over for sites you recognise.
      </p>

      {session.note ? (
        <p className="text-[11px] italic leading-relaxed text-muted-foreground">{session.note}</p>
      ) : null}

      <div className="flex flex-wrap gap-2.5 pt-0.5">
        <Button size="sm" variant="primary" onClick={onAllow}>
          Hand it over
        </Button>
        <Button size="sm" variant="outline" onClick={onDecline}>
          Open without it
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onAllowAndRemember}
          title="Hand it over now, and stop asking about these sites"
        >
          Always allow these sites
        </Button>
      </div>
    </div>
  );
}
