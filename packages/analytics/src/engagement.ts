// Daily, weekly and monthly active users, stickiness and visit frequency, from who was active each day.

/** The users active on one calendar day (`YYYY-MM-DD`). */
export type ActiveDay = { day: string; users: readonly string[] };

export type Engagement = {
  /** Users active on `today`. */
  dau: number;
  /** Users active in the 7 days ending on `today`. */
  wau: number;
  /** Users active in the 30 days ending on `today`. */
  mau: number;
  /** `dau / mau`: the share of the month's users who came today. Null with no user in the month. */
  stickiness: number | null;
  /** One point per day over the period, oldest first. */
  series: { day: string; dau: number; wau: number; mau: number }[];
  /** How many of the month's users were active on that many days of it. */
  frequency: { days: string; users: number }[];
};

const BUCKETS: { days: string; upTo: number }[] = [
  { days: "1", upTo: 1 },
  { days: "2-4", upTo: 4 },
  { days: "5-14", upTo: 14 },
  { days: "15+", upTo: Infinity },
];

/** `day` minus `n` days, on the calendar: no clock and no time zone enters. */
export function daysBefore(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().slice(0, 10);
}

/** Active days per user inside the window of `size` days ending on `until`, inclusive. */
function daysPerUser(
  byDay: Map<string, Set<string>>,
  until: string,
  size: number,
): Map<string, number> {
  const tally = new Map<string, number>();
  for (let i = 0; i < size; i++)
    for (const user of byDay.get(daysBefore(until, i)) ?? [])
      tally.set(user, (tally.get(user) ?? 0) + 1);
  return tally;
}

/**
 * Engagement as of `today`, with one series point per day over the last `period` days. `days` may hold
 * a day more than once and in any order. To fill the first point's 30-day window, read `period + 29`
 * days back.
 */
export function engagement(days: readonly ActiveDay[], today: string, period = 30): Engagement {
  const byDay = new Map<string, Set<string>>();
  for (const { day, users } of days)
    byDay.set(day, new Set([...(byDay.get(day) ?? []), ...users]));
  const active = (until: string, size: number) => daysPerUser(byDay, until, size).size;

  const series = Array.from({ length: period }, (_, i) => {
    const day = daysBefore(today, period - 1 - i);
    return { day, dau: active(day, 1), wau: active(day, 7), mau: active(day, 30) };
  });
  const dau = active(today, 1);
  const month = daysPerUser(byDay, today, 30);
  const frequency = BUCKETS.map(({ days: label }) => ({ days: label, users: 0 }));
  for (const count of month.values())
    frequency[BUCKETS.findIndex((bucket) => count <= bucket.upTo)]!.users++;
  return {
    dau,
    wau: active(today, 7),
    mau: month.size,
    stickiness: month.size === 0 ? null : dau / month.size,
    series,
    frequency,
  };
}
