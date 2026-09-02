/**
 * How long anything keyed to a single notice survives in KV.
 *
 * Descriptions and scores were written with no expiry. Both are keyed by
 * notice ID, and SAM.gov posts roughly a hundred IT notices a week — so the
 * store grew by that much every week, forever, for data that stops being
 * useful almost immediately.
 *
 * It stops being useful fast because the scanner only ever looks at a trailing
 * SEVEN day window. A notice outside that window is never read again by
 * anything. Ninety days is therefore about twelve times longer than strictly
 * needed, and that slack is deliberate: it costs nothing at this volume, and
 * it means a notice re-posted as an amendment, or a window widened later, or a
 * corpus re-harvested for the offline harness, still finds warm entries rather
 * than paying to re-read them.
 *
 * What is NOT expired, and why:
 *
 *   `glossary:<TERM>`  Keyed by term, not by notice. The vocabulary of named
 *                      federal systems is bounded — a few hundred entries that
 *                      recur across notices and across years — so it does not
 *                      grow with the feed. And what PAWSS is does not change.
 *                      Expiring it would re-buy the same answers forever.
 *
 *   `pool:v1`          A single key, overwritten in place each refresh. It
 *                      cannot grow. It also deliberately carries no expiry:
 *                      an entry that vanishes takes the stale-serve fallback
 *                      with it, which is the difference between a degraded
 *                      page and a broken one.
 *
 *   `sam_calls:<date>` Already expires after 8 days.
 */
export const NOTICE_TTL_SECONDS = 90 * 24 * 60 * 60;

/** KV rejects any expirationTtl below 60 seconds. */
export const MIN_KV_TTL_SECONDS = 60;
