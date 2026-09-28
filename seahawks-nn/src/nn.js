// Dependency-free feed-forward neural network: inputs -> tanh hidden layer
// -> sigmoid output, trained full-batch with Adam, L2 weight decay and early
// stopping on a random validation slice. hidden = 0 is logistic regression.
import { mulberry32, shuffleInPlace } from './rng.js';

// Fixed before any out-of-sample evaluation; not tuned on test seasons.
export const NET_DEFAULTS = {
  hidden: 16,
  l2: 1e-2,
  lr: 0.01,
  maxEpochs: 400,
  patience: 30,
  valFrac: 0.2,
};

const EPS = 1e-7;
const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

// Compressed sparse rows: most lag inputs are 0 on any given game.
function sparseRows(X, D, rows) {
  const ptr = new Int32Array(rows.length + 1);
  const col = [];
  const val = [];
  rows.forEach((i, r) => {
    for (let j = 0; j < D; j++) {
      const v = X[i * D + j];
      if (v !== 0) {
        col.push(j);
        val.push(v);
      }
    }
    ptr[r + 1] = col.length;
  });
  return { n: rows.length, ptr, col: Int32Array.from(col), val: Float64Array.from(val) };
}

// Parameter layout: [W1 (H*D) | b1 (H) | W2 (H) | b2]  or, for H = 0, [w (D) | b].
function initParams(D, H, rand) {
  const size = H ? H * D + 2 * H + 1 : D + 1;
  const params = new Float64Array(size);
  const decay = new Uint8Array(size);
  if (!H) {
    decay.fill(1, 0, D);
    return { params, decay };
  }
  const a1 = Math.sqrt(6 / (D + H));
  const a2 = Math.sqrt(6 / (H + 1));
  for (let k = 0; k < H * D; k++) params[k] = (2 * rand() - 1) * a1;
  decay.fill(1, 0, H * D);
  const w2 = H * D + H;
  for (let h = 0; h < H; h++) params[w2 + h] = (2 * rand() - 1) * a2;
  decay.fill(1, w2, w2 + H);
  return { params, decay };
}

function logit(D, H, params, data, r, act) {
  const { ptr, col, val } = data;
  const s = ptr[r];
  const e = ptr[r + 1];
  if (!H) {
    let z = params[D];
    for (let q = s; q < e; q++) z += params[col[q]] * val[q];
    return z;
  }
  const b1 = H * D;
  const w2 = b1 + H;
  let o = params[w2 + H];
  for (let h = 0; h < H; h++) {
    const off = h * D;
    let z = params[b1 + h];
    for (let q = s; q < e; q++) z += params[off + col[q]] * val[q];
    const a = Math.tanh(z);
    act[h] = a;
    o += params[w2 + h] * a;
  }
  return o;
}

// Accumulate d(loss)/d(params) for one row, given g = d(loss)/d(logit).
function backprop(D, H, params, grad, data, r, act, g) {
  const { ptr, col, val } = data;
  const s = ptr[r];
  const e = ptr[r + 1];
  if (!H) {
    grad[D] += g;
    for (let q = s; q < e; q++) grad[col[q]] += g * val[q];
    return;
  }
  const b1 = H * D;
  const w2 = b1 + H;
  grad[w2 + H] += g;
  for (let h = 0; h < H; h++) {
    const a = act[h];
    grad[w2 + h] += g * a;
    const gh = g * params[w2 + h] * (1 - a * a);
    grad[b1 + h] += gh;
    const off = h * D;
    for (let q = s; q < e; q++) grad[off + col[q]] += gh * val[q];
  }
}

function meanLogLoss(D, H, params, data, y, act) {
  let loss = 0;
  for (let r = 0; r < data.n; r++) {
    const p = Math.min(1 - EPS, Math.max(EPS, sigmoid(logit(D, H, params, data, r, act))));
    loss -= y[r] ? Math.log(p) : Math.log(1 - p);
  }
  return loss / data.n;
}

// X: dense row-major Float64Array (n x D); y01[i] in {0,1}; rows: training row indices.
export function trainNet(X, D, y01, rows, options = {}) {
  const o = { ...NET_DEFAULTS, ...options };
  const H = o.hidden;
  const rand = mulberry32(o.seed ?? 1);
  const shuffled = shuffleInPlace(rows.slice(), rand);
  const nVal = o.valFrac > 0 && rows.length >= 20 ? Math.round(rows.length * o.valFrac) : 0;
  const fitRows = shuffled.slice(nVal);
  const valRows = shuffled.slice(0, nVal);
  const fit = sparseRows(X, D, fitRows);
  const val = nVal ? sparseRows(X, D, valRows) : null;
  const yFit = Uint8Array.from(fitRows, (i) => y01[i]);
  const yVal = Uint8Array.from(valRows, (i) => y01[i]);

  const { params, decay } = initParams(D, H, rand);
  const grad = new Float64Array(params.length);
  const m = new Float64Array(params.length);
  const v = new Float64Array(params.length);
  const act = new Float64Array(Math.max(1, H));
  const best = params.slice();
  let bestLoss = Infinity;
  let bestEpoch = 0;
  let epoch = 0;
  const beta1 = 0.9;
  const beta2 = 0.999;

  while (++epoch <= o.maxEpochs) {
    grad.fill(0);
    for (let r = 0; r < fit.n; r++) {
      const p = sigmoid(logit(D, H, params, fit, r, act));
      backprop(D, H, params, grad, fit, r, act, (p - yFit[r]) / fit.n);
    }
    const c1 = 1 - beta1 ** epoch;
    const c2 = 1 - beta2 ** epoch;
    for (let k = 0; k < params.length; k++) {
      const gk = grad[k] + (decay[k] ? o.l2 * params[k] : 0);
      m[k] = beta1 * m[k] + (1 - beta1) * gk;
      v[k] = beta2 * v[k] + (1 - beta2) * gk * gk;
      params[k] -= (o.lr * (m[k] / c1)) / (Math.sqrt(v[k] / c2) + 1e-8);
    }
    if (!val) continue;
    const loss = meanLogLoss(D, H, params, val, yVal, act);
    if (loss < bestLoss - 1e-6) {
      bestLoss = loss;
      bestEpoch = epoch;
      best.set(params);
    } else if (epoch - bestEpoch >= o.patience) break;
  }
  if (val) params.set(best);

  return {
    epochs: val ? bestEpoch : o.maxEpochs,
    params,
    predict(Xp, predictRows) {
      const data = sparseRows(Xp, D, predictRows);
      return Float64Array.from(predictRows, (_, r) => sigmoid(logit(D, H, params, data, r, act)));
    },
  };
}

// Average of several independently initialised nets (different seeds and
// validation slices) -- steadier than any single small net.
export function trainEnsemble(X, D, y01, rows, options = {}, seeds = [1, 2, 3, 4, 5]) {
  const nets = seeds.map((seed) => trainNet(X, D, y01, rows, { ...options, seed }));
  return {
    nets,
    predict(Xp, predictRows) {
      const out = new Float64Array(predictRows.length);
      for (const net of nets) {
        const p = net.predict(Xp, predictRows);
        for (let r = 0; r < out.length; r++) out[r] += p[r] / nets.length;
      }
      return out;
    },
  };
}
