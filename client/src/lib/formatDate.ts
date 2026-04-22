/**
 * Format a date as a relative string for recent times, absolute for older.
 * Examples: "just now", "3m", "2h", "Apr 2", "Apr 2, 2024"
 */
export function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;

  if (diff < 45) return 'just now';
  if (diff < 60 * 60) return `${Math.round(diff / 60)}m`;
  if (diff < 60 * 60 * 24) return `${Math.round(diff / 3600)}h`;
  if (diff < 60 * 60 * 24 * 7) return `${Math.round(diff / 86400)}d`;

  const currentYear = new Date().getFullYear();
  const sameYear = d.getFullYear() === currentYear;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
