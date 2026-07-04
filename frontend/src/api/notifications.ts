import { api } from "./client";

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string;
  read_at: string | null;
  created_at: string;
  tournament: string | null;
}

export interface NotificationList {
  results: NotificationItem[];
  unread_count: number;
}

/** One row of the preferences matrix (server catalog + effective switches). */
export interface NotificationPrefKind {
  kind: string;
  label: string;
  description: string;
  in_app: boolean;
  email: boolean;
}

export interface NotificationPrefs {
  kinds: NotificationPrefKind[];
  digest: boolean;
}

/** Partial update: only the switches being flipped. */
export interface NotificationPrefsUpdate {
  kinds?: Record<string, { in_app?: boolean; email?: boolean }>;
  digest?: boolean;
}

export const notificationsApi = {
  list: () => api.get<NotificationList>("/api/notifications/"),
  markRead: (id: string) =>
    api.post<NotificationItem>(`/api/notifications/${id}/read/`, {}),
  markAllRead: () => api.post<{ marked: number }>("/api/notifications/read-all/", {}),
  prefs: () => api.get<NotificationPrefs>("/api/notifications/prefs/"),
  updatePrefs: (payload: NotificationPrefsUpdate) =>
    api.put<NotificationPrefs>("/api/notifications/prefs/", payload),
};
