/**
 * Load and sanitize the SAM.gov API key from the environment.
 *
 * This file exists because of a real hour lost to it. `cmd.exe`'s
 * `set KEY="abc"` stores the quotes as part of the value, so the key arrives
 * as `"abc"` — 42 characters instead of 40. api.data.gov then rejects the
 * request with a bare 404, which reads exactly like a wrong endpoint and sends
 * you off checking documentation that was fine all along.
 *
 * Sanitizing is the smaller half of the fix. The larger half is that a key of
 * the wrong shape now says so, loudly, before spending a request to find out.
 */

/** api.data.gov issues 40-character alphanumeric keys. */
const EXPECTED_LENGTH = 40;

export interface KeyLoadResult {
  key: string | null;
  /** Human-readable problems. Non-empty does not always mean unusable. */
  warnings: string[];
  /** True when the value looked mangled and was repaired rather than used as-is. */
  repaired: boolean;
}

export function loadApiKey(raw: string | undefined): KeyLoadResult {
  const warnings: string[] = [];

  if (raw === undefined || raw.trim() === '') {
    return { key: null, warnings: ['not set'], repaired: false };
  }

  const original = raw;
  let key = raw.trim();

  // Strip one layer of matching wrapping quotes — the cmd.exe case. Only a
  // matched pair, so a key that genuinely contained a quote (none do) is not
  // silently altered.
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
    warnings.push('stripped surrounding quotes — cmd.exe `set VAR="..."` keeps them as part of the value');
  }

  // A trailing semicolon is the other common shell paste artifact.
  if (key.endsWith(';')) {
    key = key.slice(0, -1).trim();
    warnings.push('stripped a trailing semicolon');
  }

  if (key.length !== EXPECTED_LENGTH) {
    warnings.push(
      `expected ${EXPECTED_LENGTH} characters, got ${key.length} — check you copied the whole key`,
    );
  }

  // api.data.gov keys are 40 characters of [A-Za-z0-9_-]. Hyphens and
  // underscores are legitimate — an earlier version of this check flagged a
  // perfectly good key for containing a hyphen, which is worse than not
  // checking at all: a false alarm on a working credential sends you
  // debugging the one thing that was fine.
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    const bad = [...new Set(key.replace(/[A-Za-z0-9_-]/g, '').split(''))].join(' ');
    warnings.push(`contains unexpected characters (${bad}) — keys are [A-Za-z0-9_-]`);
  }

  return { key, warnings, repaired: key !== original.trim() };
}

/** One-line, safe to print: never reveals enough of the key to be useful. */
export function describeKey(key: string): string {
  return `${key.length} chars, ends "${key.slice(-4)}"`;
}
