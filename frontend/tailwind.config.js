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
        // Domain-tinted swatches for the module override matrix.
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
        // Brand palette — emerald + slate. Used by AuthLayout, LandingPage,
        // and the landing/error surfaces. Values mirror tailwind defaults so
        // existing utility classes (`text-emerald-700`, `bg-slate-900`) keep
        // working without configuration drift.
        brand: {
          DEFAULT: "hsl(160 84% 30%)", // emerald-700
          fg: "hsl(0 0% 100%)",
          muted: "hsl(160 50% 96%)",
          ink: "hsl(222 47% 11%)", // slate-900
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};
