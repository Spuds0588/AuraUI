import { cn } from "@/lib/utils";

/**
 * The key that presses the thing next to it.
 *
 * Printed rather than advertised elsewhere, because the alternative is a card that responds to
 * keys the human has no way of guessing. It is small, monospaced and muted so it reads as a
 * footnote to the option rather than as part of its label.
 *
 * Hidden from assistive tech on purpose: someone driving the canvas with a screen reader is
 * already navigating by keyboard, and "1" in the middle of an option's name is noise.
 */
export default function KeyHint({ keys, className }: { keys?: string; className?: string }) {
  if (!keys) return null;
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "inline-flex size-5 shrink-0 select-none items-center justify-center rounded border border-border/70 bg-secondary/50 font-mono text-[10px] leading-none text-muted-foreground",
        className,
      )}
    >
      {keys}
    </kbd>
  );
}
