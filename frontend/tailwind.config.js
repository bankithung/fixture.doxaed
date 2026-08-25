/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          hover: "hsl(var(--primary-hover))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
          muted: "hsl(var(--destructive-muted))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
          muted: "hsl(var(--success-muted))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
          muted: "hsl(var(--warning-muted))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
          muted: "hsl(var(--info-muted))",
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
        // Medal placings (see index.css --medal-*). Gold/silver/bronze are
        // culturally fixed, so they are their own status trio rather than a
        // reuse of warning/muted — and every chip that wears one also carries
        // its place number, so identity is never colour alone.
        medal: {
          1: "hsl(var(--medal-1))",
          2: "hsl(var(--medal-2))",
          3: "hsl(var(--medal-3))",
          "1-muted": "hsl(var(--medal-1-muted))",
          "2-muted": "hsl(var(--medal-2-muted))",
          "3-muted": "hsl(var(--medal-3-muted))",
        },
        // Dashboard chart series (see index.css --chart-*).
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
        },
        // Domain-tinted swatches for the module override matrix (kept for
        // GrantCell / toast back-compat; values mirror the status tokens).
        grant: {
          DEFAULT: "hsl(142 71% 45%)",
          muted: "hsl(142 50% 92%)",
        },
        deny: {
          DEFAULT: "hsl(0 72% 51%)",
          muted: "hsl(0 60% 95%)",
        },
        warn: {
          DEFAULT: "hsl(38 92% 50%)",
          muted: "hsl(38 92% 95%)",
        },
        // Brand palette — emerald + slate (AuthLayout, LandingPage, errors).
        brand: {
          DEFAULT: "hsl(var(--brand))",
          fg: "hsl(var(--brand-fg))",
          muted: "hsl(var(--brand-muted))",
          ink: "hsl(var(--brand-ink))",
        },
      },
      // Compact scale (owner 2026-07-03): sections cap at 5px corners.
      borderRadius: {
        xl: "calc(var(--radius) + 1px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 1px)",
        sm: "calc(var(--radius) - 2px)",
      },
      // 18px is the app-wide heading cap (owner 2026-07-03); body text below.
      fontSize: {
        display: ["1.125rem", { lineHeight: "1.4", letterSpacing: "-0.01em", fontWeight: "600" }],
        h1: ["1.125rem", { lineHeight: "1.4", letterSpacing: "-0.01em", fontWeight: "600" }],
        h2: ["0.9375rem", { lineHeight: "1.4", letterSpacing: "-0.005em", fontWeight: "600" }],
        h3: ["0.8125rem", { lineHeight: "1.4", fontWeight: "600" }],
        body: ["0.875rem", { lineHeight: "1.5" }],
        "body-lg": ["1rem", { lineHeight: "1.55" }],
        caption: ["0.75rem", { lineHeight: "1.4" }],
        overline: ["0.6875rem", { lineHeight: "1.3", letterSpacing: "0.08em" }],
      },
      boxShadow: {
        xs: "0 1px 2px 0 hsl(222 47% 11% / 0.05)",
        sm: "0 1px 3px 0 hsl(222 47% 11% / 0.08), 0 1px 2px -1px hsl(222 47% 11% / 0.06)",
        md: "0 4px 12px -2px hsl(222 47% 11% / 0.10), 0 2px 6px -2px hsl(222 47% 11% / 0.06)",
        lg: "0 12px 28px -6px hsl(222 47% 11% / 0.14)",
      },
      transitionDuration: { fast: "120ms", base: "180ms", slow: "280ms" },
      transitionTimingFunction: { "out-quad": "cubic-bezier(0.25,0.46,0.45,0.94)" },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        // A draw being rolled again: the die tumbles rather than spins flat,
        // so the wait reads as ATTEMPTS being made, not a generic spinner.
        tumble: {
          "0%": { transform: "rotate(0deg) scale(1)" },
          "45%": { transform: "rotate(200deg) scale(1.12)" },
          "100%": { transform: "rotate(360deg) scale(1)" },
        },
        // One of a row of pips lighting in turn — the search moving along.
        pip: {
          "0%, 100%": { opacity: "0.2", transform: "scale(0.7)" },
          "35%": { opacity: "1", transform: "scale(1)" },
        },
        // The ring that keeps sweeping while the attempts run.
        sweep: {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        // The side drawer: off the right edge, in. Paired with `fade-in` on the
        // scrim so the page behind it dims at the same time.
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        // The same drawer on a phone, where the reachable edge is the bottom
        // one: up off the bottom edge, in.
        "slide-in-up": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 180ms ease-out both",
        "fade-up": "fade-up 200ms ease-out both",
        "scale-in": "scale-in 150ms ease-out both",
        shimmer: "shimmer 1.6s infinite",
        tumble: "tumble 1.8s cubic-bezier(0.45,0,0.55,1) infinite",
        pip: "pip 1.4s ease-in-out infinite",
        sweep: "sweep 2.4s linear infinite",
        "slide-in-right":
          "slide-in-right 260ms cubic-bezier(0.25,0.46,0.45,0.94) both",
        "slide-in-up":
          "slide-in-up 260ms cubic-bezier(0.25,0.46,0.45,0.94) both",
      },
    },
  },
  // tailwindcss-animate added in M3 (Radix data-state animations); needs
  // --legacy-peer-deps to install against this toolchain.
  plugins: [],
};
