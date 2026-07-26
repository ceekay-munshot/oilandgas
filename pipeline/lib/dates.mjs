/** Pure date/series helpers. No network, no I/O. */

/** 'YYYY-MM-DD' for the first of the month containing `iso`. */
export function monthKey(iso) {
  return `${String(iso).slice(0, 7)}-01`;
}

/** The first-of-month keys for the `count` months ending at `endIso`, oldest first. */
export function lastMonths(count, endIso) {
  const [y, m] = String(endIso).slice(0, 7).split('-').map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`);
  }
  return out;
}

/**
 * Collapse dated observations into one mean per calendar month.
 * @param {{date:string,value:number}[]} points
 * @returns {{date:string,value:number}[]} oldest first, month-start dated
 */
export function monthlyAverage(points) {
  const buckets = new Map();
  for (const p of points) {
    if (p == null || !Number.isFinite(p.value)) continue;
    const k = monthKey(p.date);
    const b = buckets.get(k) || { sum: 0, n: 0 };
    b.sum += p.value;
    b.n += 1;
    buckets.set(k, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, b]) => ({ date, value: round(b.sum / b.n, 4) }));
}

/**
 * Take the last `count` months, dropping anything older. Months with no
 * observation are omitted rather than interpolated - a gap is a fact about the
 * source, and inventing a midpoint would be inventing a number.
 */
export function takeLastMonths(points, count) {
  return points.slice(-count);
}

/**
 * Flag a trailing month that has not finished yet.
 *
 * A monthly mean taken on the 24th is a month-to-date figure, not a month. It
 * is still the most useful "where are we now" number, so it is kept rather than
 * dropped - but it is marked, so the dashboard can say so and later steps can
 * choose to exclude it from a rank or a trend.
 *
 * @param {{date:string,value:number}[]} points oldest first
 * @param {string} todayIsoDate 'YYYY-MM-DD'
 */
export function markPartialMonth(points, todayIsoDate) {
  if (!points.length) return points;
  const last = points[points.length - 1];
  const isCurrentMonth = last.date.slice(0, 7) === String(todayIsoDate).slice(0, 7);
  if (!isCurrentMonth) return points;

  const [y, m] = todayIsoDate.slice(0, 7).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dayOfMonth = Number(todayIsoDate.slice(8, 10));
  if (dayOfMonth >= daysInMonth) return points;

  return [...points.slice(0, -1), { ...last, partial: true }];
}

export function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Today as 'YYYY-MM-DD' in UTC. Injectable so tests stay deterministic. */
export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
