// =============================================================================
// rng.js — Seedable pseudo-random number generators
// -----------------------------------------------------------------------------
// JavaScript's built-in Math.random() can't be seeded, so the same "random"
// market could never be reproduced. This module provides small, fast,
// *seedable* generators so that a given seed always yields the exact same
// sequence of numbers — which is what lets the Replay mode replay an identical
// session for a chosen date, and lets tests be deterministic.
//
// Nothing here touches the DOM or the network; it is pure math and is imported
// by feed.js (price generation) and ladder.js (synthetic order-book depth).
// =============================================================================

/**
 * Create a deterministic uniform random generator from a 32-bit seed.
 *
 * Uses the "mulberry32" algorithm — tiny, fast, and good enough for a visual
 * trading simulator (not cryptographically secure).
 *
 * @param {number} seed - Any integer; it is coerced to an unsigned 32-bit value.
 * @returns {() => number} A function that, each time it is called, returns the
 *   next pseudo-random float in the half-open range [0, 1). The same seed always
 *   produces the same sequence.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Turn an arbitrary string into a stable 32-bit numeric seed (FNV-1a hash).
 *
 * Used so that human-friendly inputs like a date string ("2026-06-27") or a
 * contract symbol map to a fixed seed — feeding mulberry32 to reproduce the
 * same market for that input.
 *
 * @param {string} str - The text to hash (e.g. a date or symbol).
 * @returns {number} An unsigned 32-bit integer seed. Same string -> same number.
 */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Build a small bundle of seeded random helpers.
 *
 * @param {number} seed - The 32-bit seed (often produced by {@link hashSeed}).
 * @returns {{ uniform: () => number, gaussian: () => number }} An object with:
 *   - `uniform()`  -> next float in [0, 1).
 *   - `gaussian()` -> next sample from a standard normal distribution
 *                     (mean 0, standard deviation 1), via the Box-Muller
 *                     transform. Used to make realistic, bell-curved price
 *                     moves rather than flat uniform noise.
 */
export function makeRng(seed) {
  const u = mulberry32(seed);
  // Box-Muller produces two normals at a time; cache the second ("spare").
  let spare = null;   // Box-Muller yields two normals per call; stash the second
  function gaussian() {
    if (spare !== null) { const s = spare; spare = null; return s; }   // serve the cached one
    let a = 0, b = 0;
    while (a === 0) a = u();        // a must be > 0, else Math.log(a) is -Infinity
    b = u();
    const mag = Math.sqrt(-2.0 * Math.log(a));
    spare = mag * Math.sin(2 * Math.PI * b);   // cache the sine half for next call
    return mag * Math.cos(2 * Math.PI * b);    // return the cosine half now
  }
  return { uniform: u, gaussian };
}
