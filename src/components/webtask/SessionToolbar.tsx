import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Lock,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui";
import { hostOf, type WebTaskStatus, type WebTaskView } from "@/lib/webview";

/**
 * The browser chrome an embedded view does not have.
 *
 * A native child webview is a page with no address bar, no back button and no way to say where you
 * are — which is fine while everything is going well and useless the moment it is not. So the card
 * draws the four things a human actually needs, in the place they would look for them: back,
 * forward, reload, and the address.
 *
 * The address is drawn in *our* pixels rather than the page's, which is the whole point of it. An
 * embedded page can draw anything it likes over its own chrome; it cannot touch this strip, so the
 * origin shown here is the one thing on screen a page cannot lie about.
 */
export default function SessionToolbar({
  view,
  status,
  onAction,
  onExternal,
  onClose,
}: {
  view: WebTaskView;
  status: WebTaskStatus | undefined;
  onAction: (action: "back" | "forward" | "reload") => void;
  onExternal: () => void;
  onClose: () => void;
}) {
  const url = status?.url || view.url;
  const host = hostOf(url);
  const https = url.startsWith("https://");
  const title = status?.title?.trim();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Back"
          title="Back"
          onClick={() => onAction("back")}
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Forward"
          title="Forward"
          onClick={() => onAction("forward")}
        >
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Reload"
          title="Reload"
          onClick={() => onAction("reload")}
        >
          <RotateCw aria-hidden="true" className="size-3.5" />
        </Button>

        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2.5 py-1">
          {https ? (
            <Lock aria-hidden="true" className="size-3 shrink-0 text-emerald-400/80" />
          ) : (
            <TriangleAlert aria-hidden="true" className="size-3 shrink-0 text-amber-400/80" />
          )}
          <span className="truncate font-mono text-[11px] text-foreground/90">{host}</span>
          {title ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground/50">
                ·
              </span>
              <span className="truncate text-[11px] text-muted-foreground">{title}</span>
            </>
          ) : null}
          {status?.loading ? (
            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
              loading
            </span>
          ) : null}
        </div>

        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Open this page in your own browser"
          title="Open in your browser"
          onClick={onExternal}
        >
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Close the embedded browser"
          title="Close the embedded browser"
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-3.5" />
        </Button>
      </div>

      {status?.blocked ? (
        <p role="status" className="flex items-start gap-2 text-[11px] leading-relaxed text-amber-300">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Stopped a navigation: {status.blocked}. A delegated page may only travel over https
            (or a loopback address), so this one was not followed.
          </span>
        </p>
      ) : null}
    </div>
  );
}
