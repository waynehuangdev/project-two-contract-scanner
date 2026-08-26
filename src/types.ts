/**
 * The internal shape every source normalizes into.
 *
 * The null discipline here is load-bearing. The spec's hardest prompt rule is
 * "never invent a dollar figure or deadline" — and the first place that rule is
 * enforced is the normalizer, not the prompt. If a field is absent or unparseable
 * upstream it arrives here as null and stays null. No zero-defaults, no empty
 * strings standing in for "unknown", no `?? 'TBD'`. The model is the second line
 * of defence; this is the first.
 */
export interface Notice {
  /** Stable per-version id. Dedupe key. */
  noticeId: string;
  /** Stable across amendments — lets us trace churn even though we only ever see the latest version. */
  solicitationNumber: string | null;
  title: string;
  agency: string | null;
  /** Raw source type code, kept verbatim for display and debugging. */
  noticeType: string;
  /** ISO-8601 date. */
  postedDate: string;
  /** ISO-8601 date, or null when the source states no response deadline. */
  dueDate: string | null;
  /** USD. Null whenever the source does not state a figure — which is most of the time. */
  valueEstimate: number | null;
  /** e.g. "SBA", "8A", "WOSB". Null when unrestricted or unstated. */
  setAside: string | null;
  /** 6-digit NAICS as assigned by the contracting officer. Frequently wrong; that is the whole point of the scoring step. */
  naics: string | null;
  /**
   * The free text the model actually reads. NULL UNTIL HYDRATED.
   *
   * SAM.gov's search endpoint does not return description text — it returns a
   * link (see `descriptionUrl`), and the text costs a second request. So a
   * Notice straight out of a search page always has `description: null`, and
   * hydration is a separate, separately-cached step. See sources/samgov.ts.
   */
  description: string | null;
  /** Where the description text can be fetched from, when it is not inline. */
  descriptionUrl: string | null;
  /**
   * Product Service Code (SAM.gov `classificationCode`).
   *
   * Worth carrying even though the spec does not mention it: PSC is assigned
   * with more care than NAICS and often disagrees with it. A NAICS/PSC
   * mismatch is a strong prior that the notice is misfiled — which is exactly
   * the misfiling the scoring step exists to catch.
   */
  classificationCode: string | null;
  /** Public SAM.gov (or other source) permalink. */
  url: string | null;
  /** Which adapter produced this record. Present from day one so source two costs nothing structurally. */
  source: SourceId;
}

export type SourceId = 'sam.gov';

export type ServiceArea =
  | 'software-development'
  | 'web-digital'
  | 'data-analytics'
  | 'it-support'
  | 'cybersecurity';

export type SizeBand = 'under-250k' | '250k-1m' | 'over-1m' | 'any';

export type SetAsidePreference = 'small-business' | 'any';

export interface Profile {
  area: ServiceArea;
  size: SizeBand;
  setAside: SetAsidePreference;
}

/** A calendar window, inclusive. ISO-8601 dates; adapters format for their own API. */
export interface DateWindow {
  from: string;
  to: string;
}
