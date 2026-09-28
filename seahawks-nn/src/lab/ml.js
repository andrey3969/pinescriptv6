// League-wide prediction suite for the lattice lab. Every model is trained on
// all 32 teams' games before a block of seasons and scored on that block
// (2004-08, 2009-13, 2014-18, 2019-25): nothing is scored on data it saw.
// One row per team-game (both sides of every game); ties are left out.
//
// Lattice inputs = the team's own results 1-8 games back, results exactly
// 1-63 days back and at the long "numerology" lags, the gaps between games
// and the weekday. The models range from linear (ridge, lasso) through naive
// Bayes, a random forest, a neural network and a pattern matcher with
// back-off, to per-team models ("every team has its own pattern"). The point
// spread is the benchmark to beat.
import { allTeams, isDecided, teamSchedule } from '../data.js';
import { buildMatrix } from '../features.js';
import { trainEnsemble } from '../nn.js';
import { hashSeed, mulberry32, shuffleWithinSeason } from '../rng.js';
import { mean, quantile } from '../stats.js';

export const BLOCKS = [
  [2004, 2008],
  [2009, 2013],
  [2014, 2018],
  [2019, 2025],
];
const SETS = ['labLattice', 'labMarket', 'labForm', 'labMarketForm', 'labMarketLattice'];
const EPS = 1e-6;
const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const clampP = (p) => Math.min(1 - EPS, Math.max(EPS, p));

// ---- data --------------------------------------------------------------------
const WEEKDAY_SLOT = { Sun: 0, Mon: 1, Thu: 2, Sat: 3 };
const gapBucket = (gap) => (gap === null || gap > 60 ? 4 : gap <= 5 ? 0 : gap <= 8 ? 1 : gap <= 13 ? 2 : 3);

export function buildDataset(games, { from = 1999, to = 2025, results = null, sets = SETS } = {}) {
  const teams = allTeams(games);
  const rows = { t: [], season: [], y: [], ctx: [], game: [] };
  const parts = Object.fromEntries(sets.map((s) => [s, []]));
  const dims = {};
  const names = {};
  teams.forEach((team, t) => {
    const seq = teamSchedule(games, team);
    const res = results ? results[t] : seq.map((g) => g.result);
    const keep = seq.flatMap((g, i) => (g.season >= from && g.season <= to && isDecided(res[i]) ? [i] : []));
    for (const set of sets) {
      const m = buildMatrix(seq, res, set);
      dims[set] = m.D;
      names[set] = m.names;
      for (const i of keep) parts[set].push(m.X.subarray(i * m.D, (i + 1) * m.D));
    }
    for (const i of keep) {
      const g = seq[i];
      let last = '';
      for (let k = 1; k <= 5 && i - k >= 0; k++) last += res[i - k] === 1 ? 'W' : res[i - k] === -1 ? 'L' : 'T';
      rows.t.push(t);
      rows.season.push(g.season);
      rows.y.push(res[i] === 1 ? 1 : 0);
      rows.ctx.push({ last, gap: gapBucket(i ? g.day - seq[i - 1].day : null), wd: WEEKDAY_SLOT[g.weekday] ?? 4 });
      rows.game.push(g.gameId);
    }
  });
  const X = {};
  for (const set of sets) {
    const D = dims[set];
    const out = new Float64Array(parts[set].length * D);
    parts[set].forEach((row, r) => out.set(row, r * D));
    X[set] = { X: out, D, names: names[set] };
  }
  return { teams, n: rows.y.length, t: Int32Array.from(rows.t), season: Int32Array.from(rows.season), y: Uint8Array.from(rows.y), ctx: rows.ctx, game: rows.game, X };
}

// Lattice inputs plus one column per team.
function withTeams(ds) {
  const { X, D } = ds.X.labLattice;
  const T = ds.teams.length;
  const out = new Float64Array(ds.n * (D + T));
  for (let r = 0; r < ds.n; r++) {
    out.set(X.subarray(r * D, (r + 1) * D), r * (D + T));
    out[r * (D + T) + D + ds.t[r]] = 1;
  }
  return { X: out, D: D + T };
}

function csr(X, D, idx) {
  const ptr = new Int32Array(idx.length + 1);
  const col = [];
  const val = [];
  idx.forEach((i, r) => {
    for (let j = 0; j < D; j++) {
      const v = X[i * D + j];
      if (v !== 0) {
        col.push(j);
        val.push(v);
      }
    }
    ptr[r + 1] = col.length;
  });
  return { n: idx.length, ptr, col: Int32Array.from(col), val: Float64Array.from(val) };
}

const logit = (w, D, A, r) => {
  let z = w[D];
  for (let q = A.ptr[r]; q < A.ptr[r + 1]; q++) z += w[A.col[q]] * A.val[q];
  return z;
};

function choleskySolve(H, g, P) {
  const L = new Float64Array(P * P);
  for (let j = 0; j < P; j++) {
    let d = H[j * P + j];
    for (let k = 0; k < j; k++) d -= L[j * P + k] ** 2;
    const ljj = Math.sqrt(Math.max(d, 1e-12));
    L[j * P + j] = ljj;
    for (let i = j + 1; i < P; i++) {
      let s = H[i * P + j];
      for (let k = 0; k < j; k++) s -= L[i * P + k] * L[j * P + k];
      L[i * P + j] = s / ljj;
    }
  }
  const z = new Float64Array(P);
  for (let i = 0; i < P; i++) {
    let s = g[i];
    for (let k = 0; k < i; k++) s -= L[i * P + k] * z[k];
    z[i] = s / L[i * P + i];
  }
  const x = new Float64Array(P);
  for (let i = P - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < P; k++) s -= L[k * P + i] * x[k];
    x[i] = s / L[i * P + i];
  }
  return x;
}

// ---- models ------------------------------------------------------------------
// Ridge logistic regression, damped Newton. Penalty lambda * |w|^2 / 2 on the
// summed log loss; the intercept is not penalised.
export function ridgeFit(A, D, y, lambda, w0 = null) {
  const P = D + 1;
  const w = w0 ? Float64Array.from(w0) : new Float64Array(P);
  const objective = (v) => {
    let f = 0;
    for (let r = 0; r < A.n; r++) {
      const p = clampP(sigmoid(logit(v, D, A, r)));
      f -= y[r] ? Math.log(p) : Math.log(1 - p);
    }
    for (let j = 0; j < D; j++) f += (lambda * v[j] * v[j]) / 2;
    return f;
  };
  let f = objective(w);
  for (let it = 0; it < 40; it++) {
    const g = new Float64Array(P);
    const H = new Float64Array(P * P);
    for (let r = 0; r < A.n; r++) {
      const s = A.ptr[r];
      const e = A.ptr[r + 1];
      const p = sigmoid(logit(w, D, A, r));
      const err = p - y[r];
      const v = Math.max(p * (1 - p), 1e-10);
      g[D] += err;
      H[D * P + D] += v;
      for (let q = s; q < e; q++) {
        const j = A.col[q];
        const vx = v * A.val[q];
        g[j] += err * A.val[q];
        H[j * P + D] += vx;
        for (let q2 = q; q2 < e; q2++) H[j * P + A.col[q2]] += vx * A.val[q2];
      }
    }
    for (let j = 0; j < D; j++) {
      g[j] += lambda * w[j];
      H[j * P + j] += lambda + 1e-9;
    }
    for (let j = 0; j < P; j++) for (let k = j + 1; k < P; k++) H[k * P + j] = H[j * P + k];
    const step = choleskySolve(H, g, P);
    let t = 1;
    let next;
    let fNext;
    for (let h = 0; h < 30; h++) {
      next = Float64Array.from(w, (x, j) => x - t * step[j]);
      fNext = objective(next);
      if (fNext <= f + 1e-12) break;
      t /= 2;
    }
    const moved = f - fNext;
    w.set(next);
    f = fNext;
    if (moved < 1e-9 * Math.max(1, Math.abs(f))) break;
  }
  return w;
}

// L1 logistic regression (FISTA with backtracking): mean log loss + lambda |w|_1.
export function lassoFit(A, D, y, lambda, iters = 300) {
  const P = D + 1;
  const loss = (v) => {
    let f = 0;
    for (let r = 0; r < A.n; r++) {
      const p = clampP(sigmoid(logit(v, D, A, r)));
      f -= y[r] ? Math.log(p) : Math.log(1 - p);
    }
    return f / A.n;
  };
  const grad = (v) => {
    const g = new Float64Array(P);
    for (let r = 0; r < A.n; r++) {
      const err = sigmoid(logit(v, D, A, r)) - y[r];
      g[D] += err;
      for (let q = A.ptr[r]; q < A.ptr[r + 1]; q++) g[A.col[q]] += err * A.val[q];
    }
    for (let j = 0; j < P; j++) g[j] /= A.n;
    return g;
  };
  const prox = (v, t) => Float64Array.from(v, (x, j) => (j === D ? x : Math.sign(x) * Math.max(0, Math.abs(x) - t * lambda)));
  let w = new Float64Array(P);
  let z = w.slice();
  let tk = 1;
  let step = 1;
  for (let it = 0; it < iters; it++) {
    const g = grad(z);
    const fz = loss(z);
    let next;
    for (let h = 0; h < 40; h++) {
      next = prox(Float64Array.from(z, (x, j) => x - step * g[j]), step);
      let lin = 0;
      let quad = 0;
      for (let j = 0; j < P; j++) {
        const d = next[j] - z[j];
        lin += g[j] * d;
        quad += d * d;
      }
      if (loss(next) <= fz + lin + quad / (2 * step) + 1e-12) break;
      step /= 2;
    }
    const t1 = (1 + Math.sqrt(1 + 4 * tk * tk)) / 2;
    z = Float64Array.from(next, (x, j) => x + ((tk - 1) / t1) * (x - w[j]));
    w = next;
    tk = t1;
  }
  return w;
}

const predictLinear = (w, D, A) => Float64Array.from({ length: A.n }, (_, r) => sigmoid(logit(w, D, A, r)));

function logLoss(p, y, idx) {
  let s = 0;
  idx.forEach((i, r) => {
    const q = clampP(p[r]);
    s -= y[i] ? Math.log(q) : Math.log(1 - q);
  });
  return s / idx.length;
}

// Pick a penalty on the last three training seasons, then refit on all of them.
function tuned(fit, predict, grid, ds, train) {
  const seasons = [...new Set(Array.from(train, (i) => ds.season[i]))].sort((a, b) => a - b);
  const cut = seasons[Math.max(1, seasons.length - 3)];
  const inner = train.filter((i) => ds.season[i] < cut);
  const val = train.filter((i) => ds.season[i] >= cut);
  let best = grid[0];
  let bestLoss = Infinity;
  for (const lam of grid) {
    const loss = logLoss(predict(fit(inner, lam), val), ds.y, val);
    if (loss < bestLoss) {
      bestLoss = loss;
      best = lam;
    }
  }
  return { lambda: best, model: fit(train, best) };
}

function ridgeModel(getX, grid) {
  return (ds, train) => {
    const { X, D } = getX(ds);
    const fit = (idx, lam) => ridgeFit(csr(X, D, idx), D, Uint8Array.from(idx, (i) => ds.y[i]), lam);
    const predict = (w, idx) => predictLinear(w, D, csr(X, D, idx));
    const { lambda, model } = grid.length > 1 ? tuned(fit, predict, grid, ds, train) : { lambda: grid[0], model: fit(train, grid[0]) };
    return { lambda, predict: (test) => predict(model, test), weights: model };
  };
}

function lassoModel(getX, grid) {
  return (ds, train) => {
    const { X, D } = getX(ds);
    const fit = (idx, lam) => lassoFit(csr(X, D, idx), D, Uint8Array.from(idx, (i) => ds.y[i]), lam);
    const predict = (w, idx) => predictLinear(w, D, csr(X, D, idx));
    const { lambda, model } = tuned(fit, predict, grid, ds, train);
    return { lambda, predict: (test) => predict(model, test), kept: Array.from(model.subarray(0, D)).filter((x) => x !== 0).length };
  };
}

// Separate ridge models per team, penalty tuned on all teams together.
function perTeamModel(grid) {
  return (ds, train) => {
    const { X, D } = ds.X.labLattice;
    const byTeam = (idx) => ds.teams.map((_, t) => idx.filter((i) => ds.t[i] === t));
    const fit = (idx, lam) => byTeam(idx).map((rows) => (rows.length ? ridgeFit(csr(X, D, rows), D, Uint8Array.from(rows, (i) => ds.y[i]), lam) : null));
    const predict = (ws, idx) => {
      const out = new Float64Array(idx.length);
      idx.forEach((i, r) => {
        const w = ws[ds.t[i]];
        if (!w) return (out[r] = 0.5);
        let z = w[D];
        for (let j = 0; j < D; j++) z += w[j] * X[i * D + j];
        out[r] = sigmoid(z);
      });
      return out;
    };
    const { lambda, model } = tuned(fit, predict, grid, ds, train);
    return { lambda, predict: (test) => predict(model, test) };
  };
}

// Naive Bayes over binned inputs, with a Platt rescaling of its (overconfident) score.
function naiveBayes(ds, train) {
  const { X, D } = ds.X.labLattice;
  const bins = Array.from({ length: D }, (_, j) => [...new Set(train.map((i) => X[i * D + j]))].sort((a, b) => a - b));
  const code = (i, j) => {
    const b = bins[j];
    const v = X[i * D + j];
    let k = b.indexOf(v);
    if (k < 0) k = b.findIndex((x) => x > v);
    return k < 0 ? b.length : k;
  };
  const counts = bins.map((b) => [new Float64Array(b.length + 1), new Float64Array(b.length + 1)]);
  const cls = [0, 0];
  for (const i of train) {
    cls[ds.y[i]]++;
    for (let j = 0; j < D; j++) counts[j][ds.y[i]][code(i, j)]++;
  }
  const score = (i) => {
    let s = Math.log((cls[1] + 1) / (cls[0] + 1));
    for (let j = 0; j < D; j++) {
      const k = code(i, j);
      const K = counts[j][0].length;
      s += Math.log((counts[j][1][k] + 1) / (cls[1] + K)) - Math.log((counts[j][0][k] + 1) / (cls[0] + K));
    }
    return s;
  };
  const trainScores = Float64Array.from(train, score);
  const one = { n: train.length, ptr: Int32Array.from({ length: train.length + 1 }, (_, r) => r), col: new Int32Array(train.length), val: trainScores };
  const w = ridgeFit(one, 1, Uint8Array.from(train, (i) => ds.y[i]), 1e-6);
  return { predict: (test) => Float64Array.from(test, (i) => sigmoid(w[1] + w[0] * score(i))) };
}

// Random forest: bootstrap samples, Gini splits on binned inputs, sqrt(D)
// candidate inputs per split, depth <= 8, leaves of >= 40 games.
function randomForest(ds, train, { trees = 100, maxDepth = 8, minLeaf = 40, seed = 1 } = {}) {
  const { X, D } = ds.X.labLattice;
  const mtry = Math.max(1, Math.round(Math.sqrt(D)));
  const rand = mulberry32(hashSeed('forest', seed, train.length));
  const cuts = Array.from({ length: D }, (_, j) => {
    const vals = [...new Set(train.map((i) => X[i * D + j]))].sort((a, b) => a - b);
    if (vals.length <= 16) return vals.slice(0, -1).map((v, k) => (v + vals[k + 1]) / 2);
    const sorted = train.map((i) => X[i * D + j]).sort((a, b) => a - b);
    return [...new Set(Array.from({ length: 15 }, (_, k) => sorted[Math.floor(((k + 1) * sorted.length) / 16)]))];
  });
  const binOf = (i, j) => {
    const c = cuts[j];
    let k = 0;
    while (k < c.length && X[i * D + j] > c[k]) k++;
    return k;
  };
  const B = new Uint8Array(ds.n * D);
  for (const i of train) for (let j = 0; j < D; j++) B[i * D + j] = binOf(i, j);
  const forest = [];
  for (let tr = 0; tr < trees; tr++) {
    const sample = Int32Array.from(train, () => train[Math.floor(rand() * train.length)]);
    const nodes = [];
    const grow = (idx, depth) => {
      let pos = 0;
      for (const i of idx) pos += ds.y[i];
      const id = nodes.length;
      nodes.push({ leaf: (pos + 1) / (idx.length + 2) });
      if (depth >= maxDepth || idx.length < 2 * minLeaf || pos === 0 || pos === idx.length) return id;
      const parentGini = idx.length - (pos * pos + (idx.length - pos) ** 2) / idx.length;
      let best = null;
      const feats = new Set();
      while (feats.size < mtry) feats.add(Math.floor(rand() * D));
      for (const j of feats) {
        const nb = cuts[j].length + 1;
        if (nb < 2) continue;
        const n = new Float64Array(nb);
        const p = new Float64Array(nb);
        for (const i of idx) {
          const b = B[i * D + j];
          n[b]++;
          p[b] += ds.y[i];
        }
        let nl = 0;
        let pl = 0;
        for (let b = 0; b < nb - 1; b++) {
          nl += n[b];
          pl += p[b];
          const nr = idx.length - nl;
          const pr = pos - pl;
          if (nl < minLeaf || nr < minLeaf) continue;
          const gini = nl - (pl * pl + (nl - pl) ** 2) / nl + nr - (pr * pr + (nr - pr) ** 2) / nr;
          if (!best || gini < best.gini) best = { gini, j, b };
        }
      }
      if (!best || best.gini >= parentGini - 1e-9) return id;
      const left = [];
      const right = [];
      for (const i of idx) (B[i * D + best.j] <= best.b ? left : right).push(i);
      nodes[id] = { j: best.j, cut: cuts[best.j][best.b], left: grow(left, depth + 1), right: grow(right, depth + 1) };
      return id;
    };
    grow(Array.from(sample), 0);
    forest.push(nodes);
  }
  return {
    predict: (test) =>
      Float64Array.from(test, (i) => {
        let s = 0;
        for (const nodes of forest) {
          let k = 0;
          while (nodes[k].leaf === undefined) k = X[i * D + nodes[k].j] <= nodes[k].cut ? nodes[k].left : nodes[k].right;
          s += nodes[k].leaf;
        }
        return s / forest.length;
      }),
  };
}

function neuralNet(ds, train) {
  const { X, D } = ds.X.labLattice;
  const net = trainEnsemble(X, D, ds.y, train, { hidden: 16 }, [1, 2, 3]);
  return { predict: (test) => net.predict(X, test) };
}

// Pattern matcher: win rate after the same recent results (5 back), the same
// gap and weekday, for this team -- each level shrunk toward the coarser one.
function patternMatcher(ds, train, { m = 20 } = {}) {
  const levels = (i) => {
    const c = ds.ctx[i];
    const keys = [''];
    for (let k = 1; k <= c.last.length; k++) keys.push(`h${c.last.slice(0, k)}`);
    const h = `h${c.last}`;
    keys.push(`${h}|g${c.gap}`, `${h}|g${c.gap}|w${c.wd}`, `t${ds.t[i]}|${h}|g${c.gap}|w${c.wd}`);
    return keys;
  };
  const table = new Map();
  for (const i of train) {
    for (const key of levels(i)) {
      const e = table.get(key) ?? { n: 0, w: 0 };
      e.n++;
      e.w += ds.y[i];
      table.set(key, e);
    }
  }
  return {
    predict: (test) =>
      Float64Array.from(test, (i) => {
        let p = 0.5;
        for (const key of levels(i)) {
          const e = table.get(key);
          if (e) p = (e.w + m * p) / (e.n + m);
        }
        return p;
      }),
  };
}

const RIDGE_GRID = [0.3, 3, 30, 300, 3000];
const LASSO_GRID = [0.0003, 0.001, 0.003, 0.01, 0.03];

export const ML_MODELS = [
  { key: 'coin', label: 'Coin flip', group: 'baseline', fit: () => ({ predict: (test) => new Float64Array(test.length).fill(0.5) }) },
  { key: 'market', label: 'Point spread', group: 'baseline', fit: ridgeModel((ds) => ds.X.labMarket, [1e-3]) },
  { key: 'form', label: 'Season form (record so far, last season)', group: 'baseline', fit: ridgeModel((ds) => ds.X.labForm, [1e-3]) },
  { key: 'ridge', label: 'Lattice: ridge logistic', group: 'lattice', fit: ridgeModel((ds) => ds.X.labLattice, RIDGE_GRID) },
  { key: 'lasso', label: 'Lattice: lasso logistic', group: 'lattice', fit: lassoModel((ds) => ds.X.labLattice, LASSO_GRID) },
  { key: 'bayes', label: 'Lattice: naive Bayes', group: 'lattice', fit: naiveBayes },
  { key: 'forest', label: 'Lattice: random forest', group: 'lattice', fit: randomForest },
  { key: 'net', label: 'Lattice: neural network', group: 'lattice', fit: neuralNet },
  { key: 'pattern', label: 'Lattice: pattern matcher', group: 'lattice', fit: patternMatcher },
  { key: 'teamOneHot', label: 'Lattice + team identity', group: 'team', fit: ridgeModel(withTeams, RIDGE_GRID) },
  { key: 'perTeam', label: 'Lattice, separate model per team', group: 'team', fit: perTeamModel(RIDGE_GRID) },
  { key: 'marketForm', label: 'Spread + season form', group: 'market', fit: ridgeModel((ds) => ds.X.labMarketForm, [1e-3]) },
  { key: 'marketLattice', label: 'Spread + lattice', group: 'market', fit: ridgeModel((ds) => ds.X.labMarketLattice, RIDGE_GRID) },
];

// ---- evaluation --------------------------------------------------------------
function scores(p, ds, idx) {
  let correct = 0;
  let ll = 0;
  let brier = 0;
  idx.forEach((i, r) => {
    const q = clampP(p[r]);
    const y = ds.y[i];
    correct += q === 0.5 ? 0.5 : (q > 0.5) === (y === 1) ? 1 : 0;
    ll -= y ? Math.log(q) : Math.log(1 - q);
    brier += (q - y) ** 2;
  });
  return { n: idx.length, accuracy: correct / idx.length, logLoss: ll / idx.length, brier: brier / idx.length };
}

// Season-block bootstrap of the log-loss difference to the point spread.
function vsMarket(pModel, pMarket, ds, idx, reps = 4000) {
  const bySeason = new Map();
  idx.forEach((i, r) => {
    const y = ds.y[i];
    const d = -Math.log(clampP(y ? pModel[r] : 1 - pModel[r])) + Math.log(clampP(y ? pMarket[r] : 1 - pMarket[r]));
    const e = bySeason.get(ds.season[i]) ?? { d: 0, n: 0 };
    e.d += d;
    e.n++;
    bySeason.set(ds.season[i], e);
  });
  const seasons = [...bySeason.values()];
  const total = seasons.reduce((s, e) => s + e.d, 0) / idx.length;
  const rand = mulberry32(hashSeed('ml-boot'));
  const boot = [];
  for (let b = 0; b < reps; b++) {
    let d = 0;
    let n = 0;
    for (let k = 0; k < seasons.length; k++) {
      const e = seasons[Math.floor(rand() * seasons.length)];
      d += e.d;
      n += e.n;
    }
    boot.push(d / n);
  }
  return {
    dLogLoss: total,
    ci: [quantile(boot, 0.025), quantile(boot, 0.975)],
    pBetter: boot.filter((x) => x < 0).length / reps, // share of resamples where the model beats the spread
    seasonsBetter: seasons.filter((e) => e.d < 0).length,
    seasons: seasons.length,
  };
}

export function walkForward(ds, models = ML_MODELS, { blocks = BLOCKS, onModel } = {}) {
  const preds = Object.fromEntries(models.map((m) => [m.key, new Float64Array(ds.n).fill(NaN)]));
  const info = Object.fromEntries(models.map((m) => [m.key, []]));
  const all = Int32Array.from({ length: ds.n }, (_, i) => i);
  for (const [a, b] of blocks) {
    const train = Array.from(all.filter((i) => ds.season[i] < a));
    const test = Array.from(all.filter((i) => ds.season[i] >= a && ds.season[i] <= b));
    for (const m of models) {
      const t0 = performance.now();
      const fitted = m.fit(ds, train);
      const p = fitted.predict(test);
      test.forEach((i, r) => (preds[m.key][i] = p[r]));
      info[m.key].push({ block: `${a}-${b}`, lambda: fitted.lambda ?? null, kept: fitted.kept ?? null, seconds: (performance.now() - t0) / 1000 });
      onModel?.(m.key, a);
    }
  }
  return { preds, info };
}

export function evaluate(ds, { preds, info }, models = ML_MODELS, { blocks = BLOCKS } = {}) {
  const inBlock = ([a, b]) => Array.from({ length: ds.n }, (_, i) => i).filter((i) => ds.season[i] >= a && ds.season[i] <= b);
  const test = inBlock([blocks[0][0], blocks[blocks.length - 1][1]]);
  const pick = (key, idx) => Float64Array.from(idx, (i) => preds[key][i]);
  return models.map((m) => ({
    key: m.key,
    label: m.label,
    group: m.group,
    overall: scores(pick(m.key, test), ds, test),
    blocks: blocks.map((bl) => ({ block: `${bl[0]}-${bl[1]}`, ...scores(pick(m.key, inBlock(bl)), ds, inBlock(bl)) })),
    vsMarket: m.key === 'market' || !preds.market ? null : vsMarket(pick(m.key, test), pick('market', test), ds, test),
    fits: info[m.key],
  }));
}

// Do the lattice models learn anything from the ORDER of results? Refit them
// on histories where each season's results are shuffled (records kept) and
// compare accuracy and log loss with the real history.
export function orderNullCheck(games, { reps = 20, models = ['ridge', 'pattern'], lambdas = null } = {}) {
  const teams = allTeams(games);
  const schedules = teams.map((t) => teamSchedule(games, t));
  const chosen = ML_MODELS.filter((m) => models.includes(m.key));
  const runs = [];
  for (let rep = 1; rep <= reps; rep++) {
    const results = schedules.map((seq, t) =>
      shuffleWithinSeason(seq, seq.map((g) => g.result), mulberry32(hashSeed('ml-null', rep, t))),
    );
    const ds = buildDataset(games, { results, sets: ['labLattice'] });
    const fixed = chosen.map((m) =>
      m.key === 'ridge' && lambdas ? { ...m, fit: ridgeModel((d) => d.X.labLattice, [lambdas.ridge]) } : m,
    );
    const wf = walkForward(ds, fixed);
    const ev = evaluate(ds, wf, fixed.map((m) => ({ ...m })), {}).map((e) => ({ key: e.key, accuracy: e.overall.accuracy, logLoss: e.overall.logLoss }));
    runs.push(ev);
  }
  return Object.fromEntries(
    chosen.map((m) => {
      const acc = runs.map((r) => r.find((e) => e.key === m.key).accuracy);
      const ll = runs.map((r) => r.find((e) => e.key === m.key).logLoss);
      return [m.key, { accuracy: { mean: mean(acc), q05: quantile(acc, 0.05), q95: quantile(acc, 0.95), values: acc }, logLoss: { mean: mean(ll), q05: quantile(ll, 0.05), q95: quantile(ll, 0.95), values: ll } }];
    }),
  );
}
