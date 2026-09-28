// Lattice families for the lab. build(seq, rows, from) turns one team's
// schedule into fixed cases once; count(cases, results, size) returns per-item
// totals { n, hits } for any results array (real, shuffled or simulated).
//   kind 'same': hits = the game repeated the earlier result
//   kind 'win' : hits = the game was a win
import { isDecided } from '../data.js';
import { ordinal } from '../rules.js';
import { ORDER_SIZE, buildOrderCases, buildTriplets, countOrder, countTriplets, decodeOrder } from '../scan.js';

export const SPECIAL_LAGS = [1380, 1764, 1998, 2160, 2760, 8400];
const MAX_LAG = 400;
export const LAGS = [...Array.from({ length: MAX_LAG }, (_, i) => i + 1), ...SPECIAL_LAGS];
const lagIndex = new Map(LAGS.map((d, i) => [d, i]));

const CAL2_MAX = 63;
const CAL3_MAX = 42;
const S3 = CAL3_MAX + 1;
const ORDER_LAGS = 40;
const MARKOV_MAX = 5;
const MOD_MAX = 60;
const modOffset = (n) => (n * (n - 1)) / 2 - 1; // n = 2 -> 0, 3 -> 2, ...
const WEEKDAY_OF_MOD7 = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed']; // day 0 was a Thursday

// [i, j, item] pairs, counted as "same result".
function countSame(cases, results, size, stride = 3) {
  const n = new Int32Array(size);
  const hits = new Int32Array(size);
  for (let c = 0; c < cases.length; c += stride) {
    const a = results[cases[c]];
    const b = results[cases[c + 1]];
    if (!isDecided(a) || !isDecided(b)) continue;
    n[cases[c + 2]]++;
    if (a === b) hits[cases[c + 2]]++;
  }
  return { n, hits };
}

export const FAMILIES = {
  calLag: {
    label: 'Same result exactly d days apart',
    short: 'Day lags (1-400, numerology)',
    kind: 'same',
    size: () => LAGS.length,
    build(seq, rows) {
      const out = [];
      const byDay = new Map(rows.map((i) => [seq[i].day, i]));
      for (let a = 0; a < rows.length; a++) {
        const j = rows[a];
        for (let b = a - 1; b >= 0; b--) {
          const d = seq[j].day - seq[rows[b]].day;
          if (d > MAX_LAG) break;
          out.push(rows[b], j, d - 1);
        }
        for (const L of SPECIAL_LAGS) {
          const i = byDay.get(seq[j].day - L);
          if (i !== undefined) out.push(i, j, lagIndex.get(L));
        }
      }
      return Int32Array.from(out);
    },
    count: (cases, results, size) => countSame(cases, results, size),
    describe: (id) => `${LAGS[id]} days apart`,
  },

  cal2: {
    label: 'Two-lookback calendar rules (games d1 and d2 days back agree)',
    short: 'Two-lookback rules',
    kind: 'same',
    size: () => (CAL2_MAX + 1) ** 2,
    build: (seq, rows) => buildTriplets(seq, rows, CAL2_MAX),
    count(cases, results, size) {
      const t = countTriplets(cases, results, size);
      return { n: t.nAgree, hits: t.hits };
    },
    describe: (id) => `${Math.floor(id / (CAL2_MAX + 1))} & ${id % (CAL2_MAX + 1)} days`,
  },

  cal3: {
    label: 'Three-lookback calendar rules (games d1, d2 and d3 days back agree)',
    short: 'Three-lookback rules',
    kind: 'same',
    dense: { stride: 5, idAt: 4 }, // raw ids are sparse; the engine remaps them
    build(seq, rows) {
      const out = [];
      for (let c = 0; c < rows.length; c++) {
        const j = rows[c];
        const back = [];
        for (let b = c - 1; b >= 0 && seq[j].day - seq[rows[b]].day <= CAL3_MAX; b--) back.push(rows[b]);
        for (let x = 0; x < back.length; x++) {
          for (let y = x + 1; y < back.length; y++) {
            for (let z = y + 1; z < back.length; z++) {
              const [m, k, i] = [back[x], back[y], back[z]];
              const id = ((seq[j].day - seq[i].day) * S3 + (seq[j].day - seq[k].day)) * S3 + (seq[j].day - seq[m].day);
              out.push(i, k, m, j, id);
            }
          }
        }
      }
      return Int32Array.from(out);
    },
    count(cases, results, size) {
      const n = new Int32Array(size);
      const hits = new Int32Array(size);
      for (let c = 0; c < cases.length; c += 5) {
        const ri = results[cases[c]];
        if (!isDecided(ri) || results[cases[c + 1]] !== ri || results[cases[c + 2]] !== ri) continue;
        const rj = results[cases[c + 3]];
        if (!isDecided(rj)) continue;
        n[cases[c + 4]]++;
        if (rj === ri) hits[cases[c + 4]]++;
      }
      return { n, hits };
    },
    describe: (id) => `${Math.floor(id / (S3 * S3))}, ${Math.floor(id / S3) % S3} & ${id % S3} days`,
  },

  order: {
    label: 'Gap + k-th previous rules (the 10-day type)',
    short: 'Gap + k-th previous',
    kind: 'same',
    size: () => ORDER_SIZE,
    build: (seq, rows, from) => buildOrderCases(seq, rows, from),
    count(cases, results) {
      const t = countOrder(cases, results);
      return { n: t.nAgree, hits: t.hits };
    },
    describe(id) {
      const r = decodeOrder(id);
      return `${r.gap ? `${r.gap}-day gap` : 'any gap'}, ${ordinal(r.k)} previous${r.sameSeason ? ', same season' : ''}`;
    },
  },

  orderLag: {
    label: 'Same result k games apart (autocorrelation)',
    short: 'Game-order lags',
    kind: 'same',
    size: () => ORDER_LAGS,
    build(seq, rows) {
      const out = [];
      for (let a = 0; a < rows.length; a++) {
        for (let k = 1; k <= ORDER_LAGS && a - k >= 0; k++) out.push(rows[a - k], rows[a], k - 1);
      }
      return Int32Array.from(out);
    },
    count: (cases, results, size) => countSame(cases, results, size),
    describe: (id) => `${id + 1} game${id ? 's' : ''} apart`,
  },

  markov: {
    label: 'Streak patterns: last 1-5 results -> next result',
    short: 'Streak patterns (Markov)',
    kind: 'win',
    size: () => (1 << (MARKOV_MAX + 1)) - 2,
    build(seq, rows) {
      const out = [];
      for (let a = 0; a < rows.length; a++) {
        out.push(rows[a]);
        for (let m = 1; m <= MARKOV_MAX; m++) out.push(a - m >= 0 ? rows[a - m] : -1);
      }
      return Int32Array.from(out);
    },
    count(cases, results, size) {
      const n = new Int32Array(size);
      const hits = new Int32Array(size);
      const stride = MARKOV_MAX + 1;
      for (let c = 0; c < cases.length; c += stride) {
        const rj = results[cases[c]];
        if (!isDecided(rj)) continue;
        let bits = 0;
        for (let m = 1; m <= MARKOV_MAX; m++) {
          const p = cases[c + m];
          if (p < 0 || !isDecided(results[p])) break;
          if (results[p] === 1) bits |= 1 << (m - 1);
          const id = (1 << m) - 2 + bits;
          n[id]++;
          if (rj === 1) hits[id]++;
        }
      }
      return { n, hits };
    },
    describe(id) {
      let m = 1;
      while ((1 << (m + 1)) - 2 <= id) m++;
      const bits = id - ((1 << m) - 2);
      const seqStr = Array.from({ length: m }, (_, t) => ((bits >> (m - 1 - t)) & 1 ? 'W' : 'L')).join('-');
      return `after ${seqStr}`;
    },
  },

  modular: {
    label: 'Phase lattices: win rate by day number mod n (n = 2-60)',
    short: 'Phase (day mod n)',
    kind: 'win',
    pool: false, // pooled over teams every game counts once as a win and once as a loss
    size: () => modOffset(MOD_MAX + 1),
    build(seq, rows) {
      const out = [];
      for (const j of rows) {
        for (let n = 2; n <= MOD_MAX; n++) out.push(j, modOffset(n) + (((seq[j].day % n) + n) % n));
      }
      return Int32Array.from(out);
    },
    count(cases, results, size) {
      const n = new Int32Array(size);
      const hits = new Int32Array(size);
      for (let c = 0; c < cases.length; c += 2) {
        const r = results[cases[c]];
        if (!isDecided(r)) continue;
        n[cases[c + 1]]++;
        if (r === 1) hits[cases[c + 1]]++;
      }
      return { n, hits };
    },
    describe(id) {
      let n = 2;
      while (modOffset(n + 1) <= id) n++;
      const a = id - modOffset(n);
      return n === 7 ? `${WEEKDAY_OF_MOD7[a]} games (day mod 7)` : `day number ≡ ${a} (mod ${n})`;
    },
  },
};

// The intervals named in the hand analysis, reported individually.
export const NAMED_LAGS = [3, 4, 7, 10, 11, 14, 18, 21, 23, 27, 28, 161, 184, ...SPECIAL_LAGS];
export const lagItem = (d) => lagIndex.get(d);
