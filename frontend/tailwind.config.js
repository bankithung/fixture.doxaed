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
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontSize: {
        display: ["2.5rem", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "600" }],
        h1: ["1.875rem", { lineHeight: "1.2", letterSpacing: "-0.015em", fontWeight: "600" }],
        h2: ["1.5rem", { lineHeight: "1.25", letterSpacing: "-0.01em" }],
        h3: ["1.25rem", { lineHeight: "1.3" }],
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
      },
      animation: {
        "fade-in": "fade-in 180ms ease-out both",
        "fade-up": "fade-up 200ms ease-out both",
        "scale-in": "scale-in 150ms ease-out both",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  // tailwindcss-animate added in M3 (Radix data-state animations); needs
  // --legacy-peer-deps to install against this toolchain.
  plugins: [],
};
