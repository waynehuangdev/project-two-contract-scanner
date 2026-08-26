import type { DateWindow, Notice, SourceId } from '../types.ts';

/**
 * The seam that lets source two cost a file rather than a refactor.
 *
 * v1 ships one implementation and no source picker in the UI — a picker with
 * two options greyed out reads as unfinished. But the interface exists from day
 * one, because the thing worth demonstrating is a pluggable layer over feeds
 * that are structurally nothing alike: SAM.gov is a documented JSON API,
 * a PlanetBids district portal is an ASP.NET page you scrape.
 *
 * The contract is deliberately narrow. An adapter fetches a window and hands
 * back normalized Notices. It does not cache, score, rank, or filter on
 * anything the user chose — those belong to layers above, and keeping them out
 * is what makes a second implementation cheap.
 */
export interface SourceAdapter {
  readonly id: SourceId;

  /**
   * Fetch every notice posted in `window` matching any of `naicsCodes`,
   * already normalized and already stripped of excluded notice types.
   *
   * Implementations own their own pagination and their own rate-limit
   * arithmetic. `onCall` fires once per outbound HTTP request against the
   * upstream API so the caller can meter a daily budget it does not otherwise
   * have visibility into.
   */
  fetchWindow(args: {
    window: DateWindow;
    naicsCodes: string[];
    onCall?: () => void;
  }): Promise<FetchResult>;
}

export interface FetchResult {
  notices: Notice[];
  /** Outbound HTTP requests this fetch actually spent. The number the daily budget is measured in. */
  callsSpent: number;
  /** True when pagination stopped at a cap rather than at the end of the result set. */
  truncated: boolean;
}

export class SourceError extends Error {
  readonly source: SourceId;
  readonly status: number | undefined;

  constructor(message: string, source: SourceId, status?: number) {
    super(message);
    this.name = 'SourceError';
    this.source = source;
    this.status = status;
  }
}
