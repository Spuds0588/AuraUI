import { Mic, Square } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/utils";

/**
 * Speak instead of typing.
 *
 * AuraUI only asks a human to type when the answer is genuinely words, and typing a paragraph
 * in the middle of someone else's work is the slowest thing this canvas asks for. So a field
 * that wants an explanation also offers a way to just say it.
 *
 * The button states the truth about itself. While the microphone is open it is filled, pulses
 * and says "Listening", because a live microphone that looks like an idle one is the kind of
 * thing people discover by accident. When it is off it reads as the offer it is.
 *
 * It is a button and not an icon-only affordance: the label is on screen, so nothing here has
 * to be guessed from a glyph, and the press target is the size of the words next to it.
 */
export interface MicButtonProps {
  /** The microphone is live: this press ends the take rather than starting one. */
  listening: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** What to call the action when idle. The listening label is always "Listening". */
  label?: string;
  className?: string;
}

export default function MicButton({
  listening,
  onClick,
  disabled = false,
  label = "Speak",
  className,
}: MicButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant={listening ? "primary" : "outline"}
      onClick={onClick}
      disabled={disabled}
      // A toggle, so it reports its own state rather than pretending to be a command whose
      // meaning changes. The visible word changes with it, so nothing rides on the icon.
      aria-pressed={listening}
      aria-label={listening ? "Stop listening" : label}
      className={cn("gap-1.5", className)}
    >
      {listening ? (
        <>
          <span aria-hidden="true" className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-pulse-ring rounded-full bg-primary-foreground/70" />
            <span className="relative inline-flex size-2 rounded-full bg-primary-foreground" />
          </span>
          Listening
          <Square aria-hidden="true" className="size-3" />
        </>
      ) : (
        <>
          <Mic aria-hidden="true" />
          {label}
        </>
      )}
    </Button>
  );
}
