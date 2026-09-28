// Interval-pattern scanner. Tests every calendar interval (and every
// two-lookback "if the games d1 and d2 days back agree, repeat it" rule) and
// compares the real counts against thousands of within-season shuffles, so a
// pattern is only called real if it beats what random ordering produces.
import { isDecided } from './data.js';
import { hashSeed, mulberry32, shuffleWithinSeason } from './rng.js';
import { benjaminiHochberg, binomTwoSided, empiricalP, mean, quantile } from './stats.js';

export const windowRows = (seq, from, to) =>
  seq.flatMap((g, i) => (g.season >= from && g.season <= to ? [i] : []));

// [i, j, lag] for every pair of games at most maxLag days apart.
function buildPairs(seq, rows, maxLag) {
  const out = [];
  for (let a = 0; a < rows.length; a++) {
    for (let b = a + 1; b < rows.length; b++) {
      const lag = seq[rows[b]].day - seq[rows[a]].day;
      if (lag > maxLag) break;
      out.push(rows[a], rows[b], lag);
    }
  }
  return Int32Array.from(out);
}

// [i, j, gap] for back-to-back games.
function buildConsecutive(seq, rows, maxGap) {
  const out = [];
  for (let a = 1; a < rows.length; a++) {
    const gap = seq[rows[a]].day - seq[rows[a - 1]].day;
    if (rows[a] === rows[a - 1] + 1 && gap <= maxGap) out.push(rows[a - 1], rows[a], gap);
  }
  return Int32Array.from(out);
}

// [i, k, j, combo] for every game j and every two earlier games i < k within
// maxLag days; combo encodes (d1 = j - i, d2 = j - k) in days.
function buildTriplets(seq, rows, maxLag) {
  const out = [];
  const stride = maxLag + 1;
  for (let c = 0; c < rows.length; c++) {
    const j = rows[c];
    const back = [];
    for (let b = c - 1; b >= 0 && seq[j].day - seq[rows[b]].day <= maxLag; b--) back.push(rows[b]);
    for (let x = 0; x < back.length; x++) {
      for (let z = x + 1; z < back.length; z++) {
        const k = back[x];
        const i = back[z];
        out.push(i, k, j, (seq[j].day - seq[i].day) * stride + (seq[j].day - seq[k].day));
      }
    }
  }
  return Int32Array.from(out);
}

function countPairs(pairs, results, size) {
  const n = new Int32Array(size);
  const same = new Int32Array(size);
  for (let p = 0; p < pairs.length; p += 3) {
    const a = results[pairs[p]];
    const b = results[pairs[p + 1]];
    if (!isDecided(a) || !isDecided(b)) continue;
    n[pairs[p + 2]]++;
    if (a === b) same[pairs[p + 2]]++;
  }
  return { n, same };
}

// nAgree/hits: the rule fires when games i and k agree; a hit if j matches.
// nEnds/endsSame: i and j compared whenever a game k sits between them.
function countTriplets(trip, results, size) {
  const nAgree = new Int32Array(size);
  const hits = new Int32Array(size);
  const nEnds = new Int32Array(size);
  const endsSame = new Int32Array(size);
  for (let t = 0; t < trip.length; t += 4) {
    const ri = results[trip[t]];
    const rj = results[trip[t + 2]];
    if (!isDecided(ri) || !isDecided(rj)) continue;
    const c = trip[t + 3];
    nEnds[c]++;
    if (ri === rj) endsSame[c]++;
    if (results[trip[t + 1]] !== ri) continue;
    nAgree[c]++;
    if (rj === ri) hits[c]++;
  }
  return { nAgree, hits, nEnds, endsSame };
}

const pCache = new Map();
function pTwo(h, n) {
  const key = n * 4096 + h;
  let p = pCache.get(key);
  if (p === undefined) pCache.set(key, (p = binomTwoSided(h, n, 0.5)));
  return p;
}

// Per-interval same-result rates vs. the shuffled null, BH-corrected.
function intervalTable(real, nullSame, nullN, minN) {
  const rows = [];
  for (let d = 1; d < real.n.length; d++) {
    if (real.n[d] < minN) continue;
    const rate = real.same[d] / real.n[d];
    const nullRates = nullSame.map((s, k) => (nullN[k][d] ? s[d] / nullN[k][d] : NaN)).filter((x) => !Number.isNaN(x));
    const center = mean(nullRates);
    const p = empiricalP(nullRates, (x) => Math.abs(x - center) >= Math.abs(rate - center) - 1e-12);
    rows.push({ days: d, n: real.n[d], same: real.same[d], rate, nullRate: center, p });
  }
  const q = benjaminiHochberg(rows.map((r) => r.p));
  rows.forEach((r, k) => (r.q = q[k]));
  return rows;
}

export function intervalScan(
  seq,
  { from, to, maxLag = 63, maxPairLag = 400, maxGap = 30, minN = 8, nPerm = 2000, seed = 1, focus = [28, 10], pairs = true } = {},
) {
  const base = seq.map((g) => g.result);
  const rows = windowRows(seq, from, to);
  const stride = maxLag + 1;
  const trip = buildTriplets(seq, rows, maxLag);
  const pairIdx = pairs ? buildPairs(seq, rows, maxPairLag) : null;
  const consecIdx = pairs ? buildConsecutive(seq, rows, maxGap) : null;
  const focusId = focus[0] * stride + focus[1];

  const scoreCombos = (t) => {
    const out = [];
    for (let c = 0; c < t.nAgree.length; c++) {
      if (t.nAgree[c] >= minN) out.push({ c, n: t.nAgree[c], hits: t.hits[c], p: pTwo(t.hits[c], t.nAgree[c]) });
    }
    return out;
  };

  const realTrip = countTriplets(trip, base, stride * stride);
  const realCombos = scoreCombos(realTrip);
  const focusReal = {
    d1: focus[0],
    d2: focus[1],
    n: realTrip.nAgree[focusId],
    hits: realTrip.hits[focusId],
    nEnds: realTrip.nEnds[focusId],
    endsSame: realTrip.endsSame[focusId],
  };
  focusReal.p = pTwo(focusReal.hits, focusReal.n);

  const nullMinP = [];
  const nullStrong = [];
  const nullPerfect = [];
  const nullFocusP = [];
  const nullFocusRate = [];
  const nullPairSame = [];
  const nullPairN = [];
  const nullConsecSame = [];
  const nullConsecN = [];
  const isPerfect = (x) => x.hits === 0 || x.hits === x.n;

  for (let k = 0; k < nPerm; k++) {
    const res = shuffleWithinSeason(seq, base, mulberry32(hashSeed('scan', seed, k)));
    const t = countTriplets(trip, res, stride * stride);
    const combos = scoreCombos(t);
    nullMinP.push(combos.length ? Math.min(...combos.map((x) => x.p)) : 1);
    nullStrong.push(combos.filter((x) => x.p <= focusReal.p).length);
    nullPerfect.push(combos.filter(isPerfect).length);
    if (t.nAgree[focusId]) {
      nullFocusP.push(pTwo(t.hits[focusId], t.nAgree[focusId]));
      nullFocusRate.push(t.hits[focusId] / t.nAgree[focusId]);
    }
    if (pairs) {
      const pc = countPairs(pairIdx, res, maxPairLag + 1);
      nullPairSame.push(pc.same);
      nullPairN.push(pc.n);
      const cc = countPairs(consecIdx, res, maxGap + 1);
      nullConsecSame.push(cc.same);
      nullConsecN.push(cc.n);
    }
  }

  const decode = (c) => ({ d1: Math.floor(c / stride), d2: c % stride });
  const combos = realCombos
    .map((x) => ({ ...decode(x.c), n: x.n, hits: x.hits, rate: x.hits / x.n, p: x.p, pFamily: empiricalP(nullMinP, (m) => m <= x.p) }))
    .sort((a, b) => a.p - b.p || b.n - a.n);

  const out = {
    window: { from, to, games: rows.length },
    settings: { maxLag, minN, nPerm, maxPairLag, maxGap },
    rulesTested: realCombos.length,
    combos,
    focus: {
      ...focusReal,
      rank: combos.findIndex((x) => x.d1 === focus[0] && x.d2 === focus[1]) + 1,
      pPermutation: empiricalP(nullFocusP, (p) => p <= focusReal.p),
      pFamily: empiricalP(nullMinP, (m) => m <= focusReal.p),
      nullMeanRate: mean(nullFocusRate),
    },
    chance: {
      atLeastAsStrong: (() => {
        const real = realCombos.filter((x) => x.p <= focusReal.p).length;
        return {
          real,
          nullMean: mean(nullStrong),
          null95: quantile(nullStrong, 0.95),
          shareWithAny: nullStrong.filter((x) => x > 0).length / nPerm,
          pExcess: empiricalP(nullStrong, (x) => x >= real),
        };
      })(),
      perfect: {
        real: realCombos.filter(isPerfect).length,
        nullMean: mean(nullPerfect),
        null95: quantile(nullPerfect, 0.95),
      },
      bestCombo: combos[0] ?? null,
    },
  };
  if (pairs) {
    out.pairLags = intervalTable(countPairs(pairIdx, base, maxPairLag + 1), nullPairSame, nullPairN, 20);
    out.consecutiveGaps = intervalTable(countPairs(consecIdx, base, maxGap + 1), nullConsecSame, nullConsecN, 5);
  }
  return out;
}

// Every game with a game exactly d1 and d2 days before it (both played).
export function lookbackCases(seq, { from, to, d1 = 28, d2 = 10, results = seq.map((g) => g.result) }) {
  const byDay = new Map(seq.map((g, i) => [g.day, i]));
  const out = [];
  for (const j of windowRows(seq, from, to)) {
    const i = byDay.get(seq[j].day - d1);
    const k = byDay.get(seq[j].day - d2);
    if (i === undefined || k === undefined) continue;
    const agree = isDecided(results[i]) && results[i] === results[k];
    out.push({
      game: j,
      first: i,
      middle: k,
      agree,
      call: agree ? results[i] : null,
      hit: agree && isDecided(results[j]) ? results[j] === results[i] : null,
    });
  }
  return out;
}

// How the NFL calendar produces the "3, 4, 7, 10, 11, 14" gaps.
export function gapStructure(seq, { from, to, maxGap = 21 }) {
  const counts = new Map();
  const rows = windowRows(seq, from, to);
  for (let a = 1; a < rows.length; a++) {
    const i = rows[a - 1];
    const j = rows[a];
    const gap = seq[j].day - seq[i].day;
    if (j !== i + 1 || gap > maxGap) continue;
    const key = `${gap}|${seq[i].weekday} -> ${seq[j].weekday}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byGap = new Map();
  for (const [key, n] of counts) {
    const [gap, move] = key.split('|');
    const e = byGap.get(+gap) ?? { gap: +gap, n: 0, moves: [] };
    e.n += n;
    e.moves.push({ move, n });
    byGap.set(+gap, e);
  }
  return [...byGap.values()]
    .map((e) => ({ ...e, moves: e.moves.sort((a, b) => b.n - a.n) }))
    .sort((a, b) => a.gap - b.gap);
}
