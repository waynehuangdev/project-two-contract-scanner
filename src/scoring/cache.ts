import type { ScoreResult } from './score.ts';
import { NOTICE_TTL_SECONDS } from '../lib/retention.ts';

/**
 * The score cache.
 *
 * Keyed by noticeId ALONE. It used to be keyed `(noticeId, profileHash)`,
 * because each service area was scored in its own call. Now one call scores
 * every area from one shared reading, so a cached entry answers for all of
 * them — and the set-aside and size controls are hard filters applied before
 * scoring, so they never affect what the model was asked.
 *
 * The practical effect: switching service area in the UI costs nothing, and the
 * cache is 24x smaller than the profile-keyed version it replaces. A notice is
 * read once in its lifetime.
 */

const PROMPT_VERSION = 'v2-multiarea';

export class ScoreCache {
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  /**
   * The prompt version is part of the key.
   *
   * A cached score is only meaningful under the prompt that produced it. Four
   * prompt defects were fixed in one day of this build; each fix would have
   * left every previously cached score silently wrong, and stale judgements
   * are worse than no judgements because nothing about them looks stale.
   * Bumping PROMPT_VERSION retires the old ones without a migration.
   */
  private key(noticeId: string): string {
    return `score:${PROMPT_VERSION}:${noticeId}`;
  }

  async get(noticeId: string): Promise<ScoreResult | null> {
    const raw = await this.kv.get(this.key(noticeId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ScoreResult;
    } catch {
      return null;
    }
  }

  async put(noticeId: string, result: ScoreResult): Promise<void> {
    // Expires after 90 days. The prompt version in the key handles CORRECTNESS
    // — a prompt change retires stale judgements immediately. The TTL handles
    // SIZE: without it the store grows by a hundred notices a week forever,
    // for scores nothing will read again once the notice leaves the 7-day
    // window. See lib/retention.ts.
    await this.kv.put(this.key(noticeId), JSON.stringify(result), {
      expirationTtl: NOTICE_TTL_SECONDS,
    });
  }
}

/**
 * How many uncached notices to read in a single request.
 *
 * Cloudflare's free tier allows 50 subrequests per request. A scan spends up to
 * 6 on the SAM.gov refresh, and each cold notice now costs one model call plus
 * up to two more if the glossary pass fires — down from three calls per notice
 * per area, which is what made the old ceiling so tight.
 *
 * This is why a scan reports `stillReading` rather than pretending the bucket is
 * fully read. A rejection line computed over a silently truncated set is simply
 * a wrong number, and the rejection line is the product.
 */
export const MAX_COLD_SCORES_PER_REQUEST = 14;
