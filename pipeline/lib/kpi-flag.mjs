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
 * The series the flag is computed on. flagBasis is a reading hint; the series is
 * the values themselves in every case (see the module note).
 * @param {(number|null)[]} values
 * @param {'level'|'qoq'|'yoy'} _flagBasis
 * @returns {(number|null)[]}
 */
export function flagBasisSeries(values, _flagBasis) {
  return Array.isArray(values) ? values.slice() : [];
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

/** Convenience: values + basis -> flag id. */
export function flagFor(values, flagBasis, flatBandPct = 1.5) {
  return trajectoryFlag(flagBasisSeries(values, flagBasis), flatBandPct);
}
