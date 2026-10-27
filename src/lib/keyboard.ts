import { useEffect, useRef } from "react";

/**
 * Number keys, for the people who would rather not reach for the mouse.
 *
 * AuraUI asks one question at a time and most of those questions are answered by a single
 * press, so the cost of finding the pointer is most of the interaction. Every option on a card
 * therefore gets a key of its own, and the key is printed on the option: a shortcut nobody can
 * see is a shortcut nobody uses.
 *
 * Only the kinds that a number can answer are bound. A field to type in, a list to drag into
 * order, a chart to read — those stay pointer-and-keyboard affairs through the controls they
 * already have, because a digit cannot say which way a diff hunk should go any better than the
 * two buttons already on it can.
 */

/** One pressable thing on a card, and the key that presses it. */
export interface OptionKey {
  /** A single character as `KeyboardEvent.key` reports it: `"1"`, `"a"`, `"Escape"`. */
  key: string;
  /** What the press does. */
  run: () => void;
  /**
   * True when the control is finished or read-only.
   *
   * A disabled key is *not* consumed, so a card that is on its way out cannot swallow the
   * keystroke meant for the card arriving behind it.
   */
  disabled?: boolean;
}

/**
 * The keys a list of options gets, in order: `1`-`9`, then `a`, `b`, `c`…
 *
 * Past the ninth option the shortcut stops being a shortcut, so callers that can overflow that
 * simply do not bind the rest: a key that is not on screen is not worth having.
 */
export function optionKeys(count: number): string[] {
  const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  return Array.from({ length: count }, (_, index) =>
    index < digits.length ? digits[index] : (letters[index - digits.length] ?? ""),
  );
}

/** True when the keystroke went to something the human is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Bind this card's options to their keys, for as long as it is mounted.
 *
 * `build` is called on the keystroke rather than at render, which is what lets a caller list
 * its options next to the handlers that use them instead of hoisting every one of them above
 * the first early return. It also means the bindings always see the current render's state,
 * so an option that has just been answered is already disabled by the time it is looked up.
 */
export function useOptionKeys(build: () => readonly OptionKey[]): void {
  const latest = useRef(build);
  latest.current = build;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      // Leave anything the browser, the desktop or an assistive tool owns alone.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // A digit typed into a field is text, not a command. This is the whole reason the canvas
      // can put numbers on its options and still ask a question that needs typing.
      if (isTyping(event.target)) return;
      if (event.key.length !== 1) return;

      const pressed = event.key.toLowerCase();
      const match = latest.current().find((option) => option.key === pressed && !option.disabled);
      if (!match) return;

      event.preventDefault();
      match.run();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
