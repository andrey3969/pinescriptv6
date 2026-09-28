// The whole lattice lab: every family on every team against two null
// models, a calibration check on pure-noise histories, season-level cycles,
// and the league-wide machine-learning suite. Returns one JSON-safe object.
import { DATA_FILE } from '../data.js';
import { ORDER_SIZE, decodeOrder } from '../scan.js';
import { NULL_LABELS, NULLS } from './engine.js';
import { runFamilyTests } from './familytest.js';
import { lagItem, LAGS } from './families.js';
import { buildDataset, evaluate, ML_MODELS, orderNullCheck, walkForward } from './ml.js';
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

export async function runLab(
  games,
  { dataFile = DATA_FILE, reps = 1000, placeboReps = 300, workers, team = 'SEA', mlNullReps = 20, seasonPerms = 10000, seasonMarket = 1000, quick = false, log = () => {} } = {},
) {
  const started = Date.now();
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

  log(`Families: ${reps} null histories of each kind (${kinds.join(', ')})`);
  const fam = await runFamilyTests(games, { dataFile, opts: { reps }, workers, kinds, onProgress: progress('families') });

  let placebo = null;
  if (placeboReps) {
    placebo = {};
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
  }

  log('Season-level cycles');
  const seasons = seasonLags(games, { permReps: seasonPerms, marketReps: seasonMarket, team });

  log('Machine-learning suite (walk-forward, 4 blocks)');
  const ds = buildDataset(games);
  const wf = walkForward(ds, ML_MODELS, { onModel: (key, from) => log(`  ${key} ${from}`) });
  const models = evaluate(ds, wf, ML_MODELS);
  log(`Order check: lattice models on ${mlNullReps} shuffled leagues`);
  const orderNull = mlNullReps ? orderNullCheck(games, { reps: mlNullReps, models: ['ridge', 'forest', 'pattern'] }) : null;

  const hypotheses = Object.values(fam.summary.families).reduce(
    (s, f) => s + f.items * (fam.ctx.T + (f.pooledTest ? 1 : 0)),
    0,
  );
  return {
    generated: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    quick,
    team,
    nullLabels: Object.fromEntries(kinds.map((k) => [k, NULL_LABELS[k]])),
    settings: fam.summary.settings,
    market: { ...fam.summary.market, bWithin: fam.ctx.bWithin },
    hypotheses,
    families: fam.summary.families,
    named: namedTable(fam, { team, kinds }),
    curves: curves(fam, { team, kinds }),
    placebo,
    seasons,
    ml: {
      rows: ds.n,
      teams: ds.teams.length,
      blocks: models[0].blocks.map((b) => b.block),
      models,
      orderNull,
    },
  };
}
