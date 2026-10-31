/**
 * Calendar arithmetic for rental renewals.
 *
 * All in UTC. A renewal date is a promise to a paying customer, and a server
 * whose timezone changes — a redeploy in another region, a DST boundary — must
 * not move it.
 */

/**
 * One calendar month on, clamped to the last day of the target month.
 *
 * `Date.setMonth` overflows instead of clamping: 31 January plus one month is
 * 3 March, so a DID rented on the 31st would renew a day or three late every
 * short month and, over a year, collect fewer charges than months elapsed.
 * February is the expensive case — two or three free days per DID per year,
 * silently.
 *
 * Clamping is applied per step, so a date that lands on the 28th stays on the
 * 28th rather than growing back to the 31st — a DID first rented on the 31st
 * settles permanently on the 28th after its first February.
 *
 * Be clear about who that favours: it does not. Drifting *earlier* means the
 * customer pays a full month's price for a 28-day cycle on the step where the
 * clamp bites, so the platform gains those days, not the customer. The drift
 * is bounded and happens once, which is why it is acceptable — not because it
 * is generous. Remembering the original day-of-month is the fairer rule and is
 * also defensible; it needs an anchor column, and that is the trade being made
 * here. Anyone adding that column should know they are correcting a small bias,
 * not just tidying an edge case.
 */
/**
 * Whole days on, in UTC.
 *
 * Used for the non-payment grace window, which is a duration rather than a
 * calendar step — seven days is seven days regardless of which month it
 * crosses, so no clamping applies.
 */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

export function addOneMonth(from: Date): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();

  const targetYear = month === 11 ? year + 1 : year;
  const targetMonth = month === 11 ? 0 : month + 1;

  // Day 0 of the month after the target is the target's last day.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(day, lastDay),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}
