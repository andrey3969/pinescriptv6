// Season-level memory: does a team's season win rate echo L seasons later?
// Covers the "23-year batches" idea and every lag from 1 to 26 seasons.
// r(L) = mean over teams and seasons of d(s) * d(s + L) / mean d^2, where d is
// the season win rate minus the team's own 1999-2025 average.
//   permutation null: each team's seasons in random order (no memory at all)
//   market null:      every game re-played from the point spread (the memory
//                     the betting market already expects)
import { allTeams, teamSchedule } from '../data.js';
import { hashSeed, mulberry32, shuffleInPlace } from '../rng.js';
import { empiricalP, mean, quantile } from '../stats.js';
import { nullGenerators, prepare } from './engine.js';

function seasonRates(schedules, results, from, to) {
  return schedules.map((seq, t) => {
    const n = new Float64Array(to - from + 1);
    const w = new Float64Array(to - from + 1);
    seq.forEach((g, i) => {
      const r = results[t][i];
      if (g.season < from || g.season > to || r === null) return;
      n[g.season - from]++;
      w[g.season - from] += r === 1 ? 1 : r === 0 ? 0.5 : 0;
    });
    const rates = Array.from(n, (k, s) => (k ? w[s] / k : NaN));
    const m = mean(rates.filter((x) => !Number.isNaN(x)));
    const dev = rates.map((x) => x - m);
    dev.teamMean = m;
    return dev;
  });
}

function lagCorrelations(dev, maxLag) {
  let ss = 0;
  let cnt = 0;
  for (const d of dev) {
    for (const x of d) {
      if (Number.isNaN(x)) continue;
      ss += x * x;
      cnt++;
    }
  }
  const v = ss / cnt;
  return Array.from({ length: maxLag }, (_, k) => {
    const L = k + 1;
    let s = 0;
    let c = 0;
    for (const d of dev) {
      for (let a = 0; a + L < d.length; a++) {
        if (Number.isNaN(d[a]) || Number.isNaN(d[a + L])) continue;
        s += d[a] * d[a + L];
        c++;
      }
    }
    return { lag: L, pairs: c, r: c ? s / c / v : NaN };
  });
}

export function seasonLags(games, { from = 1999, to = 2025, maxLag = 26, permReps = 10000, marketReps = 1000, highlight = [7, 8, 23], team = 'SEA' } = {}) {
  const teams = allTeams(games);
  const schedules = teams.map((t) => teamSchedule(games, t));
  const base = schedules.map((seq) => seq.map((g) => g.result));
  const dev = seasonRates(schedules, base, from, to);
  const real = lagCorrelations(dev, maxLag);

  const perm = [];
  for (let k = 0; k < permReps; k++) {
    const rand = mulberry32(hashSeed('season-perm', k));
    perm.push(lagCorrelations(dev.map((d) => shuffleInPlace(d.slice(), rand)), maxLag).map((x) => x.r));
  }
  const ctx = prepare(games, { families: [], from, to });
  const gen = nullGenerators(ctx);
  const market = [];
  for (let k = 0; k < marketReps; k++) market.push(lagCorrelations(seasonRates(ctx.schedules, gen.market(k), from, to), maxLag).map((x) => x.r));

  const compare = (nullRows) => {
    const cols = real.map((_, L) => nullRows.map((row) => row[L]));
    const mu = cols.map(mean);
    const sd = cols.map((c, L) => Math.sqrt(mean(c.map((x) => (x - mu[L]) ** 2))));
    const zReal = real.map((x, L) => (x.r - mu[L]) / sd[L]);
    const maxNull = nullRows.map((row) => Math.max(...row.map((x, L) => Math.abs((x - mu[L]) / sd[L]))));
    return real.map((x, L) => ({
      mean: mu[L],
      lo: quantile(cols[L], 0.025),
      hi: quantile(cols[L], 0.975),
      z: zReal[L],
      p: empiricalP(cols[L], (y) => Math.abs(y - mu[L]) >= Math.abs(x.r - mu[L]) - 1e-12),
      pFamily: empiricalP(maxNull, (m) => m >= Math.abs(zReal[L]) - 1e-12),
    }));
  };
  const vsPerm = compare(perm);
  const vsMarket = compare(market);

  // How far seasons stray from each team's norm: real vs. the spread's replays.
  const spreadOf = (d) => Math.sqrt(mean(d.flat().filter((x) => !Number.isNaN(x)).map((x) => x * x)));
  const marketSpreads = [];
  for (let k = 0; k < Math.min(marketReps, 200); k++) marketSpreads.push(spreadOf(seasonRates(ctx.schedules, gen.market(k), from, to)));
  const seasonSpread = {
    real: spreadOf(dev),
    market: { mean: mean(marketSpreads), lo: quantile(marketSpreads, 0.025), hi: quantile(marketSpreads, 0.975) },
  };

  // The team's own pairs at the highlighted lags (e.g. 1999 vs 2022 for 23).
  const own = dev[teams.indexOf(team)] ?? null;
  const teamPairs = own
    ? highlight.map((L) => ({
        lag: L,
        pairs: own.flatMap((x, a) =>
          a + L < own.length && !Number.isNaN(x) && !Number.isNaN(own[a + L])
            ? [{ a: from + a, b: from + a + L, rateA: x + own.teamMean, rateB: own[a + L] + own.teamMean }]
            : [],
        ),
      }))
    : null;

  return {
    window: { from, to },
    permReps,
    marketReps,
    lags: real.map((x, L) => ({ ...x, perm: vsPerm[L], market: vsMarket[L] })),
    seasonSpread,
    highlight,
    team: own ? { team, mean: own.teamMean, pairs: teamPairs } : null,
  };
}
