// Interval-pattern scanner. Tests every calendar interval and every
// hand-style rule of two families, and compares the real counts with
// thousands of within-season shuffles, so a pattern is only called real if it
// beats what a random ordering of the same seasons produces.
//
//   calendar rules  "the games d1 and d2 days back agree -> repeat"  (d1 <= 63)
//   order rules     "the game is g days after the last one, and the last and
//                    k-th previous games agree -> repeat", for every gap g
//                    (or any gap), k = 2..8, any season or same season only
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

export const ORDER_MAX_GAP = 21;
export const ORDER_MAX_K = 8;
const ORDER_GAPS = ORDER_MAX_GAP + 1; // gap 0 stands for "any gap"
const ORDER_SIZE = 2 * ORDER_GAPS * (ORDER_MAX_K + 1);
const orderId = (same, gap, k) => (same * ORDER_GAPS + gap) * (ORDER_MAX_K + 1) + k;
const decodeOrder = (id) => ({
  gap: Math.floor(id / (ORDER_MAX_K + 1)) % ORDER_GAPS,
  k: id % (ORDER_MAX_K + 1),
  sameSeason: id >= ORDER_GAPS * (ORDER_MAX_K + 1),
});

// [j, gap, sameSeasonMask, prev1..prevK] per game; prev = -1 before the window.
function buildOrderCases(seq, rows, from) {
  const out = [];
  for (const j of rows) {
    if (j < 1 || seq[j - 1].season < from) continue;
    const gap = seq[j].day - seq[j - 1].day;
    let mask = 0;
    const prev = [];
    for (let k = 1; k <= ORDER_MAX_K; k++) {
      const p = j - k >= 0 && seq[j - k].season >= from ? j - k : -1;
      prev.push(p);
      if (p >= 0 && seq[p].season === seq[j].season) mask |= 1 << k;
    }
    out.push(j, gap <= ORDER_MAX_GAP ? gap : 0, mask, ...prev);
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

function countOrder(cases, results) {
  const nAgree = new Int32Array(ORDER_SIZE);
  const hits = new Int32Array(ORDER_SIZE);
  const stride = 3 + ORDER_MAX_K;
  for (let c = 0; c < cases.length; c += stride) {
    const rj = results[cases[c]];
    const last = cases[c + 3];
    if (last < 0 || !isDecided(rj) || !isDecided(results[last])) continue;
    const r1 = results[last];
    const gap = cases[c + 1];
    const mask = cases[c + 2];
    const hit = rj === r1 ? 1 : 0;
    for (let k = 2; k <= ORDER_MAX_K; k++) {
      const pk = cases[c + 2 + k];
      if (pk < 0 || results[pk] !== r1) continue;
      const sameSeason = (mask >> k) & 1;
      for (let s = 0; s <= sameSeason; s++) {
        for (const g of gap ? [0, gap] : [0]) {
          const id = orderId(s, g, k);
          nAgree[id]++;
          hits[id] += hit;
        }
      }
    }
  }
  return { nAgree, hits };
}

const pCache = new Map();
function pTwo(h, n) {
  const key = n * 4096 + h;
  let p = pCache.get(key);
  if (p === undefined) pCache.set(key, (p = binomTwoSided(h, n, 0.5)));
  return p;
}

function scoreRules({ nAgree, hits }, minN) {
  const out = [];
  for (let c = 0; c < nAgree.length; c++) {
    if (nAgree[c] >= minN) out.push({ c, n: nAgree[c], hits: hits[c], p: pTwo(hits[c], nAgree[c]) });
  }
  return out;
}

const minP = (rules) => rules.reduce((m, x) => Math.min(m, x.p), 1);
const isPerfect = (x) => x.hits === 0 || x.hits === x.n;

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

// Tracks one named rule's real record and its record in every shuffle.
function focusTracker(id, real) {
  const nullP = [];
  const nullRate = [];
  return {
    id,
    real: { n: real.nAgree[id], hits: real.hits[id], p: pTwo(real.hits[id], real.nAgree[id]) },
    add(t) {
      if (!t.nAgree[id]) return;
      nullP.push(pTwo(t.hits[id], t.nAgree[id]));
      nullRate.push(t.hits[id] / t.nAgree[id]);
    },
    summary(nullMinFamily, nullMinBoth) {
      const p = this.real.p;
      return {
        ...this.real,
        pPermutation: empiricalP(nullP, (x) => x <= p),
        pFamily: empiricalP(nullMinFamily, (m) => m <= p),
        pBoth: empiricalP(nullMinBoth, (m) => m <= p),
        nullMeanRate: mean(nullRate),
      };
    },
  };
}

export function intervalScan(
  seq,
  {
    from,
    to,
    maxLag = 63,
    maxPairLag = 400,
    maxGap = 30,
    minN = 8,
    nPerm = 2000,
    seed = 1,
    focus = [28, 10],
    orderFocus = { gap: 10, k: 4 },
    pairs = true,
    keepNulls = false,
  } = {},
) {
  const base = seq.map((g) => g.result);
  const rows = windowRows(seq, from, to);
  const stride = maxLag + 1;
  const calSize = stride * stride;
  const trip = buildTriplets(seq, rows, maxLag);
  const orderCases = buildOrderCases(seq, rows, from);
  const pairIdx = pairs ? buildPairs(seq, rows, maxPairLag) : null;
  const consecIdx = pairs ? buildConsecutive(seq, rows, maxGap) : null;

  const realCal = countTriplets(trip, base, calSize);
  const realOrder = countOrder(orderCases, base);
  const calRules = scoreRules(realCal, minN);
  const orderRules = scoreRules(realOrder, minN);
  const calFocus = focusTracker(focus[0] * stride + focus[1], realCal);
  const orderFoci = [false, true].map((same) => focusTracker(orderId(same ? 1 : 0, orderFocus.gap, orderFocus.k), realOrder));

  const nullMinCal = [];
  const nullMinOrder = [];
  const nullMinBoth = [];
  const nullStrong = [];
  const nullPerfect = [];
  const nullPairSame = [];
  const nullPairN = [];
  const nullConsecSame = [];
  const nullConsecN = [];

  for (let k = 0; k < nPerm; k++) {
    const res = shuffleWithinSeason(seq, base, mulberry32(hashSeed('scan', seed, k)));
    const calCounts = countTriplets(trip, res, calSize);
    const orderCounts = countOrder(orderCases, res);
    const cal = scoreRules(calCounts, minN);
    const ord = scoreRules(orderCounts, minN);
    nullMinCal.push(minP(cal));
    nullMinOrder.push(minP(ord));
    nullMinBoth.push(Math.min(minP(cal), minP(ord)));
    nullStrong.push(cal.filter((x) => x.p <= calFocus.real.p).length);
    nullPerfect.push(cal.filter(isPerfect).length);
    calFocus.add(calCounts);
    for (const f of orderFoci) f.add(orderCounts);
    if (pairs) {
      const pc = countPairs(pairIdx, res, maxPairLag + 1);
      nullPairSame.push(pc.same);
      nullPairN.push(pc.n);
      const cc = countPairs(consecIdx, res, maxGap + 1);
      nullConsecSame.push(cc.same);
      nullConsecN.push(cc.n);
    }
  }

  const bothP = (p) => empiricalP(nullMinBoth, (m) => m <= p);
  const combos = calRules
    .map((x) => ({
      d1: Math.floor(x.c / stride),
      d2: x.c % stride,
      n: x.n,
      hits: x.hits,
      rate: x.hits / x.n,
      p: x.p,
      pFamily: empiricalP(nullMinCal, (m) => m <= x.p),
      pBoth: bothP(x.p),
    }))
    .sort((a, b) => a.p - b.p || b.n - a.n);
  const orderList = orderRules
    .map((x) => ({
      ...decodeOrder(x.c),
      n: x.n,
      hits: x.hits,
      rate: x.hits / x.n,
      p: x.p,
      pFamily: empiricalP(nullMinOrder, (m) => m <= x.p),
      pBoth: bothP(x.p),
    }))
    .sort((a, b) => a.p - b.p || b.n - a.n);
  const calFocusSummary = calFocus.summary(nullMinCal, nullMinBoth);
  const strongReal = calRules.filter((x) => x.p <= calFocus.real.p).length;

  const out = {
    window: { from, to, games: rows.length },
    settings: { maxLag, minN, nPerm, maxPairLag, maxGap, orderMaxGap: ORDER_MAX_GAP, orderMaxK: ORDER_MAX_K },
    rulesTested: calRules.length,
    combos,
    focus: {
      d1: focus[0],
      d2: focus[1],
      ...calFocusSummary,
      nEnds: realCal.nEnds[calFocus.id],
      endsSame: realCal.endsSame[calFocus.id],
      rank: combos.findIndex((x) => x.d1 === focus[0] && x.d2 === focus[1]) + 1,
    },
    chance: {
      atLeastAsStrong: {
        real: strongReal,
        nullMean: mean(nullStrong),
        null95: quantile(nullStrong, 0.95),
        shareWithAny: nullStrong.filter((x) => x > 0).length / nPerm,
        pExcess: empiricalP(nullStrong, (x) => x >= strongReal),
      },
      perfect: { real: calRules.filter(isPerfect).length, nullMean: mean(nullPerfect), null95: quantile(nullPerfect, 0.95) },
      bestCombo: combos[0] ?? null,
    },
    order: {
      rulesTested: orderRules.length,
      rules: orderList,
      focus: orderFoci.map((f, s) => ({ ...orderFocus, sameSeason: s === 1, ...f.summary(nullMinOrder, nullMinBoth) })),
      positions: Array.from({ length: ORDER_MAX_K - 1 }, (_, x) => {
        const k = x + 2;
        const pick = (s) => ({ n: realOrder.nAgree[orderId(s, orderFocus.gap, k)], hits: realOrder.hits[orderId(s, orderFocus.gap, k)] });
        return { k, any: pick(0), same: pick(1) };
      }),
    },
    combinedRules: calRules.length + orderRules.length,
  };
  if (keepNulls) {
    // The best (smallest) p-value found in each shuffled history, per search.
    // Ten significant digits keep exact ties (e.g. 8/8 = 0.0078125) intact.
    const keep = (xs) => xs.map((x) => Number(x.toPrecision(10)));
    out.nullMinP = { calendar: keep(nullMinCal), order: keep(nullMinOrder), both: keep(nullMinBoth) };
  }
  if (pairs) {
    out.pairLags = intervalTable(countPairs(pairIdx, base, maxPairLag + 1), nullPairSame, nullPairN, 20);
    out.consecutiveGaps = intervalTable(countPairs(consecIdx, base, maxGap + 1), nullConsecSame, nullConsecN, 5);
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
