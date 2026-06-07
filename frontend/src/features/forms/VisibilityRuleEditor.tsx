import type { Field, Visibility, VisibilityOp } from "./types";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { t } from "@/lib/t";

/** Visibility operators offered in the rule builder (mirrors backend
 *  `VISIBILITY_OPS` + the evaluator in `@/lib/formLogic`). */
const VISIBILITY_OPS: { value: VisibilityOp; label: string }[] = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "in", label: "is one of" },
  { value: "includes", label: "includes" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
  { value: "answered", label: "is answered" },
];

const CHOICE_TYPES = new Set<string>([
  "single_choice",
  "multi_choice",
  "dropdown",
]);

/** Operators that don't need a value input. */
const VALUELESS_OPS = new Set<VisibilityOp>(["answered"]);

/** Operators that store the value as an ARRAY of trigger-option values
 *  (authored via a checkbox list). Mirrors the array-aware `in` branch in
 *  `@/lib/formLogic.isVisible` / backend `_visible`. */
const MULTI_OPS = new Set<VisibilityOp>(["in"]);

/** Coerce a rule's stored value into the string array a multi-select expects. */
function asValueArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

/**
 * Authoring control for a single `Visibility` rule, reused for BOTH field-level
 * ("Show this field when…") and section-level ("Show this section when…") gates.
 *
 * Flow: pick a trigger field (or "Always show" → clears the rule) → pick an
 * operator → supply a value. The value editor adapts to the operator:
 *   - `answered`            → no value input.
 *   - `in` (multi)          → a checkbox list of the trigger's options; stores
 *                             an ARRAY (e.g. ["sepak","both"]), round-tripping
 *                             checked state from that array.
 *   - choice trigger + op   → a single Select of the trigger's options.
 *   - text/number trigger   → a free-text input (gt/lt/equals on typed values).
 */
export function VisibilityRuleEditor({
  label,
  rule,
  triggers,
  onChange,
}: {
  label: string;
  rule: Visibility | null | undefined;
  triggers: Field[];
  onChange: (rule: Visibility | null) => void;
}): React.ReactElement {
  const trigger = triggers.find((f) => f.key === rule?.field);
  const triggerOpts = [
    { value: "", label: t("Always show") },
    ...triggers.map((f) => ({ value: f.key, label: f.label || f.key })),
  ];
  const triggerOptions = trigger?.options ?? [];
  const valueOpts = triggerOptions.map((o) => ({
    value: String(o.value),
    label: o.label,
  }));
  const isChoiceTrigger = trigger ? CHOICE_TYPES.has(trigger.type) : false;
  const op = rule?.op ?? "equals";
  const isMulti = MULTI_OPS.has(op);

  const selectedValues = asValueArray(rule?.value);
  const toggleValue = (optionValue: string, checked: boolean) => {
    if (!rule) return;
    const next = checked
      ? [...selectedValues.filter((v) => v !== optionValue), optionValue]
      : selectedValues.filter((v) => v !== optionValue);
    onChange({ ...rule, value: next });
  };

  return (
    <div className="flex flex-col gap-2">
      <Label>{t(label)}</Label>
      <Select
        aria-label={t("Condition field")}
        value={rule?.field ?? ""}
        options={triggerOpts}
        onChange={(field) =>
          onChange(
            field ? { field, op: rule?.op ?? "equals", value: rule?.value } : null,
          )
        }
        placeholder={t("Always show")}
      />
      {rule?.field ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
          <Select
            aria-label={t("Condition operator")}
            value={op}
            options={VISIBILITY_OPS.map((o) => ({
              value: o.value,
              label: t(o.label),
            }))}
            onChange={(nextOp) =>
              onChange({ ...rule, op: nextOp as VisibilityOp })
            }
          />
          {VALUELESS_OPS.has(op) ? null : isMulti && isChoiceTrigger ? (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-xs text-muted-foreground">
                {t("Show when the answer is any of these")}
              </legend>
              {valueOpts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("The selected field has no options to choose from.")}
                </p>
              ) : (
                valueOpts.map((o) => {
                  const checked = selectedValues.includes(o.value);
                  return (
                    <label
                      key={o.value}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleValue(o.value, e.target.checked)}
                        className="h-4 w-4 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <span>{o.label || o.value}</span>
                    </label>
                  );
                })
              )}
            </fieldset>
          ) : isChoiceTrigger && valueOpts.length > 0 ? (
            <Select
              aria-label={t("Condition value")}
              value={String(rule.value ?? "")}
              options={[
                { value: "", label: t("Select a value…") },
                ...valueOpts,
              ]}
              onChange={(value) => onChange({ ...rule, value })}
              placeholder={t("Select a value…")}
            />
          ) : (
            <input
              aria-label={t("Condition value")}
              value={String(rule.value ?? "")}
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
              placeholder={t("Value")}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
