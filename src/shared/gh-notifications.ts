// GitHub notifications, as the notifications panel shows them (server/gh/notifications.ts).

export type GhNotificationType = 'PullRequest' | 'Issue' | 'CheckSuite' | 'Release' | 'Discussion' | 'Commit' | 'Other';

export interface GhNotification {
  /** The thread's id, for marking it read or done. */
  id: string;
  unread: boolean;
  /** Why it came, in words: "Review requested", "Mentioned"… */
  reason: string;
  /** ms since epoch. */
  updatedAt: number;
  /** `owner/repo`. */
  repo: string;
  title: string;
  type: GhNotificationType;
  /** The pull request's or issue's number. */
  number: number | null;
  /** Where it is on github.com, at the latest comment when there is one. */
  url: string;
}

export interface GhNotifications {
  items: GhNotification[];
  /** Seconds GitHub asks clients to wait between polls. */
  poll: number;
}
