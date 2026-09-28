// The lattice lab's test engine. Every family is counted on every team for
// the real results and for null histories (see nullGenerators).
// Pass 1 learns each item's null mean and spread from one set of null
// histories; pass 2 standardises every item to a z-score, for the real history
// and a fresh set of null histories alike, and collects family-wise statistics:
//   max      the most extreme item (a family-wise p-value, like the scans)
//   strong   how many items reach |z| >= 3
//   meanZ2   average z^2 -- many small effects instead of one big one
//   split    items picked on 1999-2012 and scored on 2013-2025
// Scopes: each team on its own, and all 32 teams pooled.
import { fitMarket } from '../crossteam.js';
import { allTeams, teamSchedule } from '../data.js';
import { hashSeed, mulberry32, shuffleWithinSeason } from '../rng.js';
import { windowRows } from '../scan.js';
import { FAMILIES } from './families.js';
import { VALUE_FAMILIES } from './spectral.js';

export const ALL_FAMILIES = { ...FAMILIES, ...VALUE_FAMILIES };
export const WINDOWS = ['full', 'disc', 'valid'];
export const NULLS = ['shuffle', 'spread'];
// Pass 1 learns the null moments from histories numbered from here, so the
// histories scored in pass 2 are independent of them, as the real one is.
export const MOMENT_OFFSET = 1_000_000;
export const LAB_DEFAULTS = { from: 1999, to: 2025, discTo: 2012, minN: 8, reps: 1000, strongZ: 3, top: 10 };

export function prepare(games, opts = {}) {
  const o = { ...LAB_DEFAULTS, ...opts };
  const teams = o.teams ?? allTeams(games);
  const market = fitMarket(games);
  const schedules = teams.map((team) => teamSchedule(games, team));
  const bounds = { full: [o.from, o.to], disc: [o.from, o.discTo], valid: [o.discTo + 1, o.to] };
  const fams = (o.families ?? Object.keys(ALL_FAMILIES)).map((key) => {
    const def = ALL_FAMILIES[key];
    const cases = WINDOWS.map((w) => schedules.map((seq) => def.build(seq, windowRows(seq, ...bounds[w]), bounds[w][0])));
    let size = def.size?.();
    let rawIds = null;
    if (def.dense) {
      // Sparse raw ids (e.g. three day lags) -> 0..size-1 over every team and window.
      const { stride, idAt } = def.dense;
      const ids = new Set();
      for (const byTeam of cases) for (const c of byTeam) for (let x = idAt; x < c.length; x += stride) ids.add(c[x]);
      rawIds = Int32Array.from([...ids].sort((a, b) => a - b));
      const index = new Map(Array.from(rawIds, (id, k) => [id, k]));
      for (const byTeam of cases) for (const c of byTeam) for (let x = idAt; x < c.length; x += stride) c[x] = index.get(c[x]);
      size = rawIds.length;
    }
    return {
      key,
      def,
      cases,
      size,
      rawIds,
      value: def.type === 'value',
      pooled: def.pool !== false,
      sided: def.sided ?? 'two',
      describe: (id) => def.describe(rawIds ? rawIds[id] : id),
    };
  });
  const ctx = { o, teams, schedules, market, bounds, fams, T: teams.length };
  if (o.plant) plantLattice(ctx, o.plant);
  return ctx;
}

// Power check: replace the real results with a null history in which a
// lattice of known strength has been planted, so the engine can be asked
// whether it finds it. With probability q, a game that meets the rule's
// condition is set to follow the rule (ties are left alone).
//   { rule: { type: 'lag', d } }                 same result as the game d days back
//   { rule: { type: 'order', gap, k } }          gap-day game, last and k-th previous agree
//   { rule: { type: 'calendar', d1, d2 } }       games d1 and d2 days back agree
export function plantLattice(ctx, { rule, q, teams = null, baseKind = 'spread', baseRep = 8_000_000, seed = 1 }) {
  const res = nullGenerators(ctx)[baseKind](baseRep);
  const rand = mulberry32(hashSeed('plant', seed));
  const [from, to] = ctx.bounds.full;
  const decided = (r) => r === 1 || r === -1;
  ctx.schedules.forEach((seq, t) => {
    const r = res[t];
    if (!teams || teams.includes(ctx.teams[t])) {
      const byDay = new Map(seq.map((g, i) => [g.day, i]));
      for (let j = 0; j < seq.length; j++) {
        if (seq[j].season < from || seq[j].season > to || !decided(r[j])) continue;
        let target = null;
        if (rule.type === 'lag') {
          const i = byDay.get(seq[j].day - rule.d);
          if (i !== undefined && decided(r[i])) target = r[i];
        } else if (rule.type === 'order') {
          if (j >= rule.k && seq[j].day - seq[j - 1].day === rule.gap && decided(r[j - 1]) && r[j - 1] === r[j - rule.k]) target = r[j - 1];
        } else if (rule.type === 'calendar') {
          const a = byDay.get(seq[j].day - rule.d1);
          const b = byDay.get(seq[j].day - rule.d2);
          if (a !== undefined && b !== undefined && decided(r[a]) && r[a] === r[b]) target = r[a];
        }
        if (target !== null && rand() < q) r[j] = target;
      }
    }
    seq.forEach((g, i) => (g.result = r[i]));
  });
}

// Result histories: the real one, and null replicate `rep` of each kind.
// The first two keep every team's exact record in every season:
//   shuffle  the season's results dealt out in random order
//   spread   the same wins dealt out again, but each game's chance of being
//            one of them follows the point spread (odds p/(1-p), p from the
//            spread): favored games take the wins more often. This keeps who
//            played whom and where, which a plain shuffle ignores. The odds
//            are exp(b * spread) with b fitted by conditional logit, i.e. on
//            how wins fall within team-seasons, not between them.
//   market   every game re-played from the spread alone; records drift, so
//            it tests the market, not the order (not used by default)
export const NULL_LABELS = {
  shuffle: 'Shuffled seasons',
  spread: 'Spread-weighted shuffle',
  market: 'Point spread only',
};

// Elementary symmetric sum e_W of exp(b * s_j): the total weight of all ways
// to place W wins among the games.
function logSymmetric(s, W, b) {
  const e = new Float64Array(W + 1);
  e[0] = 1;
  for (let j = 0; j < s.length; j++) {
    const w = Math.exp(b * s[j]);
    for (let k = Math.min(W, j + 1); k >= 1; k--) e[k] += w * e[k - 1];
  }
  return Math.log(e[W]);
}

// Conditional-logit slope: how strongly the spread decides which of a
// team-season's games are its wins, given how many it won.
export function withinSeasonSlope(blocks) {
  const ll = (b) => blocks.reduce((sum, { s, y, W }) => sum + b * s.reduce((a, x, j) => a + (y[j] ? x : 0), 0) - logSymmetric(s, W, b), 0);
  let lo = 0;
  let hi = 0.5;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 60; it++) {
    const m1 = hi - g * (hi - lo);
    const m2 = lo + g * (hi - lo);
    if (ll(m1) < ll(m2)) lo = m1;
    else hi = m2;
  }
  return (lo + hi) / 2;
}

export function nullGenerators(ctx) {
  const base = ctx.schedules.map((seq) => seq.map((g) => g.result));

  // Conditional-Bernoulli blocks, one per team-season: R[j][k] = sum over
  // k-subsets of games j..m-1 of the product of their odds (suffix sums).
  const blocks = [];
  ctx.schedules.forEach((seq, t) => {
    const bySeason = new Map();
    seq.forEach((g, i) => {
      if (g.result !== 1 && g.result !== -1) return; // ties and unplayed games stay put
      if (!bySeason.has(g.season)) bySeason.set(g.season, []);
      bySeason.get(g.season).push(i);
    });
    for (const idx of bySeason.values()) {
      blocks.push({
        t,
        idx: Int32Array.from(idx),
        s: idx.map((i) => seq[i].spread ?? 0),
        y: idx.map((i) => base[t][i] === 1),
        W: idx.filter((i) => base[t][i] === 1).length,
      });
    }
  });
  const bWithin = withinSeasonSlope(blocks);
  for (const block of blocks) {
    const { idx, W } = block;
    const m = idx.length;
    const odds = Float64Array.from(block.s, (x) => Math.exp(bWithin * x));
    const K = W + 1;
    const R = new Float64Array((m + 1) * K);
    R[m * K] = 1;
    for (let j = m - 1; j >= 0; j--) {
      for (let k = 0; k <= W; k++) R[j * K + k] = R[(j + 1) * K + k] + (k ? odds[j] * R[(j + 1) * K + k - 1] : 0);
    }
    Object.assign(block, { odds, R });
  }

  const games = new Map();
  ctx.schedules.forEach((seq, t) =>
    seq.forEach((g, i) => {
      if (g.result === null) return;
      let e = games.get(g.gameId);
      if (!e) games.set(g.gameId, (e = { tie: g.result === 0, p: 0.5, refs: [] }));
      // The spread is quoted for the designated home team, neutral sites included.
      if (g.designatedHome) e.p = ctx.market.prob(g.spread);
      e.refs.push(t, i, g.designatedHome ? 1 : 0);
    }),
  );
  const list = [...games.values()];

  return {
    bWithin,
    real: () => base,
    shuffle: (rep) =>
      ctx.schedules.map((seq, t) => shuffleWithinSeason(seq, base[t], mulberry32(hashSeed('lab-shuffle', rep, t)))),
    spread(rep) {
      const rand = mulberry32(hashSeed('lab-spread', rep));
      const out = base.map((r) => r.slice());
      for (const { t, idx, odds, W, R } of blocks) {
        const K = W + 1;
        let k = W;
        for (let j = 0; j < idx.length; j++) {
          const win = k > 0 && rand() * R[j * K + k] < odds[j] * R[(j + 1) * K + k - 1];
          out[t][idx[j]] = win ? 1 : -1;
          if (win) k--;
        }
      }
      return out;
    },
    market(rep) {
      const rand = mulberry32(hashSeed('lab-market', rep));
      const out = base.map((r) => r.slice());
      for (const e of list) {
        const u = rand();
        if (e.tie) continue;
        const homeWin = u < e.p;
        for (let q = 0; q < e.refs.length; q += 3) out[e.refs[q]][e.refs[q + 1]] = homeWin === (e.refs[q + 2] === 1) ? 1 : -1;
      }
      return out;
    },
  };
}

// counts[f][w][t]: { n, hits } for count families, Float64Array for value families.
export const countAll = (ctx, results) =>
  ctx.fams.map((fam) =>
    fam.cases.map((byTeam) =>
      byTeam.map((c, t) => (fam.value ? fam.def.value(c, results[t]) : fam.def.count(c, results[t], fam.size))),
    ),
  );

// ---- pass 1: null moments --------------------------------------------------
// count items: a = sum h^2/n, b = sum h, c = sum n  -> rate mu = b/c and the
//   per-game variance around it, so z = (h - n mu) / sqrt(n * v)
// value items: a = sum v, b = sum v^2
export function newMoments(ctx) {
  const N = ctx.T + 1;
  return ctx.fams.map((fam) =>
    WINDOWS.map(() => ({
      a: new Float64Array(N * fam.size),
      b: new Float64Array(N * fam.size),
      c: new Float64Array(N * fam.size),
      r: new Float64Array(N * fam.size),
    })),
  );
}

export function addMoments(ctx, mom, counts) {
  const T = ctx.T;
  ctx.fams.forEach((fam, f) => {
    const S = fam.size;
    WINDOWS.forEach((_, w) => {
      const { a, b, c, r } = mom[f][w];
      const byTeam = counts[f][w];
      if (fam.value) {
        const pool = new Float64Array(S);
        for (let t = 0; t < T; t++) {
          const v = byTeam[t];
          for (let i = 0; i < S; i++) {
            const k = t * S + i;
            a[k] += v[i];
            b[k] += v[i] * v[i];
            r[k]++;
            pool[i] += v[i] / T;
          }
        }
        if (!fam.pooled) return;
        for (let i = 0; i < S; i++) {
          const k = T * S + i;
          a[k] += pool[i];
          b[k] += pool[i] * pool[i];
          r[k]++;
        }
        return;
      }
      const pn = new Float64Array(S);
      const ph = new Float64Array(S);
      const add = (k, n, h) => {
        a[k] += (h * h) / n;
        b[k] += h;
        c[k] += n;
        r[k]++;
      };
      for (let t = 0; t < T; t++) {
        const { n, hits } = byTeam[t];
        for (let i = 0; i < S; i++) {
          if (!n[i]) continue;
          add(t * S + i, n[i], hits[i]);
          pn[i] += n[i];
          ph[i] += hits[i];
        }
      }
      if (fam.pooled) for (let i = 0; i < S; i++) if (pn[i]) add(T * S + i, pn[i], ph[i]);
    });
  });
}

export function mergeMoments(into, from) {
  into.forEach((byWindow, f) =>
    byWindow.forEach((m, w) => {
      for (const key of ['a', 'b', 'c', 'r']) {
        const src = from[f][w][key];
        const dst = m[key];
        for (let k = 0; k < dst.length; k++) dst[k] += src[k];
      }
    }),
  );
  return into;
}

// Moments -> { mu, sc } per item (NaN = not testable: too few null histories
// with data, or no variation at all).
export function standardizers(ctx, mom, reps) {
  return ctx.fams.map((fam, f) =>
    WINDOWS.map((_, w) => {
      const { a, b, c, r } = mom[f][w];
      const mu = new Float64Array(a.length).fill(NaN);
      const sc = new Float64Array(a.length).fill(NaN);
      for (let k = 0; k < a.length; k++) {
        if (r[k] < reps / 2) continue;
        if (fam.value) {
          const m = a[k] / r[k];
          const sd = Math.sqrt(Math.max(0, b[k] / r[k] - m * m));
          if (sd > 1e-12) {
            mu[k] = m;
            sc[k] = sd;
          }
        } else {
          const m = b[k] / c[k];
          const v = (a[k] - 2 * m * b[k] + m * m * c[k]) / r[k];
          if (m > 0 && m < 1 && v > 1e-9) {
            mu[k] = m;
            sc[k] = v;
          }
        }
      }
      return { mu, sc };
    }),
  );
}

// ---- pass 2: z-scores and family statistics ----------------------------------
export function newZBuffers(ctx) {
  return ctx.fams.map((fam) => WINDOWS.map(() => new Float64Array((ctx.T + 1) * fam.size)));
}

// z[w][scope * S + i]; NaN where the item is untestable or has n < minN.
export function fillZ(ctx, std, counts, zbuf) {
  const { T } = ctx;
  const { minN } = ctx.o;
  ctx.fams.forEach((fam, f) => {
    const S = fam.size;
    WINDOWS.forEach((_, w) => {
      const out = zbuf[f][w].fill(NaN);
      const { mu, sc } = std[f][w];
      const byTeam = counts[f][w];
      if (fam.value) {
        const pool = new Float64Array(S);
        for (let t = 0; t < T; t++) {
          const v = byTeam[t];
          for (let i = 0; i < S; i++) {
            const k = t * S + i;
            pool[i] += v[i] / T;
            if (!Number.isNaN(mu[k])) out[k] = (v[i] - mu[k]) / sc[k];
          }
        }
        if (fam.pooled) {
          for (let i = 0; i < S; i++) {
            const k = T * S + i;
            if (!Number.isNaN(mu[k])) out[k] = (pool[i] - mu[k]) / sc[k];
          }
        }
        return;
      }
      const pn = new Float64Array(S);
      const ph = new Float64Array(S);
      for (let t = 0; t < T; t++) {
        const { n, hits } = byTeam[t];
        for (let i = 0; i < S; i++) {
          pn[i] += n[i];
          ph[i] += hits[i];
          const k = t * S + i;
          if (n[i] >= minN && !Number.isNaN(mu[k])) out[k] = (hits[i] - n[i] * mu[k]) / Math.sqrt(n[i] * sc[k]);
        }
      }
      if (fam.pooled) {
        for (let i = 0; i < S; i++) {
          const k = T * S + i;
          if (pn[i] >= minN && !Number.isNaN(mu[k])) out[k] = (ph[i] - pn[i] * mu[k]) / Math.sqrt(pn[i] * sc[k]);
        }
      }
    });
  });
}

// Signed strength of an item: |z| for two-sided families, z (or -z) for one-sided.
export const strength = (sided, z) => (sided === 'two' ? Math.abs(z) : sided === 'upper' ? z : -z);
const direction = (sided, z) => (sided === 'two' ? Math.sign(z) : sided === 'upper' ? 1 : -1);

// Family statistics for one scope (a team, or pooled = index T).
export function scopeStats(fam, zbufF, s, strongZ, topK) {
  const S = fam.size;
  const [zf, zd, zv] = zbufF;
  const off = s * S;
  let e = 0;
  let maxS = -Infinity;
  let arg = -1;
  let strong = 0;
  let sumZ2 = 0;
  // Top items on the discovery half, scored on the validation half.
  const topIdx = [];
  const topVal = [];
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let nc = 0;
  for (let i = 0; i < S; i++) {
    const z = zf[off + i];
    if (!Number.isNaN(z)) {
      e++;
      sumZ2 += z * z;
      const st = strength(fam.sided, z);
      if (st > maxS) {
        maxS = st;
        arg = i;
      }
      if (st >= strongZ) strong++;
    }
    const d = zd[off + i];
    if (Number.isNaN(d)) continue;
    const sd = strength(fam.sided, d);
    if (topIdx.length < topK || sd > topVal[topVal.length - 1]) {
      let p = topIdx.length < topK ? topIdx.length : topK - 1;
      while (p > 0 && topVal[p - 1] < sd) {
        topIdx[p] = topIdx[p - 1];
        topVal[p] = topVal[p - 1];
        p--;
      }
      topIdx[p] = i;
      topVal[p] = sd;
    }
    const v = zv[off + i];
    if (Number.isNaN(v)) continue;
    nc++;
    sx += d;
    sy += v;
    sxx += d * d;
    syy += v * v;
    sxy += d * v;
  }
  const held = (i) => {
    const v = zv[off + i];
    return Number.isNaN(v) ? NaN : direction(fam.sided, zd[off + i]) * v;
  };
  const top1 = topIdx.length ? held(topIdx[0]) : NaN;
  let tsum = 0;
  let tn = 0;
  for (const i of topIdx) {
    const h = held(i);
    if (!Number.isNaN(h)) {
      tsum += h;
      tn++;
    }
  }
  const cov = nc > 2 ? sxy / nc - (sx / nc) * (sy / nc) : NaN;
  const vx = nc > 2 ? sxx / nc - (sx / nc) ** 2 : NaN;
  const vy = nc > 2 ? syy / nc - (sy / nc) ** 2 : NaN;
  return {
    e,
    maxS: e ? maxS : NaN,
    arg,
    strong,
    meanZ2: e ? sumZ2 / e : NaN,
    top1,
    top1Item: topIdx.length ? topIdx[0] : -1,
    topMean: tn ? tsum / tn : NaN,
    corr: vx > 1e-12 && vy > 1e-12 ? cov / Math.sqrt(vx * vy) : NaN,
  };
}

// One replicate's (or the real history's) statistics, compactly:
// per family, arrays over scopes 0..T (T = pooled).
export const STAT_KEYS = ['maxS', 'strong', 'meanZ2', 'top1', 'topMean', 'corr'];
export function replicateStats(ctx, zbuf) {
  const { T } = ctx;
  const { strongZ, top } = ctx.o;
  return ctx.fams.map((fam, f) => {
    const out = Object.fromEntries(STAT_KEYS.map((k) => [k, new Float64Array(T + 1).fill(NaN)]));
    for (let s = 0; s <= T; s++) {
      if (s === T && !fam.pooled) continue;
      const st = scopeStats(fam, zbuf[f], s, strongZ, top);
      for (const k of STAT_KEYS) out[k][s] = st[k];
    }
    return out;
  });
}

// Per-item exceedances in the full window: how often a null history's item is
// at least as strong as the real one (-> per-item empirical p-values).
export function newExceed(ctx) {
  return ctx.fams.map((fam) => ({ hit: new Float64Array((ctx.T + 1) * fam.size), n: new Float64Array((ctx.T + 1) * fam.size) }));
}

export function addExceed(ctx, exceed, realZ, zbuf) {
  ctx.fams.forEach((fam, f) => {
    const real = realZ[f][0];
    const z = zbuf[f][0];
    const { hit, n } = exceed[f];
    for (let k = 0; k < real.length; k++) {
      const zr = real[k];
      const zn = z[k];
      if (Number.isNaN(zr) || Number.isNaN(zn)) continue;
      n[k]++;
      if (strength(fam.sided, zn) >= strength(fam.sided, zr) - 1e-9) hit[k]++;
    }
  });
}

export function mergeExceed(into, from) {
  into.forEach((e, f) => {
    for (let k = 0; k < e.hit.length; k++) {
      e.hit[k] += from[f].hit[k];
      e.n[k] += from[f].n[k];
    }
  });
  return into;
}
