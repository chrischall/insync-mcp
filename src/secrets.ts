// A by-value secret scrubber.
//
// `redactSecrets` (which runMcp applies to every thrown error) matches secret
// SHAPES. The values this server must keep out of its output have no shape: the
// account password, and the object-storage configuration the login response
// carries. The only way to keep those out of an error, a result or a log is to
// scrub them BY VALUE — which is what this does, over `@chrischall/mcp-utils`'
// `redactValues`.
//
// The server never talks to object storage directly (file transfer goes through
// the portal's own session-authorized endpoints), but it holds the config on the
// session so later file code can read it — and holding it is exactly why these
// values must be registered here the moment a login mints them.

import { redactValues } from '@chrischall/mcp-utils';

export class SecretScrubber {
  private readonly values = new Set<string>();

  /**
   * Register secret values to scrub. `undefined`, `null` and values shorter
   * than three characters are ignored — an empty or one-off needle would splice
   * the placeholder through ordinary text (a boolean flag, a single letter).
   */
  add(...candidates: Array<string | null | undefined>): void {
    for (const value of candidates) {
      if (typeof value === 'string' && value.length >= 3) this.values.add(value);
    }
  }

  /** Replace every registered value (raw and JSON-escaped) with `[REDACTED]`. */
  scrub(text: string): string {
    if (this.values.size === 0) return text;
    return redactValues(text, this.values);
  }

  /** Whether a value is registered — for tests and assertions. */
  has(value: string): boolean {
    return this.values.has(value);
  }

  /** How many values are registered — for tests. */
  get size(): number {
    return this.values.size;
  }
}
