/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      /*
       * Motion for the one card on screen.
       *
       * AuraUI never shows two questions at once, so the interesting moment is the handoff:
       * the answered card slides left and the next slides in from the right (`card-out-left`
       * + `card-in-right`). Only when the queue is empty does a card settle down and away
       * (`card-out-down`) — that is the difference between "next question" and "all done".
       * The first card has nothing to hand off from, so it just rises (`fade-up`).
       *
       * Durations are a deliberate beat longer than a snappy UI would use, so the movement is
       * legible rather than subliminal. App.tsx holds an exiting card for `CARD_MS` to match.
       */
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "card-in-right": {
          from: { opacity: "0", transform: "translateX(32px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "card-out-left": {
          from: { opacity: "1", transform: "translateX(0)" },
          to: { opacity: "0", transform: "translateX(-32px)" },
        },
        "card-out-down": {
          from: { opacity: "1", transform: "translateY(0)" },
          to: { opacity: "0", transform: "translateY(14px)" },
        },
        "pulse-ring": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.32s ease-out",
        "card-in-right": "card-in-right 0.32s ease-out",
        "card-out-left": "card-out-left 0.32s ease-in forwards",
        "card-out-down": "card-out-down 0.32s ease-in forwards",
        "pulse-ring": "pulse-ring 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
