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

export const notificationsApi = {
  list: () => api.get<NotificationList>("/api/notifications/"),
  markRead: (id: string) =>
    api.post<NotificationItem>(`/api/notifications/${id}/read/`, {}),
  markAllRead: () => api.post<{ marked: number }>("/api/notifications/read-all/", {}),
};
