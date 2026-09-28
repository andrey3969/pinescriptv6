// Runs the family engine over worker threads and summarises it: for every
// family and null kind, the pooled league-wide test, every team's own test,
// and the split-half check (found on 1999-2012, scored on 2013-2025).
import { Worker } from 'node:worker_threads';
import { DATA_FILE } from '../data.js';
import { defaultWorkers } from '../jobs.js';
import { benjaminiHochberg, empiricalP, mean, quantile } from '../stats.js';
import {
  NULLS,
  STAT_KEYS,
  countAll,
  fillZ,
  mergeExceed,
  mergeMoments,
  newZBuffers,
  nullGenerators,
  prepare,
  scopeStats,
  standardizers,
  strength,
} from './engine.js';

// Normal tail for BH on the quasi-binomial z-scores (empirical p-values
// cannot go below 1/(reps+1), too coarse for thousands of items).
function normalSf(z) {
  // Abramowitz-Stegun 7.1.26 via erfc
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = y * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}
const itemP = (sided, z) => (sided === 'two' ? 2 * normalSf(Math.abs(z)) : sided === 'upper' ? normalSf(z) : normalSf(-z));

// placebo = { kind, rep }: score one extra null history in place of the real
// one. A calibrated engine then flags about 5% of teams at p < 0.05.
export async function runFamilyTests(
  games,
  { dataFile = DATA_FILE, opts = {}, workers = defaultWorkers(), kinds = NULLS, placebo = null, onProgress } = {},
) {
  const ctx = prepare(games, opts);
  const R = ctx.o.reps;
  const gen = nullGenerators(ctx);
  ctx.bWithin = gen.bWithin;
  const realCounts = countAll(ctx, placebo ? gen[placebo.kind](placebo.rep) : gen.real());
  const nW = Math.max(1, Math.min(workers, R));
  const slices = Array.from({ length: nW }, (_, w) => [Math.floor((w * R) / nW), Math.floor(((w + 1) * R) / nW)]);
  const total = 2 * R * kinds.length;
  let done = 0;

  const mom = Object.fromEntries(kinds.map((k) => [k, { parts: 0, sum: null }]));
  const out = Object.fromEntries(kinds.map((k) => [k, { stats: new Array(R), exceed: null, parts: 0 }]));
  const std = {};
  const realZ = {};

  await new Promise((resolve, reject) => {
    const pool = slices.map(
      ([start, end]) => new Worker(new URL('./worker.js', import.meta.url), { workerData: { dataFile, opts, start, end, kinds } }),
    );
    let finished = 0;
    for (const worker of pool) {
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code) reject(new Error(`lab worker exited with code ${code}`));
        else if (++finished === pool.length) resolve();
      });
      worker.on('message', (m) => {
        if (m.type === 'progress') return onProgress?.(++done, total);
        if (m.type === 'moments') {
          const e = mom[m.kind];
          e.sum = e.sum ? mergeMoments(e.sum, m.mom) : m.mom;
          if (++e.parts < pool.length) return;
          std[m.kind] = standardizers(ctx, e.sum, R);
          realZ[m.kind] = newZBuffers(ctx);
          fillZ(ctx, std[m.kind], realCounts, realZ[m.kind]);
          e.sum = null;
          for (const w of pool) w.postMessage({ kind: m.kind, std: std[m.kind], realZ: realZ[m.kind] });
          return;
        }
        const e = out[m.kind];
        m.stats.forEach((s, k) => (e.stats[m.start + k] = s));
        e.exceed = e.exceed ? mergeExceed(e.exceed, m.exceed) : m.exceed;
        e.parts++;
      });
    }
  });

  return summarize(ctx, { realCounts, std, realZ, out, kinds });
}

function summarize(ctx, { realCounts, std, realZ, out, kinds }) {
  const { T, teams } = ctx;
  const families = {};
  const itemFns = {};
  ctx.fams.forEach((fam, f) => {
    const S = fam.size;
    const nulls = {};
    for (const kind of kinds) {
      const zb = realZ[kind][f];
      const scopes = Array.from({ length: T + 1 }, (_, s) => (s === T && !fam.pooled ? null : scopeStats(fam, zb, s, ctx.o.strongZ, ctx.o.top)));
      const real = Object.fromEntries(
        [...STAT_KEYS, 'top1Item'].map((key) => [key, scopes.map((st) => (st ? st[key] : NaN))]),
      );
      const reps = out[kind].stats.map((s) => s[f]);
      const col = (key, s) => reps.map((r) => r[key][s]).filter((x) => !Number.isNaN(x));
      const { hit, n: nEx } = out[kind].exceed[f];
      const { mu, sc } = std[kind][f][0];

      const item = (s, i) => {
        const k = s * S + i;
        const z = zb[0][k];
        const base = { id: i, label: fam.describe(i), z, p: (1 + hit[k]) / (1 + nEx[k]), pNormal: itemP(fam.sided, z) };
        if (fam.value) {
          const v = s === T ? mean(realCounts[f][0].map((vals) => vals[i])) : realCounts[f][0][s][i];
          return { ...base, value: v, nullMean: mu[k], nullSd: sc[k] };
        }
        let n = 0;
        let hits = 0;
        for (const t of s === T ? teams.keys() : [s]) {
          n += realCounts[f][0][t].n[i];
          hits += realCounts[f][0][t].hits[i];
        }
        return { ...base, n, hits, rate: hits / n, nullRate: mu[k], nullSd: Math.sqrt(sc[k] / n) };
      };
      itemFns[`${fam.key}|${kind}`] = item;

      // Everything that is one number per scope, real vs. the null histories.
      const vsNull = (key, s, sidedUp = true) => {
        const values = col(key, s);
        const r = real[key][s];
        return {
          real: r,
          nullMean: mean(values),
          null05: quantile(values, 0.05),
          null95: quantile(values, 0.95),
          p: Number.isNaN(r) ? NaN : empiricalP(values, (x) => (sidedUp ? x >= r - 1e-9 : x <= r + 1e-9)),
        };
      };

      const topItems = (s, k) => {
        const idx = [];
        for (let i = 0; i < S; i++) if (!Number.isNaN(zb[0][s * S + i])) idx.push(i);
        const all = idx.map((i) => ({ i, st: strength(fam.sided, zb[0][s * S + i]) }));
        const q = benjaminiHochberg(all.map((x) => itemP(fam.sided, zb[0][s * S + x.i])));
        const qOf = new Map(all.map((x, j) => [x.i, q[j]]));
        const nullMax = col('maxS', s);
        const top = all
          .sort((a, b) => b.st - a.st)
          .slice(0, k)
          .map(({ i, st }) => ({ ...item(s, i), q: qOf.get(i), pFamily: empiricalP(nullMax, (x) => x >= st - 1e-9) }));
        return { top, bh05: q.filter((x) => x < 0.05).length, eligible: idx.length };
      };

      const scope = (s, k) => {
        const t = topItems(s, k);
        return {
          eligible: t.eligible,
          max: vsNull('maxS', s),
          strong: vsNull('strong', s),
          meanZ2: vsNull('meanZ2', s),
          split: { top1: vsNull('top1', s), topMean: vsNull('topMean', s), corr: vsNull('corr', s) },
          splitItem: real.top1Item?.[s] >= 0 ? fam.describe(real.top1Item[s]) : null,
          bh05: t.bh05,
          top: t.top,
          // every item's z-score (null = not testable), for the overview chart
          z: Array.from(zb[0].subarray(s * S, (s + 1) * S), (z) => (Number.isNaN(z) ? null : Math.round(z * 1000) / 1000)),
        };
      };

      // Per-team family-wise p-values, and how many teams reach p < 0.05 in
      // the real data versus in each null history (leave-one-out ranks).
      const teamMax = teams.map((_, t) => reps.map((r) => r.maxS[t]));
      const teamP = teams.map((_, t) => empiricalP(teamMax[t].filter((x) => !Number.isNaN(x)), (x) => x >= real.maxS[t] - 1e-9));
      const sorted = teamMax.map((v) => Float64Array.from(v.filter((x) => !Number.isNaN(x))).sort());
      const countAbove = (arr, x) => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (arr[m] < x - 1e-9) lo = m + 1;
          else hi = m;
        }
        return arr.length - lo;
      };
      const nullSig = reps.map((r) =>
        teams.reduce((c, _, t) => {
          const x = r.maxS[t];
          if (Number.isNaN(x)) return c;
          const p = countAbove(sorted[t], x) / sorted[t].length; // includes itself: (1 + others) / (1 + others' count)
          return c + (p < 0.05 ? 1 : 0);
        }, 0),
      );
      const realSig = teamP.filter((p) => p < 0.05).length;
      const teamSum = (key, fn = (a) => a) => {
        const realV = fn(teams.map((_, t) => real[key][t]));
        const nullV = reps.map((r) => fn(teams.map((_, t) => r[key][t])));
        return { real: realV, nullMean: mean(nullV), null05: quantile(nullV, 0.05), null95: quantile(nullV, 0.95), p: empiricalP(nullV, (x) => x >= realV - 1e-9) };
      };
      const avg = (xs) => mean(xs.filter((x) => !Number.isNaN(x)));
      const sum = (xs) => xs.reduce((a, x) => a + (Number.isNaN(x) ? 0 : x), 0);
      const heldCount = (xs) => xs.filter((x) => x > 0).length;

      nulls[kind] = {
        pooled: fam.pooled ? scope(T, 10) : null,
        teams: {
          perTeam: teams.map((team, t) => {
            const best = real.maxS[t];
            const it = topItems(t, 1).top[0] ?? null;
            const sp = real.top1Item?.[t];
            return {
              team,
              maxS: best,
              p: teamP[t],
              strong: real.strong[t],
              best: it,
              split: { top1: real.top1[t], item: sp >= 0 ? fam.describe(sp) : null },
            };
          }),
          sig: { real: realSig, nullMean: mean(nullSig), null95: quantile(nullSig, 0.95), p: empiricalP(nullSig, (x) => x >= realSig) },
          strong: teamSum('strong', sum),
          meanZ2: teamSum('meanZ2', avg),
          split: { top1: teamSum('top1', avg), held: teamSum('top1', heldCount), corr: teamSum('corr', avg) },
        },
      };
    }
    families[fam.key] = {
      key: fam.key,
      label: fam.def.label,
      short: fam.def.short,
      kind: fam.value ? 'value' : fam.def.kind,
      sided: fam.sided,
      items: S,
      pooledTest: fam.pooled,
      nulls,
    };
  });
  const { families: _, ...settings } = ctx.o;
  return {
    summary: {
      settings: { ...settings, teams: ctx.teams, windows: ctx.bounds, nulls: kinds },
      market: { b: ctx.market.b },
      families,
    },
    ctx,
    // item(familyKey, nullKind, scope (team code or 'pooled'), itemId)
    item: (key, kind, scope, id) => itemFns[`${key}|${kind}`](scope === 'pooled' ? T : teams.indexOf(scope), id),
    famIndex: (key) => ctx.fams.findIndex((x) => x.key === key),
  };
}
