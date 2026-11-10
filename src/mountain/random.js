/**
 * Seeded random numbers, so the same seed and settings always generate the
 * same mountain. Plain math, used inside the mountain worker.
 */

/** A new seed to show in the dialog and start a generation from. */
export function randomSeed() {
  return Math.floor(Math.random() * 1e6);
}

/** A random number generator (mulberry32) that always gives the same sequence for a seed. */
export function createRandom(seed) {
  let a = seed >>> 0;
  /** Next number in [0, 1). */
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** Shuffle an array in place and return it. */
    shuffle(list) {
      for (let i = list.length - 1; i > 0; i--) {
        const k = Math.floor(next() * (i + 1));
        [list[i], list[k]] = [list[k], list[i]];
      }
      return list;
    },
    /** One item, chosen with probability proportional to weight(item). */
    weighted(list, weight) {
      const total = list.reduce((sum, item) => sum + weight(item), 0);
      let r = next() * total;
      for (const item of list) {
        r -= weight(item);
        if (r < 0) return item;
      }
      return list[list.length - 1];
    },
  };
}
