import { cn } from "@/lib/utils";
import { toneClassesAt } from "./tones";

/**
 * A choice rendered as buttons.
 *
 * AuraUI asks questions in the middle of someone else's work, so every control has to be
 * hittable without aiming: a real button target, not a 16px box with a 4px dot in it, and
 * no dropdown that hides the options until it is opened. The whole option list is on screen,
 * so the human can read the choices and answer in one motion.
 *
 * Used for single choices (`choice` fields) and multiple ones (`multi` fields). Both draw
 * the same control, because the only difference between them is whether picking an option
 * clears the others, and the caller owns that.
 *
 * A `multi` deliberately has no tick box. Drawing one would put a checkbox back on screen
 * with a button's hit area, and the button's own pressed state already says which options
 * are on: more of them light up as the human picks, and the wording above the group is what
 * tells them several are allowed.
 *
 * Each chip carries its own hue down the left edge, so a list of five options is scannable
 * before it is read. The hue is positional and carries no meaning — see `./tones`.
 */

export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
}

export interface ChoiceButtonsProps {
  options: ChoiceOption[];
  /**
   * The options currently on. One entry for a single choice, any number for a multi.
   *
   * Deliberately the only place that difference lives: this control draws the options and
   * reports presses, and the caller decides whether a press turns the others off. Keeping
   * that out of here is why a `multi` needs no special appearance.
   */
  value: string[];
  onToggle: (value: string) => void;
  disabled?: boolean;
  /** Names the group for assistive tech. Defaults to the option list being unlabelled. */
  ariaLabel?: string;
  className?: string;
}

export default function ChoiceButtons({
  options,
  value,
  onToggle,
  disabled = false,
  ariaLabel,
  className,
}: ChoiceButtonsProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("flex flex-wrap gap-2.5", className)}
    >
      {options.map((option, index) => {
        const on = value.includes(option.value);
        const tone = toneClassesAt(index);
        return (
          <button
            key={option.value}
            type="button"
            // `aria-pressed` is what makes a button read as a selection without pretending
            // to be a checkbox: the state is on the button, and the label stays the label.
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onToggle(option.value)}
            className={cn(
              "relative flex min-h-11 items-center overflow-hidden rounded-lg border border-l-4 pl-4 pr-4 py-2.5 text-left text-xs transition-colors",
              "disabled:pointer-events-none disabled:opacity-50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              on
                ? cn("ring-1", tone.on)
                : cn("bg-background/60 text-foreground/80 hover:text-foreground", tone.off),
            )}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className={cn("leading-snug", on ? cn("font-semibold", tone.labelOn) : "font-medium")}>
                {option.label}
              </span>
              {option.description ? (
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
