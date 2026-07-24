import type { Config } from "tailwindcss";

/**
 * Tailwind is wired to the design tokens documented in docs/DESIGN_SYSTEM.md.
 * Do not hardcode hex values in components — extend tokens here instead.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Kid-friendly palette — see docs/DESIGN_SYSTEM.md (§ Color)
        brand: {
          50: "#eef6ff",
          100: "#d9ecff",
          300: "#7cc1ff",
          500: "#2f8bff",
          600: "#1f6fe0",
          700: "#1957b0",
        },
        safe: { 500: "#22c55e", 600: "#16a34a" },
        // warn.50 added for the Idea Queue's soft "line is full" notice
        // (PRD-IDEA-QUEUE-V2) — the amber-50 tint matching 500/600 above.
        warn: { 50: "#fffbeb", 500: "#f59e0b", 600: "#d97706" },
        danger: { 500: "#ef4444", 600: "#dc2626" },
        ink: { 900: "#0f172a", 700: "#334155", 500: "#64748b" },
      },
      borderRadius: {
        kid: "1.25rem",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
