import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { notificationsApi } from "@/api/notifications";
import { t } from "@/lib/t";

/** Notification bell: unread badge + dropdown panel with mark-read actions. */
export function NotificationBell(): React.ReactElement {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: notificationsApi.list,
    refetchInterval: 30_000,
  });
  const unread = query.data?.unread_count ?? 0;
  const items = query.data?.results ?? [];

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["notifications"] });
  const markAll = useMutation({
    mutationFn: notificationsApi.markAllRead,
    onSuccess: invalidate,
  });
  const markOne = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: invalidate,
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={
          unread > 0 ? t(`Notifications (${unread} unread)`) : t("Notifications")
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell aria-hidden="true" className="h-5 w-5" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[1rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={t("Notifications")}
          className="absolute right-0 z-30 mt-2 w-80 rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">{t("Notifications")}</span>
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                className="text-xs text-primary hover:underline"
              >
                {t("Mark all read")}
              </button>
            ) : null}
          </div>
          <div className="max-h-80 overflow-auto py-1">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t("No notifications yet.")}
              </p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  role="menuitem"
                  onClick={() => markOne.mutate(n.id)}
                  className={`block w-full px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none ${
                    n.read_at ? "opacity-60" : ""
                  }`}
                >
                  <div className="text-sm font-medium">{n.title}</div>
                  {n.body ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {n.body}
                    </div>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
