/**
 * Turns a symbol's raw dividend-announcement history (ascending by date,
 * from fetchDividendHistory in lib/psx.js) into the three dividend columns:
 * the last announced date, the last paid amount, and a projected next date.
 *
 * The projection is a plain historical-cadence estimate — the average gap
 * between the last few announcements, added to the most recent one — not a
 * prediction based on any company guidance. It needs at least two past
 * announcements to say anything; a single data point has no cadence to
 * project from.
 */
export function summarizeDividends(history) {
  if (!history || history.length === 0) {
    return { lastAnnouncedDate: null, lastAmount: null, expectedNextDate: null };
  }

  const last = history[history.length - 1];
  const lastAnnouncedDate = last.date;
  const lastAmount = last.amount ?? null;

  if (history.length < 2) {
    return { lastAnnouncedDate, lastAmount, expectedNextDate: null };
  }

  // Average the gaps between the last few announcements (up to the last 4,
  // i.e. up to 3 gaps) — recent cadence matters more than a company's
  // decade-old payout schedule, which may no longer hold.
  const recent = history.slice(-4);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) gaps.push(recent[i].date - recent[i - 1].date);
  const avgGapMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  return { lastAnnouncedDate, lastAmount, expectedNextDate: lastAnnouncedDate + avgGapMs };
}
