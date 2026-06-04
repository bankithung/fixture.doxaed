# Adversarial Verify B — Dialog focus trap

FINDING (input):
- severity: high
- area: Dialog primitive
- file: frontend/src/components/ui/dialog.tsx:18
- title: "Dialog has no focus trap — Tab escapes the modal"

## Verdict
REAL = true. Severity corrected to **medium**.

## Evidence (read of the real file)
frontend/src/components/ui/dialog.tsx, full read.

1. The only keyboard handler is Escape-only:
   - L24-31 `useEffect`: `const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onOpenChange(false); };`
   - No `Tab` / `Shift+Tab` interception anywhere in the file.

2. No focus management at all:
   - No `ref`, no `element.focus()`, no query of focusable descendants.
   - No initial focus when `open` becomes true (L33 just renders).
   - No focus restoration to the trigger on close.

3. Background is not made inert:
   - L34-48 render only adds an overlay `<div role="dialog" aria-modal="true">` (L35-38).
   - Background DOM is not `inert` / `aria-hidden`, so Tab reaches elements behind the overlay.

4. `aria-modal="true"` (L37) is an AT hint only; it does NOT trap browser Tab focus. A real trap needs JS, which is absent.

5. Self-documented gap: comment L5-9 says this is a minimal hand-rolled primitive ("We avoid pulling Radix... Replace with @radix-ui/dialog when shadcn primitives are formally adopted"). Radix would provide the missing focus trap; this scaffold does not.

## Why REAL
A modal dialog with no focus trap, no initial focus, and no focus restoration violates expected modal keyboard behavior and WCAG 2.1 AA (2.4.3 Focus Order; 4.1.2). Project invariant #13 mandates "WCAG 2.1 AA on all non-scorer UIs" from day 1, so this is a genuine, shippable defect affecting every consumer of `Dialog`.

## Why severity = medium (not high)
- Bounded, well-understood a11y gap in a single UI primitive; no security/data-integrity/multi-tenancy impact.
- File explicitly marks itself as a temporary scaffold slated for Radix replacement, which fixes it wholesale.
- Affects all dialogs (raising it above low), but "high" overstates a known, contained, easily-remediated a11y issue.

Confidence: 0.9
