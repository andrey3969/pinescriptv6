// Seeded PRNG (mulberry32) so every run, shuffle and network init is reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a over the stringified parts: a stable seed for ("perm", 17) etc.
export function hashSeed(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Null model used throughout: keep every season's schedule and its W/L/T
// totals, but deal the results out in a random order within the season.
// Anything that survives this shuffle is just "good seasons have more wins".
export function shuffleWithinSeason(seq, results, rand) {
  const out = results.slice();
  const bySeason = new Map();
  seq.forEach((g, i) => {
    if (results[i] === null) return;
    if (!bySeason.has(g.season)) bySeason.set(g.season, []);
    bySeason.get(g.season).push(i);
  });
  for (const idx of bySeason.values()) {
    const vals = shuffleInPlace(idx.map((i) => results[i]), rand);
    idx.forEach((i, k) => (out[i] = vals[k]));
  }
  return out;
}
