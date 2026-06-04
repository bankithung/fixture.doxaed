import * as React from "react";
import { cn } from "@/lib/tailwind";

export type ToastKind = "info" | "success" | "error";

export interface ToastMessage {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  /** Auto-dismiss in ms; 0/undefined = sticky. */
  ttlMs?: number;
}

interface ToastContextValue {
  toasts: ToastMessage[];
  push: (m: Omit<ToastMessage, "id">) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function ToastProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);
  const dismiss = React.useCallback((id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);
  const push = React.useCallback(
    (m: Omit<ToastMessage, "id">): string => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `t_${Math.random().toString(36).slice(2)}`;
      const ttl = m.ttlMs ?? 5_000;
      setToasts((cur) => [...cur, { ...m, id }]);
      if (ttl > 0) {
        setTimeout(() => dismiss(id), ttl);
      }
      return id;
    },
    [dismiss],
  );
  const value = React.useMemo(
    () => ({ toasts, push, dismiss }),
    [toasts, push, dismiss],
  );
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  toasts,
  dismiss,
}: {
  toasts: ToastMessage[];
  dismiss: (id: string) => void;
}): React.ReactElement {
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((tm) => (
        <div
          key={tm.id}
          role={tm.kind === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto rounded-md border p-3 shadow-md",
            tm.kind === "error" && "border-destructive bg-destructive/10",
            tm.kind === "success" && "border-grant bg-grant-muted",
            tm.kind === "info" && "bg-card",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm">
              <div className="font-medium">{tm.title}</div>
              {tm.description ? (
                <div className="text-muted-foreground">{tm.description}</div>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(tm.id)}
              className="rounded p-1 text-xs hover:bg-muted"
            >
              x
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
