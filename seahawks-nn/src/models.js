import { isDecided } from './data.js';
import { buildMatrix, scheduleIndex } from './features.js';
import { trainEnsemble, trainNet } from './nn.js';
import { wilson } from './stats.js';

export const MODELS = {
  always_win: { label: 'Always pick this team', kind: 'baseline' },
  home: { label: 'Pick the home team', kind: 'baseline' },
  repeat_last: { label: 'Repeat the previous result', kind: 'baseline' },
  season_form: { label: 'Season-to-date record', kind: 'baseline' },
  vegas: { label: 'Vegas point spread', kind: 'baseline' },
  rule_28_10: { label: '28/10-day agreement rule', kind: 'rule' },
  lr_lattice: { label: 'Logistic regression: results + timing', kind: 'model', set: 'lattice', hidden: 0 },
  nn_lattice: { label: 'Neural net: results + timing', kind: 'model', set: 'lattice' },
  nn_sequence: { label: 'Neural net: last 8 results, no dates', kind: 'model', set: 'sequence' },
  nn_conventional: { label: 'Neural net: spread + home + form', kind: 'model', set: 'conventional' },
  nn_all: { label: 'Neural net: everything', kind: 'model', set: 'all' },
};

export const ALL_MODEL_KEYS = Object.keys(MODELS);

// "If the results d1 and d2 days before a game agree, predict that result."
// Returns 1 / -1, or null when the rule makes no call.
export function lookbackRule(seq, results, i, d1 = 28, d2 = 10) {
  const prev = scheduleIndex(seq).calPrev[i];
  const a = prev[d1];
  const b = prev[d2];
  if (a < 0 || b < 0) return null;
  return isDecided(results[a]) && results[a] === results[b] ? results[a] : null;
}

export function makeContext(seq, results = seq.map((g) => g.result)) {
  const mats = {};
  return {
    seq,
    results,
    y: Uint8Array.from(results, (r) => (r === 1 ? 1 : 0)),
    matrix(set) {
      return (mats[set] ??= buildMatrix(seq, results, set));
    },
    column(name) {
      const m = this.matrix('all');
      const j = m.names.indexOf(name);
      return Float64Array.from(seq, (_, i) => m.X[i * m.D + j]);
    },
  };
}

const smoothedRate = (hits, n) => (hits + 1) / (n + 2);

function fitOneFeature(ctx, train, name) {
  const X = ctx.column(name);
  const net = trainNet(X, 1, ctx.y, train, { hidden: 0, valFrac: 0, l2: 1e-4, lr: 0.05, maxEpochs: 500 });
  return (rows) => net.predict(X, rows);
}

// Fit `key` on the training rows; returns rows -> P(win) (NaN = no call).
export function fitModel(key, ctx, train, { seeds = [1, 2, 3, 4, 5], net = {} } = {}) {
  const { seq, results, y } = ctx;
  const winRate = (rows) => smoothedRate(rows.reduce((s, i) => s + y[i], 0), rows.length);
  switch (key) {
    case 'always_win': {
      const p = winRate(train);
      return (rows) => Float64Array.from(rows, () => p);
    }
    case 'home': {
      const all = winRate(train);
      const rate = {};
      for (const h of [1, 0, -1]) {
        const r = train.filter((i) => seq[i].home === h);
        rate[h] = r.length >= 5 ? winRate(r) : all;
      }
      return (rows) => Float64Array.from(rows, (i) => rate[seq[i].home]);
    }
    case 'repeat_last': {
      const prev = (i) => (i > 0 && isDecided(results[i - 1]) ? results[i - 1] : 0);
      const known = train.filter((i) => prev(i) !== 0);
      const same = smoothedRate(known.filter((i) => (y[i] ? 1 : -1) === prev(i)).length, known.length);
      const base = winRate(train);
      return (rows) => Float64Array.from(rows, (i) => (prev(i) === 1 ? same : prev(i) === -1 ? 1 - same : base));
    }
    case 'season_form':
      return fitOneFeature(ctx, train, 'season_win_pct');
    case 'vegas':
      return fitOneFeature(ctx, train, 'spread');
    case 'rule_28_10':
      return (rows) =>
        Float64Array.from(rows, (i) => {
          const call = lookbackRule(seq, results, i, 28, 10);
          return call === null ? NaN : call === 1 ? 1 : 0;
        });
    default: {
      const spec = MODELS[key];
      if (!spec?.set) throw new Error(`unknown model: ${key}`);
      const { X, D } = ctx.matrix(spec.set);
      const model = trainEnsemble(X, D, y, train, { ...net, ...(spec.hidden !== undefined && { hidden: spec.hidden }) }, seeds);
      return (rows) => model.predict(X, rows);
    }
  }
}

export function scoreModel(p, y, rows) {
  const used = rows.filter((i) => !Number.isNaN(p[i]));
  let correct = 0;
  let ll = 0;
  let brier = 0;
  for (const i of used) {
    if ((p[i] >= 0.5 ? 1 : 0) === y[i]) correct++;
    const pc = Math.min(1 - 1e-6, Math.max(1e-6, p[i]));
    ll -= y[i] ? Math.log(pc) : Math.log(1 - pc);
    brier += (p[i] - y[i]) ** 2;
  }
  const n = used.length;
  return {
    n,
    coverage: rows.length ? n / rows.length : 0,
    correct,
    accuracy: n ? correct / n : NaN,
    ci: wilson(correct, n),
    logLoss: n ? ll / n : NaN,
    brier: n ? brier / n : NaN,
  };
}

// Train on every season before Y, predict season Y; repeat for each Y.
// Nothing from season Y (or later) is ever seen before it is predicted.
export function walkForward({
  seq,
  results = seq.map((g) => g.result),
  models = ALL_MODEL_KEYS,
  trainFrom = seq[0].season,
  testFrom,
  testTo,
  seeds,
  net,
}) {
  const ctx = makeContext(seq, results);
  const preds = Object.fromEntries(models.map((k) => [k, new Float64Array(seq.length).fill(NaN)]));
  const testRows = [];
  for (let season = testFrom; season <= testTo; season++) {
    const train = [];
    const test = [];
    seq.forEach((g, i) => {
      if (!isDecided(results[i])) return;
      if (g.season >= trainFrom && g.season < season) train.push(i);
      else if (g.season === season) test.push(i);
    });
    if (!train.length || !test.length) continue;
    for (const key of models) {
      const p = fitModel(key, ctx, train, { seeds, net })(test);
      test.forEach((i, r) => (preds[key][i] = p[r]));
    }
    testRows.push(...test);
  }
  const metrics = Object.fromEntries(models.map((k) => [k, scoreModel(preds[k], ctx.y, testRows)]));
  return { ctx, preds, testRows, metrics };
}
