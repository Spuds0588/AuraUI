/**
 * The five hues a question is allowed to use, one per option.
 *
 * Why this exists: a question with five options used to draw five identical grey chips that
 * only differed by their label, so the eye had to read every one of them to find the one it
 * wanted. Giving each option its own hue makes the row scannable in one pass.
 *
 * The hue is assigned by **position**, not by meaning. Two things follow from that, and both
 * are deliberate:
 *
 *  - Nothing is encoded in the colour. "Green means good" would be a lie the moment an agent
 *    reordered its options, and colour on its own is not readable by everyone anyway. Every
 *    selected chip is also filled, ringed and drawn in a heavier weight, so the state shows
 *    up in three ways that survive a greyscale screenshot.
 *  - Every option in one question gets a *different* hue, because they come from a list and
 *    the index is unique. A hash of the option text would keep a hue stable across a
 *    reorder, but it would also hand two options in the same row the same colour.
 *
 * The class strings are written out in full rather than composed from the tone name. Tailwind
 * scans source text for class names, so `bg-${tone}-400` would produce no CSS at all.
 */

export const TONES = ["sky", "violet", "emerald", "amber", "rose"] as const;

export type Tone = (typeof TONES)[number];

export interface ToneClasses {
  /** Solid accent bar down the left edge of a chip. */
  bar: string;
  /** Icon or arrow tint that matches the bar. */
  glyph: string;
  /** Unselected: neutral fill, the hue only on the edge. */
  off: string;
  /** Selected: the chip's own hue on the fill, the ring and the label. */
  on: string;
  /** The label text once the chip is on. */
  labelOn: string;
}

export const TONE_CLASSES: Record<Tone, ToneClasses> = {
  sky: {
    bar: "bg-sky-400/80",
    glyph: "text-sky-300",
    off: "border-sky-400/45 hover:bg-sky-400/10",
    on: "border-sky-400/80 bg-sky-400/15 ring-sky-400/50",
    labelOn: "text-sky-100",
  },
  violet: {
    bar: "bg-violet-400/80",
    glyph: "text-violet-300",
    off: "border-violet-400/45 hover:bg-violet-400/10",
    on: "border-violet-400/80 bg-violet-400/15 ring-violet-400/50",
    labelOn: "text-violet-100",
  },
  emerald: {
    bar: "bg-emerald-400/80",
    glyph: "text-emerald-300",
    off: "border-emerald-400/45 hover:bg-emerald-400/10",
    on: "border-emerald-400/80 bg-emerald-400/15 ring-emerald-400/50",
    labelOn: "text-emerald-100",
  },
  amber: {
    bar: "bg-amber-400/80",
    glyph: "text-amber-300",
    off: "border-amber-400/45 hover:bg-amber-400/10",
    on: "border-amber-400/80 bg-amber-400/15 ring-amber-400/50",
    labelOn: "text-amber-100",
  },
  rose: {
    bar: "bg-rose-400/80",
    glyph: "text-rose-300",
    off: "border-rose-400/45 hover:bg-rose-400/10",
    on: "border-rose-400/80 bg-rose-400/15 ring-rose-400/50",
    labelOn: "text-rose-100",
  },
};

/** The hue for the option at `index`, wrapping if a question has more options than hues. */
export function toneAt(index: number): Tone {
  const count = TONES.length;
  return TONES[((index % count) + count) % count];
}

export function toneClassesAt(index: number): ToneClasses {
  return TONE_CLASSES[toneAt(index)];
}
