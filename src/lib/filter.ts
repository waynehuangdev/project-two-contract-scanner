import { SERVICE_AREAS, SIZE_BANDS } from '../config.ts';
import type { Notice, Profile } from '../types.ts';

/**
 * The hard-constraint half of the split the whole project rests on.
 *
 * Everything here is `WHERE`-clause territory: exact, cheap, explicable, and
 * containing no judgment whatsoever. The model never sees these decisions and
 * never gets to overrule them. Judgment happens one layer up, on the survivors.
 *
 * Keeping the boundary this clean is what makes the rejection line honest —
 * "62 matched your filters · 9 worth reading" is only a meaningful sentence if
 * the two numbers were produced by genuinely different kinds of work.
 */
export function applyHardFilters(notices: Notice[], profile: Profile): Notice[] {
  const codes = new Set(SERVICE_AREAS[profile.area].naics);
  const band = SIZE_BANDS[profile.size];

  return notices.filter((n) => {
    if (!n.naics || !codes.has(n.naics)) return false;

    if (profile.setAside === 'small-business' && !isSmallBusinessSetAside(n.setAside)) return false;

    if (profile.size !== 'any') {
      // A notice with no stated value cannot be shown to satisfy a band, and
      // excluding it is the conservative read: claiming an unpriced contract
      // is "under $250k" is the same class of fabrication as inventing a
      // deadline. Most federal solicitations state no value, so this filter is
      // brutal by design — which is why 'Any' is the default.
      if (n.valueEstimate === null) return false;
      if (band.min !== null && n.valueEstimate < band.min) return false;
      if (band.max !== null && n.valueEstimate >= band.max) return false;
    }

    return true;
  });
}

/**
 * SAM.gov expresses set-aside as free text with many variants (Total Small
 * Business, 8(a), WOSB, SDVOSB, HUBZone...). All of them are restricted to
 * small business in the sense a 15-person agency cares about, so match broadly
 * rather than enumerating codes that change.
 */
export function isSmallBusinessSetAside(setAside: string | null): boolean {
  if (!setAside) return false;
  const s = setAside.toLowerCase();
  return (
    s.includes('small business') ||
    s.includes('8(a)') ||
    s.includes('8a') ||
    s.includes('wosb') ||
    s.includes('edwosb') ||
    s.includes('sdvosb') ||
    s.includes('service-disabled') ||
    s.includes('hubzone')
  );
}
