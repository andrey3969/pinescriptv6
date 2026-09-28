// The whole lattice lab: every family on every team against two null
// models, a calibration check on pure-noise histories, season-level cycles,
// and the league-wide machine-learning suite. Returns one JSON-safe object.
import { fitMarket } from '../crossteam.js';
import { DATA_FILE } from '../data.js';
import { defaultWorkers } from '../jobs.js';
import { loadLedger } from '../ledger.js';
import { mean, quantile } from '../stats.js';
import { ORDER_SIZE, decodeOrder } from '../scan.js';
import { NULL_LABELS, NULLS } from './engine.js';
import { runFamilyTests } from './familytest.js';
import { lagItem, LAGS } from './families.js';
import { buildDataset, evaluate, ML_MODELS, orderNullCheck, walkForward } from './ml.js';
import { runOwnLattices } from './own.js';
import { seasonLags } from './seasons.js';
import { CAL_PERIODS, GAME_FREQS } from './spectral.js';

const orderIdOf = (gap, k, sameSeason) => {
  for (let id = 0; id < ORDER_SIZE; id++) {
    const r = decodeOrder(id);
    if (r.gap === gap && r.k === k && r.sameSeason === sameSeason) return id;
  }
  return -1;
};

// The intervals and rules named in the hand analysis, reported one by one.
export const NAMED = [
  ...[3, 4, 7, 10, 11, 14, 18, 21, 23, 27, 28, 161, 184, 1380, 1764, 1998, 2160, 2760, 8400].map((d) => ({
    family: 'calLag',
    id: lagItem(d),
    label: `Same result ${d} days apart`,
    group: d <= 28 ? 'short' : 'long',
  })),
  { family: 'cal2', id: 28 * 64 + 10, label: '28/10 rule: games 28 and 10 days back agree', group: 'rule' },
  { family: 'order', id: orderIdOf(10, 4, false), label: '10-day gap, 4th previous game', group: 'rule' },
  { family: 'order', id: orderIdOf(10, 4, true), label: '10-day gap, 4th previous, same season', group: 'rule' },
  { family: 'order', id: orderIdOf(11, 3, false), label: '11-day gap, 3rd previous ("11/3")', group: 'rule' },
  { family: 'order', id: orderIdOf(21, 7, false), label: '21-day gap, 7th previous ("21/7")', group: 'rule' },
];

const pick = (x, keys) => Object.fromEntries(keys.map((k) => [k, x[k]]));
const ITEM_KEYS = ['n', 'hits', 'rate', 'nullRate', 'nullSd', 'z', 'p', 'value', 'nullMean'];

function namedTable(fam, { team, kinds }) {
  return NAMED.map((x) => ({
    ...x,
    scopes: Object.fromEntries(
      ['pooled', team].map((scope) => [
        scope,
        Object.fromEntries(kinds.map((kind) => [kind, pick(fam.item(x.family, kind, scope, x.id), ITEM_KEYS)])),
      ]),
    ),
  }));
}

function curves(fam, { team, kinds }) {
  const series = (family, ids, scope) =>
    Object.fromEntries(kinds.map((kind) => [kind, ids.map((id) => pick(fam.item(family, kind, scope, id), ITEM_KEYS))]));
  const lagIds = LAGS.map((d, id) => (d <= 400 ? id : -1)).filter((id) => id >= 0);
  const out = {
    calLag: { lags: lagIds.map((id) => LAGS[id]), pooled: series('calLag', lagIds, 'pooled'), team: series('calLag', lagIds, team) },
    specCal: { periods: CAL_PERIODS, pooled: series('specCal', CAL_PERIODS.map((_, i) => i), 'pooled') },
    specGame: { periods: GAME_FREQS.map((f) => 1 / f), pooled: series('specGame', GAME_FREQS.map((_, i) => i), 'pooled') },
    markov: {
      labels: Array.from({ length: 62 }, (_, i) => fam.item('markov', kinds[0], 'pooled', i).label),
      pooled: series('markov', Array.from({ length: 62 }, (_, i) => i), 'pooled'),
    },
  };
  return out;
}

// Power: plant a lattice of known strength in a noise history and ask the
// engine to find it (5 plantings per strength, spread-weighted null).
export const POWER_PLANTS = [
  { id: 'order', family: 'order', rule: { type: 'order', gap: 10, k: 4 }, item: orderIdOf(10, 4, false), scope: 'pooled', label: '10-day gap, 4th previous: repeat (all 32 teams)', qs: [0.15, 0.3, 0.5] },
  { id: 'lag7', family: 'calLag', rule: { type: 'lag', d: 7 }, item: lagItem(7), scope: 'pooled', label: 'Same result 7 days apart (all 32 teams)', qs: [0.02, 0.04, 0.08] },
  { id: 'lag7team', family: 'calLag', rule: { type: 'lag', d: 7 }, teams: ['SEA'], item: lagItem(7), scope: 'SEA', label: 'Same result 7 days apart (Seattle only)', qs: [0.1, 0.2, 0.4] },
];

export async function powerCheck(games, { dataFile = DATA_FILE, workers, reps = 200, runs = 5, log = () => {} } = {}) {
  const out = [];
  for (const plant of POWER_PLANTS) {
    for (const q of plant.qs) {
      log(`  planted: ${plant.label}, q = ${q}`);
      const rows = [];
      for (let run = 1; run <= runs; run++) {
        const res = await runFamilyTests(games, {
          dataFile,
          opts: { reps, families: [plant.family], plant: { rule: plant.rule, q, teams: plant.teams ?? null, seed: run, baseRep: 8_000_000 + run } },
          workers,
          kinds: ['spread'],
        });
        const x = res.summary.families[plant.family].nulls.spread;
        const it = res.item(plant.family, 'spread', plant.scope, plant.item);
        const teamRow = plant.scope === 'pooled' ? null : x.teams.perTeam.find((t) => t.team === plant.scope);
        rows.push({
          p: teamRow ? teamRow.p : x.pooled.max.p,
          top: teamRow ? teamRow.best?.id === plant.item : x.pooled.top[0]?.id === plant.item,
          n: it.n,
          rate: it.rate,
          nullRate: it.nullRate,
        });
      }
      out.push({
        id: plant.id,
        label: plant.label,
        scope: plant.scope,
        q,
        runs: rows.length,
        detected: rows.filter((r) => r.p < 0.05).length,
        topItem: rows.filter((r) => r.top).length,
        medianP: quantile(rows.map((r) => r.p), 0.5),
        n: mean(rows.map((r) => r.n)),
        rate: mean(rows.map((r) => r.rate)),
        nullRate: mean(rows.map((r) => r.nullRate)),
      });
    }
  }
  return out;
}

export const LAB_PARTS = ['families', 'placebo', 'power', 'seasons', 'ml', 'own'];

export async function runLab(
  games,
  {
    dataFile = DATA_FILE,
    reps = 1000,
    placeboReps = 300,
    powerReps = 200,
    powerRuns = 5,
    workers,
    team = 'SEA',
    mlNullReps = 20,
    seasonPerms = 10000,
    seasonMarket = 1000,
    ownNullReps = 1000,
    quick = false,
    parts = LAB_PARTS,
    previous = null,
    log = () => {},
  } = {},
) {
  const started = Date.now();
  const out = previous ? { ...previous } : {};
  const want = (p) => parts.includes(p);
  const kinds = NULLS;
  const progress = (label) => {
    let last = 0;
    return (done, total) => {
      const pct = Math.floor((100 * done) / total);
      if (pct >= last + 10 || done === total) {
        last = pct;
        log(`  ${label} ${pct}%`);
      }
    };
  };

  const timings = { ...(out.timings ?? {}) };
  const timed = async (part, fn) => {
    const t0 = Date.now();
    const value = await fn();
    timings[part] = Math.round((Date.now() - t0) / 1000);
    return value;
  };

  if (want('families')) {
    await timed('families', async () => {
      log(`Families: ${reps} null histories of each kind (${kinds.join(', ')})`);
      const fam = await runFamilyTests(games, { dataFile, opts: { reps }, workers, kinds, onProgress: progress('families') });
      Object.assign(out, {
        team,
        nullLabels: Object.fromEntries(kinds.map((k) => [k, NULL_LABELS[k]])),
        settings: fam.summary.settings,
        market: { ...fam.summary.market, bWithin: fam.ctx.bWithin },
        hypotheses: Object.values(fam.summary.families).reduce((sum, f) => sum + f.items * (fam.ctx.T + (f.pooledTest ? 1 : 0)), 0),
        families: fam.summary.families,
        named: namedTable(fam, { team, kinds }),
        curves: curves(fam, { team, kinds }),
      });
    });
  }

  if (want('placebo')) {
    out.placebo = await timed('placebo', async () => {
      if (!placeboReps) return null;
      const placebo = {};
      for (const kind of kinds) {
        log(`Calibration: one ${kind} history scored as if real (${placeboReps} null histories)`);
        const p = await runFamilyTests(games, { dataFile, opts: { reps: placeboReps }, workers, kinds: [kind], placebo: { kind, rep: 9_000_000 }, onProgress: progress('placebo') });
        placebo[kind] = Object.fromEntries(
          Object.entries(p.summary.families).map(([key, f]) => {
            const x = f.nulls[kind];
            return [key, { pooledMaxP: x.pooled?.max.p ?? null, pooledMeanZ2P: x.pooled?.meanZ2.p ?? null, teamsSig: x.teams.sig.real, teamsSigNull: x.teams.sig.nullMean }];
          }),
        );
        placebo[kind].reps = placeboReps;
      }
      return placebo;
    });
  }

  if (want('power')) {
    out.power = await timed('power', async () => {
      if (!powerRuns) return null;
      log(`Power: planted lattices, ${powerRuns} plantings per strength`);
      return { reps: powerReps, runs: powerRuns, plants: await powerCheck(games, { dataFile, workers, reps: powerReps, runs: powerRuns, log }) };
    });
  }

  if (want('seasons')) {
    out.seasons = await timed('seasons', async () => {
      log('Season-level cycles');
      return seasonLags(games, { permReps: seasonPerms, marketReps: seasonMarket, team });
    });
  }

  if (want('ml')) {
    out.ml = await timed('ml', async () => {
      log('Machine-learning suite (walk-forward, 4 blocks)');
      const ds = buildDataset(games);
      const wf = walkForward(ds, ML_MODELS, { onModel: (key, from) => log(`  ${key} ${from}`) });
      const models = evaluate(ds, wf, ML_MODELS);
      log(`Order check: lattice models on ${mlNullReps} shuffled leagues`);
      const orderNull = mlNullReps ? orderNullCheck(games, { reps: mlNullReps, models: ['ridge', 'forest', 'pattern'] }) : null;
      return { rows: ds.n, teams: ds.teams.length, blocks: models[0].blocks.map((x) => x.block), models, orderNull };
    });
  }

  if (want('own')) {
    out.own = await timed('own', async () => {
      log('My own lattices, against the point spread');
      return runOwnLattices(games, { market: fitMarket(games), nullReps: ownNullReps, ledger: loadLedger(), workers: workers ?? defaultWorkers(), dataFile, log });
    });
  }

  out.generated = new Date().toISOString();
  out.quick = quick;
  out.timings = timings;
  out.seconds = Object.values(timings).reduce((sum, x) => sum + x, 0);
  return out;
}
