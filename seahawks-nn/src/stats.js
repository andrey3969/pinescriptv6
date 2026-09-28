export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

export function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// Wilson score interval for k successes in n trials.
export function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const LOG_FACT = [0];
function logFact(n) {
  for (let i = LOG_FACT.length; i <= n; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
  return LOG_FACT[n];
}

export function binomPmf(k, n, p) {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(logFact(n) - logFact(k) - logFact(n - k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}

// P(X >= k)
export function binomUpper(k, n, p) {
  let s = 0;
  for (let i = Math.max(0, k); i <= n; i++) s += binomPmf(i, n, p);
  return Math.min(1, s);
}

// P(X <= k)
export function binomLower(k, n, p) {
  let s = 0;
  for (let i = 0; i <= Math.min(k, n); i++) s += binomPmf(i, n, p);
  return Math.min(1, s);
}

export function binomTwoSided(k, n, p = 0.5) {
  if (!n) return 1;
  return Math.min(1, 2 * Math.min(binomUpper(k, n, p), binomLower(k, n, p)));
}

// Benjamini-Hochberg false-discovery-rate adjusted p-values (q-values).
export function benjaminiHochberg(pvals) {
  const m = pvals.length;
  const order = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const q = new Array(m);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    const [p, i] = order[r];
    running = Math.min(running, (p * m) / (r + 1));
    q[i] = running;
  }
  return q;
}

// Exact McNemar test on the discordant pairs of two classifiers.
export const mcnemar = (onlyA, onlyB) => binomTwoSided(Math.min(onlyA, onlyB), onlyA + onlyB, 0.5);

// Empirical p-value with the +1 correction (never reports exactly 0).
export const empiricalP = (nullValues, isAsExtreme) =>
  (1 + nullValues.filter(isAsExtreme).length) / (1 + nullValues.length);
