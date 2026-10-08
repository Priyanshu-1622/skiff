export interface DayGroup<T> {
  label: string;
  items: T[];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Splits an already-ordered list into runs that share a local calendar day,
 * labelled "Today", "Yesterday" or a short local date (with the year when it
 * isn't the current one). Order is preserved; an unparseable date goes into an
 * "Earlier" group rather than throwing.
 */
export function groupByDay<T extends { startedAt: string }>(items: T[], now: Date = new Date()): DayGroup<T>[] {
  const todayKey = dayKey(now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayKey = dayKey(yesterday);

  const groups: DayGroup<T>[] = [];
  let currentKey: string | null = null;
  for (const item of items) {
    const d = new Date(item.startedAt);
    const valid = !Number.isNaN(d.getTime());
    const key = valid ? dayKey(d) : "invalid";
    if (key !== currentKey) {
      let label = "Earlier";
      if (valid) {
        if (key === todayKey) label = "Today";
        else if (key === yesterdayKey) label = "Yesterday";
        else {
          label = d.toLocaleDateString(undefined, {
            weekday: "short", month: "short", day: "numeric",
            ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
          });
        }
      }
      groups.push({ label, items: [] });
      currentKey = key;
    }
    groups[groups.length - 1]!.items.push(item);
  }
  return groups;
}
