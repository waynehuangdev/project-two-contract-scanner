import type { Profile } from '../types.ts';
import type { ScoreResult } from './score.ts';

/**
 * The score cache.
 *
 * Keyed `(noticeId, profileHash)`. The profile space is small by design — 3
 * areas x 4 sizes x 2 set-aside = 24 combinations — so the cache goes warm
 * within a day of any traffic and most visitors pay nothing.
 *
 * That bounded space is the reason the field list is short. It is not
 * minimalism for its own sake: an unbounded profile (a freetext description,
 * say) would make every visitor a cache miss and every scan a full cold score.
 */

/**
 * A short, stable hash of the profile.
 *
 * FNV-1a rather than anything cryptographic: this is a cache key, not a
 * security boundary, and the alternative — JSON in the key — makes KV keys
 * long and brittle against field reordering.
 */
export function profileHash(profile: Profile): string {
  const canonical = `${profile.area}|${profile.size}|${profile.setAside}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export class ScoreCache {
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  private key(noticeId: string, hash: string): string {
    return `score:${hash}:${noticeId}`;
  }

  async get(noticeId: string, profile: Profile): Promise<ScoreResult | null> {
    const raw = await this.kv.get(this.key(noticeId, profileHash(profile)));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ScoreResult;
    } catch {
      return null;
    }
  }

  async put(noticeId: string, profile: Profile, result: ScoreResult): Promise<void> {
    // No expiry. A notice's text is fixed and the prompt version is part of the
    // deployment, so a cached score stays valid until the notice ages out of
    // the window and nothing asks for it again.
    await this.kv.put(this.key(noticeId, profileHash(profile)), JSON.stringify(result));
  }
}

/**
 * How many uncached notices to score in a single request.
 *
 * Cloudflare's free tier allows 50 subrequests per request. A scan already
 * spends up to 6 on the SAM.gov refresh, and each cold notice costs one model
 * call plus up to two more when the glossary pass fires. Twelve is the number
 * that fits with room to spare.
 *
 * This is why a scan reports `stillReading` rather than pretending the bucket
 * is fully scored. A cold profile fills in over a few requests; every visitor
 * after that gets the whole set instantly. Claiming otherwise would mean
 * either a request that dies mid-scan or a silent truncation presented as a
 * complete answer — and a rejection line computed over a silently truncated
 * set is simply a wrong number.
 */
export const MAX_COLD_SCORES_PER_REQUEST = 12;
