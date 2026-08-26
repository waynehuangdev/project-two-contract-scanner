import { WINDOW_DAYS } from '../config.ts';
import type { DateWindow } from '../types.ts';

/**
 * The trailing N-day window, inclusive of today.
 *
 * Computed in UTC deliberately. SAM.gov posts on Eastern time and the Worker
 * runs wherever Cloudflare puts it, so a local-time window would silently
 * change width depending on which edge served the refresh.
 */
export function trailingWindow(now: Date = new Date(), days: number = WINDOW_DAYS): DateWindow {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: iso(from), to: iso(to) };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
