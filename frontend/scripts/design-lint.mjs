#!/usr/bin/env node
/**
 * Design-lint (owner rules, master plan S3): fails when user-facing code
 * violates the design system. Run: `npm run lint:design`. Wire into CI so
 * violations cannot re-accumulate.
 *
 * Rules:
 *  R1  No Tailwind palette color utilities (emerald-500, slate-400, ...)
 *      — design tokens only.
 *  R2  No em/en dashes or arrow glyphs in user-facing string literals.
 *  R3  No `font-bold`/`font-extrabold`/`font-black` (semibold ceiling).
 *  R4  No native `<select>` (use components/ui/Select).
 *  R5  No `window.alert/confirm/prompt` (use toast/dialog).
 *
 * Allowlist: FifaBracket (approved purple/gold exception), RichTextEditor
 * content swatches, tests, and generated files.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;

const ALLOW = [
  /FifaBracket/,
  /RichTextEditor/,
  /__tests__/,
  /\.test\./,
  /vite-env\.d\.ts$/,
  /types\/generated/,
];

const PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|accent|divide|outline|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

const rules = [
  { id: "R1 palette-color", test: (line) => PALETTE.test(line) },
  {
    id: "R2 dash-or-arrow",
    test: (line) => {
      // Only flag glyphs inside string/JSX content, not comments.
      const stripped = line.trim();
      if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) {
        return false;
      }
      return /[–—→←]/.test(line);
    },
  },
  { id: "R3 font-bold", test: (line) => /\bfont-(?:bold|extrabold|black)\b/.test(line) },
  { id: "R4 native-select", test: (line) => /<select[\s>]/.test(line) },
  {
    id: "R5 native-alert",
    test: (line) => /window\.(?:alert|confirm|prompt)\(/.test(line),
  },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(tsx|ts)$/.test(name)) yield p;
  }
}

let failures = 0;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (ALLOW.some((re) => re.test(rel))) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, i) => {
    // Strip trailing line comments so annotations never trip string rules.
    const line = raw.replace(/\s\/\/.*$/, "");
    for (const rule of rules) {
      if (rule.test(line)) {
        failures += 1;
        console.log(`${rel}:${i + 1}  [${rule.id}]  ${line.trim().slice(0, 110)}`);
      }
    }
  });
}

if (failures > 0) {
  console.error(`\nDesign lint: ${failures} violation(s).`);
  process.exit(1);
}
console.log("Design lint: clean.");
