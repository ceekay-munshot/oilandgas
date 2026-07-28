/**
 * Trajectory flags from a 4-quarter KPI series. Pure arithmetic.
 *
 * The dashboard's five trajectory flags (framework.json) describe momentum, not
 * just direction:
 *   accelerating   rising, and faster than last quarter
 *   decelerating   rising but slower - or declining (there is no separate
 *                  "declining" flag, so a sustained fall reads as the cautionary
 *                  decelerating)
 *   steady         holding about the same pace
 *   inflecting-up  was falling, has just turned up
 *   inflecting-down was rising, has just turned down
 *
 * trajectoryFlag already reads a series quarter-on-quarter: "accelerating" means
 * the latest quarter's change is bigger than the one before it. So a level KPI,
 * a quarter-on-quarter stock like an order book, and an already-year-on-year
 * growth figure are all flagged on their own value series - flagBasis records how
 * a reader should read the number, but the momentum logic is the same for all
 * three. (Differencing a qoq series a second time was tried and rejected: it
 * loses the sign, so a steadily *shrinking* order book read as "steady".)
 *
 * A dead-band (flatBandPct of the series' own scale) keeps tiny wobbles from
 * reading as a trend. Fewer than three usable points is not enough to judge
 * momentum, so the flag is null rather than a guess.
 */

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * The series the flag is computed on, per the brief's series-handling rules.
 *
 *   flow   (level) - trend the 4-quarter series directly
 *   stock  (qoq)   - "display the full 4-quarter LEVEL history in the table, but
 *                     compute the trajectory flag on the quarter-over-quarter
 *                     change row, because a large order book that has stopped
 *                     growing is a decelerating signal, not a positive one"
 *   seasonal (yoy) - trend the year-on-year growth. The KPIs carrying this basis
 *                    already hold growth figures as their values (the spec names
 *                    them that way: "CNG+PNG volume growth (YoY)"), so the values
 *                    ARE the YoY series and are trended directly.
 *
 * A null inside the window breaks the change it would take part in, rather than
 * being bridged - a gap is not a zero move.
 *
 * @param {(number|null)[]} values
 * @param {'level'|'qoq'|'yoy'} flagBasis
 * @returns {(number|null)[]}
 */
export function flagBasisSeries(values, flagBasis) {
  const v = Array.isArray(values) ? values.slice() : [];
  if (flagBasis !== 'qoq') return v;
  const out = [];
  for (let i = 1; i < v.length; i++) {
    out.push(isNum(v[i]) && isNum(v[i - 1]) ? v[i] - v[i - 1] : null);
  }
  return out;
}

/**
 * The flag for a CHANGE series (a stock variable's quarter-on-quarter row).
 *
 * A change series has to be read one order lower than a level series: here the
 * latest change is itself the signal, so the comparison is change-vs-change, not
 * change-of-change. Reading it the level way is what made a steadily shrinking
 * order book come out "steady" - the change was constant, so the second
 * difference was zero.
 *
 * @param {(number|null)[]} changes
 * @param {number} [flatBandPct=1.5]
 * @returns {string|null}
 */
export function changeSeriesFlag(changes, flatBandPct = 1.5, levelScale = null) {
  const s = (changes || []).filter(isNum);
  if (s.length < 2) return null;              /* need two changes to compare */

  /* The dead band asks "is this move big enough to mean anything for this KPI",
     which is a fraction of the KPI's own SIZE, not of its recent changes. Sizing
     it off the changes would make every quiet series look volatile: a 40 move on
     a 3,000 order book is 1.3%, and reads as a turn only if the yardstick is the
     other 40s rather than the 3,000. The level scale is passed in for that. */
  const scale = isNum(levelScale) && levelScale
    ? Math.abs(levelScale)
    : (s.reduce((a, b) => a + Math.abs(b), 0) / s.length || 1);
  const band = scale * (flatBandPct / 100);
  const snap = (x) => (Math.abs(x) < band ? 0 : x);

  const last = snap(s[s.length - 1]);
  const prev = snap(s[s.length - 2]);

  /* The book turned: growth resumed after shrinking, or growth went negative.
     Only a genuinely negative change counts as inflecting down - the brief
     files merely stopping at zero under decelerating, not under a turn. */
  if (last > 0 && prev <= 0) return 'inflecting-up';
  if (last < 0 && prev > 0) return 'inflecting-down';
  /* Stalled or shrinking. "A large order book that has stopped growing is a
     decelerating signal, not a positive one" - this is that sentence. */
  if (last <= 0) return 'decelerating';
  /* still growing: faster, slower, or at the same pace */
  if (last > prev) return 'accelerating';
  if (last < prev) return 'decelerating';
  return 'steady';
}

/**
 * @param {(number|null)[]} series
 * @param {number} [flatBandPct=1.5]
 * @returns {string|null} a framework trajectoryFlags id, or null
 */
export function trajectoryFlag(series, flatBandPct = 1.5) {
  const s = (series || []).filter(isNum);
  if (s.length < 3) return null;                    // not enough to judge momentum

  const scale = s.reduce((a, b) => a + Math.abs(b), 0) / s.length || 1;
  const band = Math.abs(scale) * (flatBandPct / 100);
  const snap = (x) => (Math.abs(x) < band ? 0 : x);

  const last = snap(s[s.length - 1] - s[s.length - 2]);
  const prev = snap(s[s.length - 2] - s[s.length - 3]);

  if (last > 0 && prev < 0) return 'inflecting-up';
  if (last < 0 && prev > 0) return 'inflecting-down';
  if (last > 0) return last > prev ? 'accelerating' : (last < prev ? 'decelerating' : 'steady');
  if (last < 0) return 'decelerating';              // sustained decline - cautionary

  /* The latest move is inside the dead band, so the series is flat NOW. That is
     'steady' whatever it did before.
     This used to return 'inflecting-up' when the previous move was down - "was
     falling, now flat" - and that was wrong in a way that mattered: framework.json
     defines inflecting-up as "was falling, has just started to rise", and flat is
     not rising. It put Deep Industries' order book (3051, 3050, 2967, 3000 - a
     +33 move inside a 45-wide band) into the "Just turned up" filter, which is the
     one list the client is meant to act on. A false positive there is expensive. */
  return 'steady';
}

/**
 * Convenience: values + basis -> flag id, routed to the right reading.
 * A stock variable is judged on its change row; everything else on its own.
 */
export function flagFor(values, flagBasis, flatBandPct = 1.5) {
  const series = flagBasisSeries(values, flagBasis);
  if (flagBasis !== 'qoq') return trajectoryFlag(series, flatBandPct);
  /* the stock's own average level is the yardstick its changes are judged against */
  const levels = (values || []).filter(isNum);
  const levelScale = levels.length
    ? levels.reduce((a, b) => a + Math.abs(b), 0) / levels.length
    : null;
  return changeSeriesFlag(series, flatBandPct, levelScale);
}
