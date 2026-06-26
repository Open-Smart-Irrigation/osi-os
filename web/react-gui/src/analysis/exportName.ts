const counts = new Map<string, number>();

function sanitize(value: string): string {
  return (value || 'user').replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function exportFileName(username: string | null, ext: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const base = `${sanitize(username ?? 'user')}_data_export_${date}_${time}`;
  const count = (counts.get(base) ?? 0) + 1;
  counts.set(base, count);
  return count === 1 ? `${base}.${ext}` : `${base}_${count}.${ext}`;
}
