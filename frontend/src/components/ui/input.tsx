import * as React from "react";
import { cn } from "@/lib/tailwind";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/** Native picker/spinner types whose calendar/clock/spinner chrome must follow
 * the dark theme (owner: dark-mode date/time contrast). Applied centrally so no
 * individual field can forget it. */
const PICKER_TYPES = new Set([
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "number",
]);

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        PICKER_TYPES.has(type) && "dark:[color-scheme:dark]",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
