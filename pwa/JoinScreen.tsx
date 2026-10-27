import { useEffect, useState } from "react";
import { Share, Smartphone } from "lucide-react";
import { Button } from "@/components/ui";
import { pairingFromUrl, type PairingFailure } from "@/lib/pairing";
import { isInstalled, pushAvailability } from "./push";

/**
 * What a phone shows before it has been paired.
 *
 * There is exactly one thing to do here — scan the QR code on the desktop — so it is the only
 * thing on screen. Two details are worth the space they take, though, because both are
 * genuinely surprising and both are things the human has to do *now* rather than later:
 *
 *   - On iOS, a web app has no push notifications at all until it is added to the Home Screen.
 *     Not "fewer notifications": none. Saying so after they have walked away from the laptop
 *     means saying it too late, so it is said before the scan.
 *   - The scan has to be done with the camera rather than a QR reader app, because the payload
 *     is in the URL's fragment and a reader app that re-writes the URL can drop it.
 *
 * The paste box is not padding either: it is how this screen gets tested without a phone in
 * hand, and how somebody whose camera will not cooperate still gets in.
 */
export default function JoinScreen({
  problem,
  notice,
}: {
  problem?: { reason: PairingFailure; detail: string };
  notice?: string;
}) {
  const [pasted, setPasted] = useState("");
  const [pasteProblem, setPasteProblem] = useState<string | undefined>();
  const [installed, setInstalled] = useState(() => isInstalled());

  useEffect(() => {
    // `display-mode` changes on the very install that matters, so this is re-read rather than
    // assumed once at launch.
    const media = window.matchMedia("(display-mode: standalone)");
    const update = () => setInstalled(isInstalled());
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const availability = pushAvailability();
  const needsInstall = availability === "install-first" && !installed;

  const join = () => {
    const target = pasted.trim();
    const result = pairingFromUrl(target);
    if (!result.ok) {
      setPasteProblem(result.detail);
      return;
    }
    if (!target.includes("#")) {
      setPasteProblem("Paste the whole link, including the part after the #.");
      return;
    }
    // A full navigation rather than a state change: the join is read once, at startup, and a
    // second path that also decodes a payload is a second path that drifts. `replace` so the
    // link does not sit in the back stack behind the paired app.
    window.location.replace(target);
  };

  return (
    <div className="flex min-h-dvh flex-col justify-center gap-6 bg-background px-6 py-10">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold text-foreground">Pair this phone</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Open AuraUI on your desktop and it will show a QR code. Scan it with the camera. The
          code carries everything this phone needs, so there is nothing to type and no account
          to make.
        </p>
      </div>

      {problem ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200">
          {problem.detail}
        </p>
      ) : null}

      {notice ? (
        <p className="rounded-lg border border-border bg-card px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {needsInstall ? (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Smartphone aria-hidden="true" className="size-4 text-accent" />
            Add it to your Home Screen first
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            On iPhone and iPad, a web app can only be woken by a notification after it has been
            added to the Home Screen. In a Safari tab there is no notification permission to
            grant at all, so the agent would have no way to reach you.
          </p>
          <ol className="mt-3 space-y-1 text-xs leading-relaxed text-muted-foreground">
            <li className="flex items-center gap-2">
              <Share aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
              Tap Share in Safari's toolbar
            </li>
            <li>Choose “Add to Home Screen”</li>
            <li>Open AuraUI from the icon, then pair there</li>
          </ol>
        </section>
      ) : null}

      <section className="space-y-3">
        <label className="block text-xs font-medium text-muted-foreground" htmlFor="pairing-link">
          Or paste the pairing link
        </label>
        <textarea
          id="pairing-link"
          value={pasted}
          onChange={(event) => {
            setPasted(event.target.value);
            setPasteProblem(undefined);
          }}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder="https://…/#join=…"
          className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50"
        />
        {pasteProblem ? (
          <p className="text-xs leading-relaxed text-amber-200">{pasteProblem}</p>
        ) : null}
        <Button variant="primary" className="w-full" onClick={join} disabled={pasted.trim() === ""}>
          Pair with this link
        </Button>
      </section>

      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        AuraUI is served as a static page and holds no account on a server. The pairing link is
        the only credential, it is stored on this device, and the desktop can revoke it at any
        time by asking for a new one.
      </p>
    </div>
  );
}
