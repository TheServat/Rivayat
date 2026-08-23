/**
 * Browser stand-in for `node:crypto`.
 *
 * `@rv/contracts` mints branded ids with `IdGenerator` from `@rv/shared-kernel`, and
 * that module imports `node:crypto` at the top level. The studio never mints an id or
 * hashes anything - the API owns both, because non-negotiable #1 makes ids and hashes
 * part of a run's replayable state and a browser cannot be part of that - but the
 * import is still evaluated the moment any schema is loaded, and a browser bundle
 * cannot resolve it.
 *
 * Vite therefore aliases `node:crypto` here (see `vite.config.ts`). Two functions, and
 * they behave differently on purpose:
 *
 * - `getRandomValues` forwards to Web Crypto, so anything that only needs entropy
 *   works.
 * - `createHash` throws. Silently returning a wrong hash would produce a *plausible*
 *   dedup key on the client, and a plausible-but-wrong dedup key is the one failure
 *   this system cannot tolerate (non-negotiable #2). If the studio ever genuinely needs
 *   a hash, the answer is an API call, not a polyfill.
 */

/** Fills `array` with cryptographically strong random values, via Web Crypto. */
export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  // Web Crypto's signature is narrower than Node's (it excludes `SharedArrayBuffer`
  // backing), so the cast is the whole of the impedance mismatch. The array is filled
  // in place either way.
  globalThis.crypto.getRandomValues(array as unknown as Uint8Array<ArrayBuffer>);
  return array;
}

/** Always throws. Hashing is the API's job; see the module comment. */
export function createHash(algorithm: string): never {
  throw new Error(
    `node:crypto.createHash("${algorithm}") is not available in the studio. ` +
      'Content hashes and dedup keys are computed by the API so that a run stays replayable.',
  );
}

export default { getRandomValues, createHash };
