// Detailed PDF analysis: builds an HTML document with inline SVG charts from
// the pipeline results and prints it with Playwright's Chromium. Playwright is
// optional; without it the HTML is written and can be printed from a browser.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { TEAM_NAMES, isDecided, loadGames, teamSchedule } from './data.js';
import { ordinal, ruleCall, ruleCases, ruleInputs } from './rules.js';
import { binomTwoSided, binomUpper } from './stats.js';

// Chart tokens (light print). Validated with the dataviz palette validator:
// blue/orange pass all categorical checks on white; the two blue steps pass
// the ordinal checks.
export const C = {
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  accent: '#2a78d6',
  orange: '#eb6834',
  blueLight: '#86b6ef',
  blueDark: '#1c5cab',
  context: '#898781',
  good: '#0ca30c',
  critical: '#d03b3b',
  panel: '#f6f5f1',
  accentSoft: '#eef4fc',
};
export const FONT = `'Liberation Sans', 'DejaVu Sans', Arial, sans-serif`;

// ------------------------------------------------------------------ helpers
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const pct = (x, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : 'n/a');
export const fp = (p) => (p < 0.001 ? '< 0.001' : p < 0.01 ? p.toFixed(3) : p.toFixed(2));
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const wl = (r) => (r === 1 ? 'W' : r === -1 ? 'L' : r === 0 ? 'T' : '–');
const where = (g) => `${g.home === 1 ? 'vs' : g.home === -1 ? 'at' : 'vs'} ${g.opp}`;
const score = (g) => (g.pf === null || g.pf === undefined ? wl(g.result) : `${wl(g.result)} ${g.pf}–${g.pa}`);
const longDate = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const n1 = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const ratio = (x) => (x && x.n ? `${x.hits}/${x.n}` : '–');

// Tables up to 16 rows are kept on one page; longer ones break with a repeated header.
export function table(headers, rows, { num = [], cls = '' } = {}) {
  const th = headers.map((h, k) => `<th${num.includes(k) ? ' class="num"' : ''}>${h}</th>`).join('');
  const body = rows
    .map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ''}>${(r.cells ?? r).map((c, k) => `<td${num.includes(k) ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="${cls}${rows.length <= 16 ? ' keep' : ''}"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

// ------------------------------------------------------------------ SVG kit
export const svg = (w, h, body, label) =>
  `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg" style="font-family:${FONT}">${body}</svg>`;
// halo: a surface-colored outline so a label stays legible where it crosses a line.
export const text = (x, y, s, { size = 10.5, fill = C.ink2, anchor = 'start', weight = 400, halo = false } = {}) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}"${
    halo ? ' stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke"' : ''
  }>${esc(s)}</text>`;
export const line = (x1, y1, x2, y2, stroke, width = 1) =>
  `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`;
export const dot = (cx, cy, r, fill) => `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${fill}" stroke="#ffffff" stroke-width="2"/>`;
// Column with a 4px rounded data end and a square baseline.
export function column(x, yTop, w, yBase, fill, r = 4) {
  const h = yBase - yTop;
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `<path d="M${x.toFixed(1)},${yBase.toFixed(1)} V${(yTop + rr).toFixed(1)} Q${x.toFixed(1)},${yTop.toFixed(1)} ${(x + rr).toFixed(1)},${yTop.toFixed(1)} H${(x + w - rr).toFixed(1)} Q${(x + w).toFixed(1)},${yTop.toFixed(1)} ${(x + w).toFixed(1)},${(yTop + rr).toFixed(1)} V${yBase.toFixed(1)} Z" fill="${fill}"/>`;
}
export const ICON_OK = `<svg class="ic" viewBox="0 0 12 12" aria-label="hit"><circle cx="6" cy="6" r="6" fill="${C.good}"/><path d="M3.2 6.2 L5.2 8.1 L8.9 4.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const ICON_MISS = `<svg class="ic" viewBox="0 0 12 12" aria-label="miss"><circle cx="6" cy="6" r="6" fill="${C.critical}"/><path d="M4 4 L8 8 M8 4 L4 8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const NO_CALL = `<span class="nocall" aria-label="no call">–</span>`;

// Figure 1: out-of-sample accuracy with 95% ranges; the hypothesis model highlighted.
const WF_ORDER = ['vegas', 'nn_conventional', 'nn_all', 'always_win', 'home', 'season_form', 'lr_lattice', 'nn_sequence', 'nn_lattice', 'repeat_last'];

function figAccuracy(R, team) {
  const m = R.walkForward.metrics;
  const keys = WF_ORDER.filter((k) => m[k]);
  const label = (k) => (k === 'always_win' ? `Always pick ${team}` : R.labels[k]);
  const W = 640;
  const rowH = 25;
  const top = 40;
  const left = 262;
  const right = 600;
  const H = top + keys.length * rowH + 30;
  const lo = 0.4;
  const hi = 0.8;
  const x = (v) => left + ((v - lo) / (hi - lo)) * (right - left);
  let b = '';
  for (let v = lo; v <= hi + 1e-9; v += 0.1) {
    b += line(x(v), top - 8, x(v), H - 26, C.grid);
    b += text(x(v), H - 10, pct(v, 0), { anchor: 'middle', size: 10, fill: C.muted });
  }
  const base = m.always_win.accuracy;
  b += line(x(base), top - 14, x(base), H - 26, C.ink2, 1);
  b += text(x(base) + 5, top - 16, `Always pick ${team}: ${pct(base)}`, { size: 10, fill: C.ink2 });
  b += text(x(0.5), top - 16, 'Coin flip', { anchor: 'middle', size: 10, fill: C.muted });
  keys.forEach((k, i) => {
    const cy = top + i * rowH + rowH / 2;
    const hl = k === 'nn_lattice';
    const col = hl ? C.accent : C.context;
    b += text(left - 14, cy + 3.8, label(k), { anchor: 'end', size: 10.5, fill: hl ? C.ink : C.ink2, weight: hl ? 700 : 400 });
    b += line(x(m[k].ci[0]), cy, x(m[k].ci[1]), cy, col, 2);
    b += dot(x(m[k].accuracy), cy, 5, col);
    b += text(x(m[k].ci[1]) + 8, cy + 3.8, pct(m[k].accuracy), { size: 10, fill: hl ? C.ink : C.ink2, weight: hl ? 700 : 400, halo: true });
  });
  return svg(W, H, b, 'Out-of-sample accuracy by model with 95% ranges');
}

// Figure 2: one histogram panel of a shuffled distribution with the real value marked.
function histPanel({ values, real, x0, x1, top, bottom, step, fmt, title, better }) {
  const lo = Math.floor(Math.min(...values, real) / step) * step;
  const hi = Math.ceil(Math.max(...values, real) / step + 1e-9) * step;
  const nb = Math.max(1, Math.round((hi - lo) / step));
  const counts = new Array(nb).fill(0);
  for (const v of values) counts[Math.min(nb - 1, Math.floor((v - lo) / step + 1e-9))]++;
  const maxC = Math.max(...counts);
  const yMax = Math.ceil(maxC / 10) * 10;
  const x = (v) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0);
  const y = (c) => bottom - (c / yMax) * (bottom - top);
  let b = '';
  for (let c = 0; c <= yMax; c += yMax / 2) {
    b += line(x0, y(c), x1, y(c), C.grid);
    b += text(x0 - 6, y(c) + 3.5, String(c), { anchor: 'end', size: 9.5, fill: C.muted });
  }
  const bw = (x1 - x0) / nb;
  counts.forEach((c, i) => {
    b += column(x0 + i * bw + 1, y(c), bw - 2, bottom, C.accent, 3);
  });
  b += line(x0, bottom, x1, bottom, C.axis);
  b += text(x(lo), bottom + 14, fmt(lo), { anchor: 'start', size: 9.5, fill: C.muted });
  b += text(x((lo + hi) / 2), bottom + 14, fmt((lo + hi) / 2), { anchor: 'middle', size: 9.5, fill: C.muted });
  b += text(x(hi), bottom + 14, fmt(hi), { anchor: 'end', size: 9.5, fill: C.muted });
  b += line(x(real), top - 6, x(real), bottom, C.ink, 1.5);
  const rightSide = x(real) < (x0 + x1) / 2;
  b += text(x(real) + (rightSide ? 5 : -5), top + 4, `Real order: ${fmt(real)}`, {
    anchor: rightSide ? 'start' : 'end',
    size: 10,
    fill: C.ink,
    weight: 700,
    halo: true,
  });
  b += text(x0, top - 16, title, { size: 10.5, fill: C.ink, weight: 700 });
  b += text(x1, top - 16, better, { anchor: 'end', size: 9.5, fill: C.muted });
  return b;
}

function figShuffle(R) {
  const s = R.permutation.models.nn_lattice;
  const W = 640;
  const H = 230;
  let b = '';
  b += histPanel({
    values: s.nullAccuracyValues,
    real: s.real.accuracy,
    x0: 40,
    x1: 296,
    top: 36,
    bottom: 186,
    step: 0.01,
    fmt: (v) => pct(v),
    title: 'Accuracy',
    better: 'higher is better',
  });
  b += histPanel({
    values: s.nullLogLossValues,
    real: s.real.logLoss,
    x0: 368,
    x1: 624,
    top: 36,
    bottom: 186,
    step: 0.004,
    fmt: (v) => v.toFixed(3),
    title: 'Log-loss',
    better: 'lower is better',
  });
  b += text(W / 2, H - 6, `Each bar counts shuffled histories (of ${s.nullAccuracyValues.length}); the black line is the real order.`, {
    anchor: 'middle',
    size: 9.5,
    fill: C.muted,
  });
  return svg(W, H, b, 'Shuffle test distributions for the results + timing network');
}

// Figure 3: share of shuffled histories whose best rule is at least as strong as x.
function figSearch(R) {
  const nm = R.scan.nullMinP;
  const [oAny, oSame] = R.scan.order.focus;
  const W = 640;
  const H = 320;
  const left = 58;
  const right = 612;
  const top = 30;
  const bottom = 262;
  const lmin = -4;
  const lmax = 0;
  const x = (p) => left + ((Math.log10(Math.max(p, 10 ** lmin)) - lmin) / (lmax - lmin)) * (right - left);
  const y = (f) => bottom - f * (bottom - top);
  const cdf = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return (p) => {
      let lo = 0;
      let hi = s.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s[mid] <= p * (1 + 1e-9)) lo = mid + 1;
        else hi = mid;
      }
      return lo / s.length;
    };
  };
  const cal = cdf(nm.calendar);
  const both = cdf(nm.both);
  let b = '';
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    b += line(left, y(f), right, y(f), C.grid);
    b += text(left - 8, y(f) + 3.5, pct(f, 0), { anchor: 'end', size: 10, fill: C.muted });
  }
  for (const [p, lab] of [[1e-4, '0.0001'], [1e-3, '0.001'], [1e-2, '0.01'], [0.1, '0.1'], [1, '1']]) {
    b += line(x(p), bottom, x(p), bottom + 4, C.axis);
    b += text(x(p), bottom + 16, lab, { anchor: 'middle', size: 10, fill: C.muted });
  }
  b += line(left, bottom, right, bottom, C.axis);
  const path = (f) => {
    const pts = [];
    for (let i = 0; i <= 400; i++) {
      const p = 10 ** (lmin + ((lmax - lmin) * i) / 400);
      pts.push(`${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(f(p)).toFixed(1)}`);
    }
    return pts.join(' ');
  };
  b += `<path d="${path(cal)}" fill="none" stroke="${C.orange}" stroke-width="2" stroke-linejoin="round"/>`;
  b += `<path d="${path(both)}" fill="none" stroke="${C.accent}" stroke-width="2" stroke-linejoin="round"/>`;
  // Legend in the empty lower-right corner (curves sit near 100% there),
  // plus direct labels beside each marker, on the side away from the curves.
  const lx = right - 250;
  const ly = y(0.2);
  b += line(lx, ly, lx + 20, ly, C.orange, 2);
  b += text(lx + 26, ly + 4, `Calendar rules only (${R.scan.rulesTested} rules)`, { size: 10, fill: C.ink2 });
  b += line(lx, ly + 18, lx + 20, ly + 18, C.accent, 2);
  b += text(lx + 26, ly + 22, `Calendar + game-order rules (${R.scan.combinedRules} rules)`, { size: 10, fill: C.ink2 });
  const marks = [
    { p: R.scan.focus.p, f: cal(R.scan.focus.p), col: C.orange, lab: `28/10 rule, ${R.scan.focus.hits}/${R.scan.focus.n}`, dx: 10, dy: 18, anchor: 'start' },
    { p: oSame.p, f: both(oSame.p), col: C.accent, lab: `10-day rule, same season, ${oSame.hits}/${oSame.n}`, dx: -10, dy: -9, anchor: 'end' },
    { p: oAny.p, f: both(oAny.p), col: C.accent, lab: `10-day rule as written, ${oAny.hits}/${oAny.n}`, dx: -10, dy: -8, anchor: 'end' },
  ];
  for (const mk of marks) {
    b += dot(x(mk.p), y(mk.f), 5, mk.col);
    b += text(x(mk.p) + mk.dx, y(mk.f) + mk.dy, `${mk.lab}: ${pct(mk.f, 0)}`, { anchor: mk.anchor, size: 10, fill: C.ink, weight: 700, halo: true });
  }
  b += text((left + right) / 2, H - 22, 'p-value of the best rule found in a history (further left = a more impressive rule)', {
    anchor: 'middle',
    size: 10,
    fill: C.ink2,
  });
  b += text((left + right) / 2, H - 8, 'Height = share of shuffled histories whose best rule is at least that impressive', {
    anchor: 'middle',
    size: 10,
    fill: C.ink2,
  });
  return svg(W, H, b, 'How often shuffled histories contain a rule as strong as the real ones');
}

// Figure 5: back-to-back gaps; the 10-day gap highlighted.
function figGaps(R) {
  const gaps = R.gaps;
  const W = 640;
  const H = 250;
  const left = 44;
  const right = 628;
  const top = 26;
  const bottom = 196;
  const maxN = Math.max(...gaps.map((g) => g.n));
  const yMax = Math.ceil(maxN / 100) * 100;
  const y = (c) => bottom - (c / yMax) * (bottom - top);
  const slot = (right - left) / gaps.length;
  const bw = Math.min(24, slot - 10);
  let b = '';
  for (let c = 0; c <= yMax; c += 100) {
    b += line(left, y(c), right, y(c), C.grid);
    b += text(left - 6, y(c) + 3.5, String(c), { anchor: 'end', size: 10, fill: C.muted });
  }
  gaps.forEach((g, i) => {
    const cx = left + slot * (i + 0.5);
    const hl = g.gap === 10;
    b += column(cx - bw / 2, y(g.n), bw, bottom, hl ? C.accent : C.context);
    b += text(cx, y(g.n) - 5, String(g.n), { anchor: 'middle', size: 10, fill: hl ? C.ink : C.ink2, weight: hl ? 700 : 400 });
    b += text(cx, bottom + 15, `${g.gap}`, { anchor: 'middle', size: 10.5, fill: C.ink, weight: hl ? 700 : 400 });
    const mv = g.moves[0].move.replace(' -> ', '→');
    b += text(cx, bottom + 29, mv, { anchor: 'middle', size: 8.5, fill: C.muted });
  });
  b += line(left, bottom, right, bottom, C.axis);
  b += text((left + right) / 2, H - 4, 'Days between back-to-back games, with the most common weekday move under each', {
    anchor: 'middle',
    size: 10,
    fill: C.ink2,
  });
  return svg(W, H, b, 'Gaps between back-to-back Seattle games');
}

// Figure 6: each team's best rule, before and after correcting for the search.
function figTeams(R, team) {
  const teams = [...R.teams].filter((t) => t.best).sort((a, b) => a.best.pFamily - b.best.pFamily || a.best.p - b.best.p);
  const W = 640;
  const rowH = 15.5;
  const top = 46;
  const left = 214;
  const right = 612;
  const H = top + teams.length * rowH + 40;
  const lmin = -4;
  const lmax = 0;
  const x = (p) => left + ((Math.log10(Math.max(p, 10 ** lmin)) - lmin) / (lmax - lmin)) * (right - left);
  let b = '';
  for (const [p, lab] of [[1e-4, '0.0001 or less'], [0.001, '0.001'], [0.01, '0.01'], [0.05, '0.05'], [0.1, '0.1'], [1, '1']]) {
    b += line(x(p), top - 6, x(p), H - 34, p === 0.05 ? C.ink2 : C.grid, 1);
    b += text(x(p), H - 20, lab, { anchor: p === 1e-4 ? 'start' : 'middle', size: 10, fill: p === 0.05 ? C.ink2 : C.muted });
  }
  b += text(x(0.05) + 4, top - 10, '5% level', { size: 9.5, fill: C.ink2 });
  // legend
  b += dot(left + 6, 12, 4.5, C.blueLight);
  b += text(left + 16, 16, 'Best rule on its own', { size: 10, fill: C.ink2 });
  b += dot(left + 160, 12, 4.5, C.blueDark);
  b += text(left + 170, 16, 'Same rule after correcting for the search', { size: 10, fill: C.ink2 });
  teams.forEach((t, i) => {
    const cy = top + i * rowH + rowH / 2;
    const me = t.team === team;
    if (me) b += `<rect x="4" y="${(cy - rowH / 2).toFixed(1)}" width="${W - 8}" height="${rowH}" fill="${C.accentSoft}" rx="3"/>`;
    const lab = `${t.team}  ·  ${t.best.d1} & ${t.best.d2} days  ·  ${t.best.hits}/${t.best.n}`;
    b += text(left - 12, cy + 3.6, lab, { anchor: 'end', size: 9.8, fill: me ? C.ink : C.ink2, weight: me ? 700 : 400 });
    b += line(x(t.best.p), cy, x(t.best.pFamily), cy, C.axis, 2);
    b += dot(x(t.best.p), cy, 4.5, C.blueLight);
    b += dot(x(t.best.pFamily), cy, 4.5, C.blueDark);
  });
  b += text((left + right) / 2, H - 4, 'p-value (log scale; further left = more impressive)', { anchor: 'middle', size: 10, fill: C.ink2 });
  return svg(W, H, b, 'Each team best rule before and after correcting for the search');
}

// Figure 4 (a table): every 10-day game, and which version of the rule calls it.
function tenDayMatrix(seq, from, to, gap = 10) {
  const results = seq.map((g) => g.result);
  const rows = [];
  seq.forEach((g, j) => {
    if (g.season < from || g.season > to || j < 1 || !isDecided(g.result)) return;
    if (g.day - seq[j - 1].day !== gap) return;
    const cells = [];
    for (const sameSeason of [false, true]) {
      for (let k = 2; k <= 8; k++) {
        const inputs = ruleInputs(seq, j, { type: 'order', gap, k, sameSeason });
        const call = ruleCall(results, inputs);
        cells.push(inputs === null ? 'na' : call === null ? 'none' : call === g.result ? 'hit' : 'miss');
      }
    }
    rows.push({ game: g, prev: seq[j - 1], repeated: g.result === seq[j - 1].result, cells });
  });
  return rows;
}

function matrixHtml(rows) {
  const head =
    '<tr><th rowspan="2">Game</th><th rowspan="2">Thursday</th><th rowspan="2">Result</th><th rowspan="2">Repeat?</th>' +
    '<th colspan="7" class="grp">k-th previous game, any season</th><th colspan="7" class="grp split">k-th previous, same season only</th></tr><tr>' +
    [2, 3, 4, 5, 6, 7, 8, 2, 3, 4, 5, 6, 7, 8].map((k, i) => `<th class="k${k === 4 ? ' focus' : ''}${i === 7 ? ' split' : ''}">${ordinal(k)}</th>`).join('') +
    '</tr>';
  const icon = (c) => (c === 'hit' ? ICON_OK : c === 'miss' ? ICON_MISS : c === 'none' ? NO_CALL : '');
  const body = rows
    .map(
      (r) =>
        `<tr><td class="nw">${longDate(r.game.date)} ${where(r.game)}</td><td>${wl(r.prev.result)}</td><td>${wl(r.game.result)}</td>` +
        `<td>${r.repeated ? 'yes' : '<b>no</b>'}</td>` +
        r.cells.map((c, i) => `<td class="k${i % 7 === 2 ? ' focus' : ''}${i === 7 ? ' split' : ''}">${icon(c)}</td>`).join('') +
        '</tr>',
    )
    .join('');
  const totals = Array.from({ length: 14 }, (_, i) => {
    const fired = rows.filter((r) => r.cells[i] === 'hit' || r.cells[i] === 'miss');
    return `${fired.filter((r) => r.cells[i] === 'hit').length}/${fired.length}`;
  });
  const foot =
    `<tr class="tot"><td colspan="4">Hits / calls</td>` +
    totals.map((t, i) => `<td class="k${i % 7 === 2 ? ' focus' : ''}${i === 7 ? ' split' : ''}">${t}</td>`).join('') +
    '</tr>';
  return `<table class="matrix keep"><thead>${head}</thead><tbody>${body}${foot}</tbody></table>`;
}

// Forward-test power: calls needed to tell a 90% rule from the 60% that
// good-seasons-stay-good produces, with a one-sided exact binomial test.
function powerRows(p0, p1, ns, alpha = 0.05) {
  return ns.map((n) => {
    let k = null;
    for (let c = 0; c <= n; c++) {
      if (binomUpper(c, n, p0) <= alpha) {
        k = c;
        break;
      }
    }
    return { n, k, falseAlarm: k === null ? null : binomUpper(k, n, p0), power: k === null ? 0 : binomUpper(k, n, p1) };
  });
}

// ------------------------------------------------------------------ document
export const CSS = `
@page { size: Letter; margin: 0.75in 0.8in 0.8in 0.8in; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: ${FONT}; font-size: 9.8pt; line-height: 1.45; color: ${C.ink}; margin: 0; }
h1 { font-size: 25pt; line-height: 1.12; margin: 6pt 0 10pt; letter-spacing: -0.01em; }
h2 { font-size: 15pt; line-height: 1.2; margin: 0 0 8pt; padding-bottom: 5pt; border-bottom: 1px solid ${C.grid}; break-after: avoid; }
h2 .no { color: ${C.accent}; margin-right: 6pt; }
h3 { font-size: 11pt; margin: 13pt 0 4pt; break-after: avoid; }
p { margin: 0 0 7pt; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 8pt; padding-left: 16pt; }
li { margin-bottom: 3.5pt; }
.page { break-before: page; }
section { margin-bottom: 14pt; }
.kicker { font-size: 9pt; letter-spacing: 0.06em; text-transform: uppercase; color: ${C.accent}; font-weight: 700; }
.lede { font-size: 12pt; line-height: 1.4; color: ${C.ink2}; margin-bottom: 10pt; }
.meta { font-size: 8.5pt; color: ${C.muted}; margin-bottom: 14pt; }
.tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 7pt; margin: 4pt 0 14pt; }
.tile { border: 1px solid ${C.grid}; border-radius: 6px; padding: 7pt 8pt 8pt; }
.tile .label { font-size: 7.8pt; color: ${C.ink2}; line-height: 1.3; min-height: 31pt; }
.tile .value { font-size: 19pt; font-weight: 700; margin: 2pt 0 1pt; }
.tile .note { font-size: 7.2pt; color: ${C.muted}; line-height: 1.3; }
.tile.hl { border-color: ${C.accent}; box-shadow: inset 0 3px 0 ${C.accent}; }
.callout { background: ${C.panel}; border-left: 3px solid ${C.accent}; padding: 8pt 11pt; margin: 8pt 0 11pt; break-inside: avoid; }
.callout p:last-child { margin-bottom: 0; }
.rule { background: ${C.panel}; border-radius: 6px; padding: 7pt 10pt; margin: 6pt 0 10pt; break-inside: avoid; }
.rule b { color: ${C.ink}; }
figure { margin: 8pt 0 12pt; break-inside: avoid; }
figcaption { font-size: 8.4pt; color: ${C.ink2}; margin-top: 5pt; line-height: 1.4; }
figcaption b { color: ${C.ink}; }
table { width: 100%; border-collapse: collapse; font-size: 8.4pt; line-height: 1.35; margin: 5pt 0 11pt; font-variant-numeric: tabular-nums; }
th { text-align: left; font-weight: 700; color: ${C.ink2}; border-bottom: 1px solid ${C.axis}; padding: 3pt 7pt 3pt 0; vertical-align: bottom; }
td { border-bottom: 1px solid ${C.grid}; padding: 2.6pt 7pt 2.6pt 0; vertical-align: top; }
th.num, td.num { text-align: right; }
tr { break-inside: avoid; }
table.keep { break-inside: avoid; }
thead { display: table-header-group; }
td.nw { white-space: nowrap; }
tr.hl td { background: ${C.accentSoft}; font-weight: 700; }
.tcap { font-size: 8.4pt; color: ${C.ink2}; margin: 10pt 0 2pt; break-after: avoid; }
.tcap b { color: ${C.ink}; }
table.matrix { font-size: 7.6pt; }
table.matrix th, table.matrix td { padding: 1.3pt 3pt; }
table.matrix .ic { width: 9pt; height: 9pt; }
table.matrix th.grp { text-align: center; border-bottom: 1px solid ${C.grid}; }
table.matrix th.k, table.matrix td.k { text-align: center; width: 20pt; }
table.matrix .focus { background: ${C.accentSoft}; }
table.matrix .split { border-left: 1px solid ${C.axis}; }
table.matrix tr.tot td { font-weight: 700; border-bottom: none; border-top: 1px solid ${C.axis}; }
.ic { width: 10pt; height: 10pt; vertical-align: -1.5pt; }
.nocall { color: ${C.muted}; }
.legend-inline { font-size: 8.4pt; color: ${C.ink2}; margin: 2pt 0 8pt; }
.legend-inline .ic { margin: 0 2pt 0 8pt; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 14pt; }
.small { font-size: 8.4pt; color: ${C.ink2}; }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 8.2pt; background: #f1f0ec; padding: 0.5pt 2.5pt; border-radius: 2px; }
pre { font-family: 'DejaVu Sans Mono', monospace; font-size: 8pt; background: #f1f0ec; padding: 7pt 9pt; border-radius: 4px; white-space: pre-wrap; break-inside: avoid; }
dl.gloss dt { font-weight: 700; margin-top: 5pt; }
dl.gloss dd { margin: 1pt 0 0 0; color: ${C.ink2}; }
`;

export function renderPdfHtml(R) {
  const o = R.options;
  const team = o.team;
  const teamName = TEAM_NAMES[team] ?? team;
  const short = teamName.split(' ').slice(0, -1).join(' ') || team; // "Seattle"
  const m = R.walkForward.metrics;
  const perm = R.permutation.models;
  const scan = R.scan;
  const rule = scan.focus;
  const [oAny, oSame] = scan.order.focus;
  const minN = scan.settings.minN;
  const gapRow = scan.consecutiveGaps.find((r) => r.days === 10);
  const others = R.teams.filter((t) => t.team !== team);
  const pool = (list) => {
    const s = { hits: 0, n: 0, nh: 0, nn: 0 };
    for (const x of list) {
      s.hits += x.hits;
      s.n += x.n;
      if (x.n && Number.isFinite(x.nullMeanRate)) {
        s.nh += x.nullMeanRate * x.n;
        s.nn += x.n;
      }
    }
    return { ...s, rate: s.hits / s.n, nullRate: s.nh / s.nn };
  };
  const pooledCal = pool(others.map((t) => t.rule));
  const pooledAny = pool(others.map((t) => t.order[0]));
  const pooledSame = pool(others.map((t) => t.order[1]));
  const asStrong = others.filter((t) => t.best && t.best.p <= rule.p).length;
  const perfectOthers = others.filter((t) => t.perfect > 0).length;
  const passing = R.teams.filter((t) => t.best && t.best.pFamily < 0.05);
  const distinctBest = new Set(R.teams.filter((t) => t.best).map((t) => `${t.best.d1}/${t.best.d2}`)).size;
  const nT = R.teams.length;
  const llWins = R.teams.filter((t) => t.nn.logLoss < t.base.logLoss).length;
  const accWins = R.teams.filter((t) => t.nn.accuracy > t.base.accuracy).length;
  const signP = binomTwoSided(llWins, nT, 0.5);
  const [pa, pb] = R.walkForward.paired;
  const pl = perm.nn_lattice;
  const ps = perm.nn_sequence;
  const strong = scan.chance.atLeastAsStrong;
  const record = R.data.record;
  const winRate = record.w / (record.w + record.l);

  // Schedule-derived pieces: the 10-day matrix and how often the rules fire.
  const seq = teamSchedule(loadGames(o.dataFile), team);
  const matrix = tenDayMatrix(seq, o.from, o.to);
  const modernFrom = 2012;
  const seasonsModern = o.to - modernFrom + 1;
  const callsSince = (ruleDef) =>
    ruleCases(seq, ruleDef, { from: modernFrom, to: o.to }).filter((c) => c.call !== null && isDecided(seq[c.game].result)).length;
  const callsCal = callsSince(R.rules.rule_28_10);
  const callsOrd = callsSince(R.rules.rule_gap10_k4);
  const perSeason = (callsCal + callsOrd) / 2 / seasonsModern;
  const p0 = Math.round(pooledAny.nullRate * 100) / 100;
  const power = powerRows(p0, 0.9, [5, 10, 15, 20, 30]);
  const needed = power.find((r) => r.power >= 0.8);
  const misses = R.cases.rule_gap10_k4.filter((c) => c.hit === false);
  const live = [];
  for (const u of R.upcomingRule) {
    const same = live.find((x) => x.game.date === u.game.date && x.older.date === u.older.date && x.newer.date === u.newer.date);
    if (same) same.rules.push(u.rule);
    else live.push({ ...u, rules: [u.rule] });
  }
  // "calls a loss vs KC if Seattle loses at DEN on Oct 15" -- from the data, not hand-written.
  const condition = (u) => {
    const a = u.older.result;
    const b = u.newer.result;
    const word = (r) => (r === 1 ? 'win' : 'loss');
    if (a === 0 || b === 0) return 'makes no call (a tie)';
    if (a !== null && b !== null) return a === b ? `calls a ${word(a)} ${where(u.game)}` : 'makes no call (the two results disagree)';
    const known = a ?? b;
    const pending = a === null ? u.older : u.newer;
    if (known === null) return 'depends on two games not yet played';
    return `calls a ${word(known)} ${where(u.game)} if ${short} ${known === 1 ? 'wins' : 'loses'} ${where(pending)} on ${longDate(pending.date)}, and makes no call otherwise`;
  };
  const liveSentence = live.length
    ? `${live.length === 1 && live[0].rules.length > 1 ? 'Both rules make their only' : 'The rules make their'} ${live[0].game.season} regular-season call on ${longDate(live[0].game.date)} ${where(live[0].game)}: ${live.length === 1 && live[0].rules.length > 1 ? 'each' : 'the rule'} ${condition(live[0])}.`
    : 'Neither rule has an eligible game left this season.';
  const nx = R.next;
  let figNo = 0;
  let tabNo = 0;
  const fig = (body, caption) => `<figure>${body}<figcaption><b>Figure ${++figNo}.</b> ${caption}</figcaption></figure>`;
  const tcap = (caption) => `<div class="tcap"><b>Table ${++tabNo}.</b> ${caption}</div>`;

  const html = [];
  const w = (s) => html.push(s);

  // ------------------------------------------------------------ cover
  w(`<section>
  <div class="kicker">Pattern analysis · ${esc(teamName)} · ${o.from}–${o.to}</div>
  <h1>Do ${esc(short)}’s wins and losses follow the calendar?</h1>
  <p class="lede">A neural network and a set of statistical tests, applied to every ${esc(short)} game since ${o.from}, to the 28/10-day rule, and to the 10-day, 4th-previous rule.</p>
  <div class="meta">Prepared ${longDate(R.generatedAt.slice(0, 10))} · Game data through ${longDate(R.data.lastPlayed.date)} (${where(R.data.lastPlayed)}, ${score(R.data.lastPlayed)}) · Source: nflverse games data · Reproducible with <code>node cli.js report</code></div>
  <div class="tiles">
    <div class="tile hl"><div class="label">Neural network, results + timing only</div><div class="value">${pct(m.nn_lattice.accuracy)}</div><div class="note">correct on ${m.nn_lattice.n} games it never saw</div></div>
    <div class="tile"><div class="label">Always pick ${esc(short)}</div><div class="value">${pct(m.always_win.accuracy)}</div><div class="note">same ${m.always_win.n} games</div></div>
    <div class="tile"><div class="label">Vegas point spread</div><div class="value">${pct(m.vegas.accuracy)}</div><div class="note">same ${m.vegas.n} games</div></div>
    <div class="tile"><div class="label">Shuffled histories with a rule as good as 28/10</div><div class="value">${pct(rule.pFamily, 0)}</div><div class="note">of ${scan.settings.nPerm.toLocaleString('en-US')} shuffles</div></div>
    <div class="tile"><div class="label">Shuffled histories with a rule as good as the 10-day rule</div><div class="value">${pct(oSame.pBoth, 0)}</div><div class="note">best version, of ${scan.settings.nPerm.toLocaleString('en-US')} shuffles</div></div>
  </div>
  <h3>Summary</h3>
  <ol>
    <li><b>The neural network found nothing usable.</b> Given only ${esc(short)}’s own results and the calendar spacing of its games, it picked ${pct(m.nn_lattice.accuracy)} of ${m.nn_lattice.n} unseen games (${o.testFrom}–${o.to}) correctly, significantly worse than simply picking ${esc(short)} every week (${pct(m.always_win.accuracy)}; McNemar p = ${fp(pa.p)}). The Vegas point spread got ${pct(m.vegas.accuracy)}.</li>
    <li><b>The real order of wins and losses is not special.</b> When each season’s results were dealt out in random order ${R.permutation.perms} times, the same network did as well on the shuffled histories (${pct(pl.nullAccuracy.mean)} on average) as on the real one (p = ${fp(pl.pAccuracy)}).</li>
    <li><b>Both rules’ records are real, and both are what searching produces.</b> The 28/10 rule is ${rule.hits}-for-${rule.n} and the 10-day, 4th-previous rule ${oAny.hits}-for-${oAny.n} in ${o.from}–${o.to} (${oSame.hits}-for-${oSame.n} if all games must be in one season). After accounting for the ${scan.combinedRules} similar rules examined, a record at least this good turns up in ${pct(oSame.pBoth, 0)}–${pct(oAny.pBoth, 0)} of shuffled histories.</li>
    <li><b>Both rules lean on two ordinary facts:</b> good seasons stay good (so “repeat the result” beats 50%), and after a Thursday game ${esc(short)} happened to repeat the Thursday result ${gapRow.same} of ${gapRow.n} times. For the other ${others.length} teams the same rules are right about ${pct(pooledAny.rate, 0)} of the time, as shuffled seasons predict.</li>
    <li><b>The numbers 3, 4, 7, 10, 11 and 14 are the NFL weekday schedule</b> (Sunday, Monday and Thursday games), not a hidden lattice.</li>
    <li><b>The fair test is the future.</b> ${liveSentence} Both rules are now in a dated ledger that scores them only on later games.</li>
  </ol>
  <div class="callout"><p><b>Bottom line.</b> Nothing in ${esc(short)}’s results since ${o.from} shows a calendar pattern that survives a neural network trained and tested on separate seasons, a shuffle test, or a correction for how many rules were tried. The two rules describe past games accurately, but their perfect-looking records are the kind that looking through many possible rules produces by chance. The honest way to settle it is to write rules down first and score them only on games that have not happened yet.</p></div>
</section>`);

  // ------------------------------------------------------------ 1. question & data
  w(`<section class="page">
  <h2><span class="no">1</span>The question, the data and the tests</h2>
  <p>The idea being tested is that ${esc(short)}’s wins and losses repeat or reverse at particular calendar intervals, a “lattice” built from spacings such as 3, 4, 7, 10, 11, 14, 21 and 28 days, and that particular combinations of past results predict the next one. Two specific rules came out of that search:</p>
  <div class="rule"><b>28/10 rule.</b> If ${esc(short)}’s results 28 days and 10 days before a game agree, predict that result again.</div>
  <div class="rule"><b>10-day, 4th-previous rule.</b> If a game comes exactly 10 days after ${esc(short)}’s previous game, and the previous and fourth-previous results agree, predict that result again.</div>
  <h3>Data</h3>
  <p>Every NFL game since 1999 comes from the nflverse <code>games.csv</code> file (compiled by Lee Sharpe): dates, scores, home and away, and closing point spreads. ${esc(short)} played ${R.data.games} games in ${o.from}–${o.to}, playoffs included, and went ${record.w}–${record.l}${record.t ? `–${record.t}` : ''} (${pct(winRate)} wins). That win rate is the bar: a rule or model that cannot beat “${esc(short)} wins” ${pct(winRate, 0)} of the time has not found anything. Ties count as neither result. Relocated franchises use their current codes (San Diego = LAC, St. Louis = LA, Oakland = LV).</p>
  <h3>Three tests, and one that is still running</h3>
  <ol>
    <li><b>Out-of-sample (walk-forward).</b> Each model predicts a season using only earlier seasons: train on ${o.from}–2003 and predict 2004, then train on ${o.from}–2004 and predict 2005, and so on to ${o.to}. A pattern that is real keeps working on games the model has never seen; a pattern that is noise does not.</li>
    <li><b>Shuffle test.</b> Keep every game’s date, opponent and home/away, and every season’s win–loss record, but deal each season’s results out in random order. Repeat thousands of times. If a result also shows up in the shuffled histories, it cannot be evidence that the real order of results is special.</li>
    <li><b>Correction for searching.</b> When many rules are examined, some will look perfect by luck. The fair question is not “how unlikely is this rule’s record?” but “how often does the best of all the rules examined look this good in a shuffled history?”</li>
    <li><b>Forward test.</b> A rule is written down with a date and scored only on games played afterward. This is the only test a rule found by searching old results can pass cleanly, and it is now set up (section 9).</li>
  </ol>
</section>`);

  // ------------------------------------------------------------ 2. network
  const sens = R.sensitivity;
  w(`<section>
  <h2><span class="no">2</span>The neural network</h2>
  <h3>What it sees</h3>
  <p>The main network is given only the information the lattice idea says matters: ${esc(short)}’s own results and when its games were played. For each game it receives ${R.features.lattice} inputs:</p>
  <ul>
    <li>the last 8 results in game order (win = +1, loss = −1);</li>
    <li>the gaps in days between the last few games, and whether a gap spans an offseason;</li>
    <li>the result exactly <i>d</i> days earlier, for every <i>d</i> from 1 to 63 (0 when there was no game that day), which covers 28/10-style rules directly;</li>
    <li>the weekday of the game (Sunday, Monday, Thursday, Saturday, other).</li>
  </ul>
  <p>For comparison, the same network was also trained on the last 8 results with no dates at all, on conventional information (point spread, home field, season record, point differential), and on everything together. Logistic regression is the same model with no hidden layer. The network has one hidden layer of ${o.net.hidden} units, and each prediction averages ${o.seeds} independently trained copies. Its settings were fixed before any test season was scored.</p>
  ${fig(figAccuracy(R, short), `Share of ${m.nn_lattice.n} unseen games (${o.testFrom}–${o.to}) each model picked correctly, with a 95% range. The highlighted network sees only results and timing. It lands below the line for always picking ${esc(short)}.`)}
  ${tcap(`Walk-forward results, ${o.testFrom}–${o.to}. Log-loss rewards confident correct calls and punishes confident misses; lower is better, and always saying 50/50 scores 0.693.`)}
  ${table(
    ['Model', 'Games', 'Correct', '95% range', 'Log-loss'],
    [
      ...WF_ORDER.filter((k) => m[k]).map((k) => ({
        cls: k === 'nn_lattice' ? 'hl' : '',
        cells: [k === 'always_win' ? `Always pick ${esc(short)}` : esc(R.labels[k]), m[k].n, pct(m[k].accuracy), `${pct(m[k].ci[0], 0)}–${pct(m[k].ci[1], 0)}`, f3(m[k].logLoss)],
      })),
      ...['rule_28_10', 'rule_gap10_k4']
        .filter((k) => m[k])
        .map((k) => [`${esc(R.labels[k])} (in-sample)*`, m[k].n, pct(m[k].accuracy), `${pct(m[k].ci[0], 0)}–${pct(m[k].ci[1], 0)}`, '–']),
    ],
    { num: [1, 2, 3, 4] },
  )}
  <p class="small">* The rules only make a call on ${m.rule_28_10.n} and ${m.rule_gap10_k4.n} of these games and were found by looking at these same seasons, so their rows are not out-of-sample. Sections 4–6 correct them for the search.</p>
  <h3>What the results say</h3>
  <p><b>The results-and-timing network is worse than doing nothing clever.</b> It and “always pick ${esc(short)}” disagreed on ${pa.onlyA + pa.onlyB} games; the network was right on ${pa.onlyA} of them and the simple rule on ${pa.onlyB} (McNemar p = ${fp(pa.p)}). Its log-loss (${f3(m.nn_lattice.logLoss)}) is worse than a constant guess (${f3(m.always_win.logLoss)}), which is what a model fitting noise looks like.</p>
  <p><b>Adding the timing inputs to the betting-line model hurts it.</b> The spread + home + form network scored ${pct(m.nn_conventional.accuracy)}; adding the results and timing inputs dropped it to ${pct(m.nn_all.accuracy)} (log-loss ${f3(m.nn_conventional.logLoss)} → ${f3(m.nn_all.logLoss)}). If the lattice carried information the market misses, this is where it would have shown up. Against the Vegas line itself, the everything network lost the disagreements ${pb.onlyA} to ${pb.onlyB} (p = ${fp(pb.p)}).</p>
  <p><b>It is not a matter of tuning.</b> Smaller, larger and differently regularized versions of the results-and-timing network all land between ${pct(Math.min(...sens.map((s) => s.accuracy)))} and ${pct(Math.max(...sens.map((s) => s.accuracy)))}:</p>
  ${tcap('The results + timing network under other settings (walk-forward, same games).')}
  ${table(['Setting', 'Correct', 'Log-loss'], sens.map((s) => [esc(s.label), pct(s.accuracy), f3(s.logLoss)]), { num: [1, 2] })}
</section>`);

  // ------------------------------------------------------------ 3. shuffle test
  w(`<section>
  <h2><span class="no">3</span>Shuffle test: is there any order in the sequence?</h2>
  <p>The walk-forward test asks whether the network can predict. The shuffle test asks a sharper question: does the <i>real order</i> of ${esc(short)}’s wins and losses contain anything that a random order of the same seasons does not? Each shuffle keeps the schedule and each season’s record and deals the results out at random; the whole walk-forward evaluation is then repeated on the shuffled history. This was done ${R.permutation.perms} times (with ${R.permutation.seeds}-network ensembles to keep it affordable).</p>
  ${fig(figShuffle(R), `The results + timing network’s score on ${R.permutation.perms} shuffled histories (bars) and on the real history (black line). The real order sits inside the shuffled range on both measures: p = ${fp(pl.pAccuracy)} for accuracy and ${fp(pl.pLogLoss)} for log-loss.`)}
  ${tcap(`Real history against ${R.permutation.perms} shuffles for each model. p is the share of shuffles that did at least as well as the real order.`)}
  ${table(
    ['Model', 'Real', 'Shuffled (90% range)', 'p', 'Real log-loss', 'Shuffled', 'p'],
    Object.entries(perm).map(([k, s]) => [
      esc(R.labels[k]),
      pct(s.real.accuracy),
      `${pct(s.nullAccuracy.p05)}–${pct(s.nullAccuracy.p95)}`,
      fp(s.pAccuracy),
      f3(s.real.logLoss),
      f3(s.nullLogLoss.mean),
      fp(s.pLogLoss),
    ]),
    { num: [1, 2, 3, 4, 5, 6] },
  )}
  <p>None of the rows is significant. The closest is the network’s log-loss (p = ${fp(pl.pLogLoss)}); even if that edge were real, it would be too small to use, since the same network still loses to always picking ${esc(short)}. A control network that sees only the last 8 results, with no dates, behaves the same way (p = ${fp(ps.pLogLoss)}), so whatever small streakiness exists does not come from calendar spacing.</p>
</section>`);

  // ------------------------------------------------------------ 4. 28/10 rule
  const midDays = [...new Set(R.cases.rule_28_10.map((c) => c.newer.weekday))];
  w(`<section>
  <h2><span class="no">4</span>The 28/10 rule</h2>
  <p>Every ${esc(short)} game in ${o.from}–${o.to} with a game exactly 28 days and exactly 10 days before it is listed below. The two ends of the 28-day span agree in ${rule.endsSame} of ${rule.nEnds} cases. The rule fires when the first two results agree, and the third matched all ${rule.hits} times. Both counts match the hand count exactly.</p>
  ${tcap(`Every 28/10 sequence, ${o.from}–${o.to}.`)}
  ${table(
    ['Game', '28 days before', '10 days before', 'Result', 'Rule'],
    R.cases.rule_28_10.map((c) => [
      `${longDate(c.game.date)} ${where(c.game)}`,
      `${longDate(c.older.date)} · ${wl(c.older.result)}`,
      `${c.newer.weekday} ${longDate(c.newer.date)} · ${wl(c.newer.result)}`,
      wl(c.game.result),
      c.call === null ? 'no call' : c.hit ? `${ICON_OK} hit` : `${ICON_MISS} miss`,
    ]),
  )}
  ${midDays.length === 1 ? `<p><b>Every “10 days before” game is a ${midDays[0] === 'Thu' ? 'Thursday' : midDays[0]} game.</b> A 10-day gap only happens when a Thursday game is followed by a Sunday game, so the rule really says “after a Thursday game, compare it with four weeks earlier.” ${esc(short)} played ${R.data.thursdays.length} Thursday games in ${o.from}–${o.to}, the first on ${longDate(R.data.thursdays[0])}, which is why the rule has so few cases.</p>` : ''}
  <p><b>On its own, ${rule.hits} for ${rule.n} looks impressive.</b> A coin would do it with probability ${fp(rule.p)}. But “repeat the result” is not a coin flip: because good seasons stay good, this exact rule averages ${pct(rule.nullMeanRate, 0)} hits even in shuffled seasons, and ${rule.hits}/${rule.n} still happens in ${pct(rule.pPermutation, 1)} of them. The bigger issue is that 28/10 was not the only rule looked at, which is the subject of section 5.</p>
  ${tcap(`The strongest “if the games d1 and d2 days back agree, repeat it” rules in ${o.from}–${o.to} (${scan.rulesTested} rules have at least ${minN} cases).`)}
  ${table(
    ['Rule', 'Cases', 'Repeated', 'Rate', 'p on its own', 'p after the search'],
    scan.combos.slice(0, 8).map((c) => ({
      cls: c.d1 === rule.d1 && c.d2 === rule.d2 ? 'hl' : '',
      cells: [`${c.d1} & ${c.d2} days`, c.n, c.hits, pct(c.rate, 0), fp(c.p), fp(c.pFamily)],
    })),
    { num: [1, 2, 3, 4, 5] },
  )}
  <p>Two other rules tie or beat 28/10 in the same data: 49 & 28 days (${scan.combos[0].hits}/${scan.combos[0].n}) and 35 & 10 days (8/8). None of them survives the correction.</p>
</section>`);

  // ------------------------------------------------------------ 5. search problem
  w(`<section>
  <h2><span class="no">5</span>Why a search produces perfect records</h2>
  <p>Imagine ${scan.rulesTested} different rules, each with eight or more past cases. Even if none of them means anything, some will match their cases every time, the same way that among a hundred people flipping eight coins, someone will get eight heads. Finding one of them and then quoting its record is not the same as predicting that record in advance.</p>
  <p>The correction below measures this directly. In each of ${scan.settings.nPerm.toLocaleString('en-US')} shuffled histories, every rule is scored and the most impressive one is kept. A real rule is only remarkable if it beats the best rule of most shuffled histories.</p>
  ${fig(figSearch(R), `Each curve shows how often a shuffled history contains a best rule at least as impressive as the value on the horizontal axis. The dots are the real rules. The 28/10 rule is matched or beaten in ${pct(rule.pFamily, 0)} of shuffled histories when only calendar rules are searched; the best version of the 10-day rule in ${pct(oSame.pBoth, 0)} when both families are searched; the 10-day rule as written in ${pct(oAny.pBoth, 0)}.`)}
  <div class="callout"><p><b>How to read the corrected numbers.</b> A value such as ${pct(oSame.pBoth, 0)} means: in ${pct(oSame.pBoth, 0)} of histories where the order of results is pure chance, searching the same rules finds one at least this good. Conventionally, a finding starts to count as evidence below 5%. These are far above it. The real history also contains ${strong.real} calendar rules at least as strong as 28/10, where shuffled histories average ${n1(strong.nullMean)} and ${pct(strong.pExcess, 0)} of them have ${strong.real} or more.</p></div>
  <p>These corrections are generous to the rules. They count only rules with at least ${minN} cases (the cutoff that includes 28/10), lookbacks of up to 63 days, and the two rule families defined here. They cannot account for rules that were adjusted after seeing a miss, as the 10-day rule was adjusted to avoid the 1996 case, so the true correction is larger.</p>
</section>`);

  // ------------------------------------------------------------ 6. 10-day rule
  const pos = scan.order.positions;
  w(`<section>
  <h2><span class="no">6</span>The 10-day, 4th-previous rule</h2>
  <p>Because every 10-day gap is a Thursday followed by a Sunday, the 4th-previous game is usually the one exactly 28 days back, the same game the 28/10 rule uses. The two rules differ when a Monday game or a bye moves the calendar: the 2015 case spans 27 days (6 + 7 + 4 + 10) and counts only for the new rule.</p>
  <p><b>As written, the rule is ${oAny.hits}-for-${oAny.n} in ${o.from}–${o.to}, not perfect.</b> ${misses
    .map(
      (c) =>
        `The miss is ${longDate(c.game.date)} ${where(c.game)} (${score(c.game)}): the previous game was the ${c.newer.weekday} ${longDate(c.newer.date)} win, and the 4th-previous game was the ${longDate(c.older.date)}${c.older.gameType !== 'REG' ? ' playoff' : ''} win${c.older.season !== c.game.season ? `, in the ${c.older.season} season` : ''}.`,
    )
    .join(' ')} It becomes ${oSame.hits}-for-${oSame.n} only if all the games must be in one season, which the rule does not say. That condition is also the only way to reproduce a perfect 10-for-10 over 1976–2025: dropping playoff games does not remove this miss, because ${esc(short)}’s last regular-season game four back (Dec 15, 2013) was a win too.</p>
  <h3>One fact underneath every version</h3>
  <p>There were ${gapRow.n} games after a 10-day gap. ${esc(short)} repeated its Thursday result in ${gapRow.same} of them (${pct(gapRow.rate, 0)}); shuffled seasons give ${pct(gapRow.nullRate, 0)}, so this is unusual but not significant (p = ${fp(gapRow.p)}). Every version of the rule is a subset of those ${gapRow.n} games. The grid shows which version calls which game: the perfect versions are the subsets that happen to leave out the ${gapRow.n - gapRow.same} games that did not repeat.</p>
  <div class="tcap"><b>Figure ${++figNo}.</b> Every ${esc(short)} game after a 10-day gap, ${o.from}–${o.to}, and each version of the rule: ${ICON_OK} hit ${ICON_MISS} miss <span class="nocall">–</span> no call (the two results disagree); blank: not eligible; shaded: the 4th-previous rule.</div>
  ${matrixHtml(matrix)}
  <p>The 4th-previous version is ${pos.find((p) => p.k === 4).any.hits}/${pos.find((p) => p.k === 4).any.n} as written and ${pos.find((p) => p.k === 4).same.hits}/${pos.find((p) => p.k === 4).same.n} same-season only. It is not the only perfect-looking choice: the 5th-previous same-season version is ${ratio(pos.find((p) => p.k === 5).same)}, and the 7th and 8th are ${ratio(pos.find((p) => p.k === 7).same)} and ${ratio(pos.find((p) => p.k === 8).same)}.</p>
  <h3>Corrected for the search</h3>
  <p>${scan.order.rulesTested} game-order rules have at least ${minN} cases (every gap up to ${scan.settings.orderMaxGap} days or any gap, positions 2 to ${scan.settings.orderMaxK}, any season or same season only). With the ${scan.rulesTested} calendar rules that makes ${scan.combinedRules}.</p>
  ${tcap('The 10-day, 4th-previous rule, measured four ways.')}
  ${table(
    ['Version', 'Record', 'p on its own', 'vs shuffled seasons', 'after the game-order search', 'after both searches'],
    [
      ['Same season only', `${oSame.hits}/${oSame.n}`, fp(oSame.p), fp(oSame.pPermutation), fp(oSame.pFamily), fp(oSame.pBoth)],
      ['As written', `${oAny.hits}/${oAny.n}`, fp(oAny.p), fp(oAny.pPermutation), fp(oAny.pFamily), fp(oAny.pBoth)],
    ],
    { num: [1, 2, 3, 4, 5] },
  )}
  ${tcap('The strongest game-order rules found, corrected for both searches.')}
  ${table(
    ['Rule', 'Cases', 'Repeated', 'Rate', 'p on its own', 'p after both searches'],
    scan.order.rules.slice(0, 6).map((r) => ({
      cls: r.gap === 10 && r.k === 4 ? 'hl' : '',
      cells: [`${r.gap ? `${r.gap}-day gap` : 'any gap'}, ${ordinal(r.k)} previous${r.sameSeason ? ', same season' : ''}`, r.n, r.hits, pct(r.rate, 0), fp(r.p), fp(r.pBoth)],
    })),
    { num: [1, 2, 3, 4, 5] },
  )}
  <p><b>Other teams.</b> For the other ${others.length} teams the same rule is right ${pooledAny.hits} of ${pooledAny.n} times (${pct(pooledAny.rate, 0)}) as written and ${pooledSame.hits} of ${pooledSame.n} (${pct(pooledSame.rate, 0)}) same-season only, against ${pct(pooledAny.nullRate, 0)} and ${pct(pooledSame.nullRate, 0)} in their shuffled seasons. Across the league it is a “good seasons stay good” rule and nothing more. The neural network in section 2 had exactly the inputs this rule needs (the last 8 results in order and the gap before each game); with ${oAny.n} cases in ${o.to - o.from + 1} seasons it cannot be told apart from the other patterns noise produces.</p>
</section>`);

  // ------------------------------------------------------------ 7. intervals
  const gapMoves = new Map(R.gaps.map((g) => [g.gap, g.moves]));
  w(`<section>
  <h2><span class="no">7</span>Intervals, repeats and reversals</h2>
  <h3>Where 3, 4, 7, 10, 11 and 14 come from</h3>
  <p>Nearly every NFL game is played on a Sunday, Monday, Thursday or Saturday, so the gap between two games is a week plus or minus a weekday shift. The chart counts every gap between back-to-back ${esc(short)} games in ${o.from}–${o.to}.</p>
  ${fig(figGaps(R), `Gaps between back-to-back games. Almost all are 7 days (Sunday to Sunday); 4 and 10 are the two halves of a Thursday game (Sunday→Thursday, Thursday→Sunday), 8 and 6 the two halves of a Monday game, 14 a bye week.`)}
  <p>So 14 = 7 + 7 = 8 + 6 = 4 + 10 is the same two-week span with the middle game moved to a Monday or a Thursday; 27 = 6 + 7 + 4 + 10 is four weeks that start with a Monday game; 21 is three weeks; and 11 is a Thursday game followed by a Monday game. These numbers appear because of how the league schedules games, which is why they recur in every team’s history.</p>
  <h3>Do results repeat or reverse at particular gaps?</h3>
  ${tcap('Back-to-back games by the days between them. “Same” means the second game repeated the first result; “Shuffled” is what reshuffled seasons give. q corrects p for the number of gaps checked (false-discovery rate).')}
  ${table(
    ['Gap', 'Weekdays', 'Pairs', 'Same', 'Rate', 'Shuffled', 'p', 'q'],
    scan.consecutiveGaps.map((r) => ({
      cls: r.days === 10 ? 'hl' : '',
      cells: [`${r.days} days`, (gapMoves.get(r.days) ?? []).slice(0, 2).map((x) => x.move.replace(' -> ', '→')).join(', '), r.n, r.same, pct(r.rate, 0), pct(r.nullRate, 0), fp(r.p), fp(r.q)],
    })),
    { num: [2, 3, 4, 5, 6, 7] },
  )}
  ${tcap(`Every pair of games up to ${scan.settings.maxPairLag} days apart (not only back-to-back): the eight most extreme of ${scan.pairLags.length} intervals.`)}
  ${table(
    ['Interval', 'Pairs', 'Same', 'Rate', 'Shuffled', 'p', 'q'],
    [...scan.pairLags]
      .sort((a, b) => a.p - b.p)
      .slice(0, 8)
      .map((r) => [`${r.days} days`, r.n, r.same, pct(r.rate, 0), pct(r.nullRate, 0), fp(r.p), fp(r.q)]),
    { num: [1, 2, 3, 4, 5, 6] },
  )}
  <p>A few intervals have raw p-values under 0.05, as expected when ${scan.pairLags.length} are checked; none survives the correction (lowest q = ${fp(Math.min(...scan.pairLags.map((r) => r.q)))}, and ${fp(Math.min(...scan.consecutiveGaps.map((r) => r.q)))} for back-to-back games). The most extreme, 14-day pairs repeating less often than usual, would be a reversal pattern if it were real; it is within what ${scan.pairLags.length} tries produce.</p>
</section>`);

  // ------------------------------------------------------------ 8. teams
  w(`<section class="page">
  <h2><span class="no">8</span>All 32 teams</h2>
  <p>If ${esc(short)} had a hidden lattice, the same search on other teams should come up comparatively empty. It does not. ${asStrong} of the other ${others.length} teams have a calendar rule that looks at least as strong as 28/10 by the same measure, spread over ${distinctBest} different pairs of intervals, and ${perfectOthers} of them have at least one perfect rule with ${minN}+ cases. After correcting for the search, ${passing.length} of ${nT} teams’ best rules pass at the 5% level, where chance alone gives about ${n1(0.05 * nT)}${passing.length ? ` (${passing.map((t) => `${t.team}: ${t.best.d1} & ${t.best.d2} days, ${t.best.hits}/${t.best.n}`).join('; ')})` : ''}.</p>
  ${fig(figTeams(R, team), `Each team’s most impressive calendar rule (${o.from}–${o.to}): its p-value on its own, against a coin flip (light), and after correcting for the search (dark). Every team has a rule that looks remarkable on its own; almost none survives the correction. “A different pattern for every team” is what noise produces.`)}
  ${tcap(`Per team, ${o.from}–${o.to}: both named rules, the best calendar rule, and the results + timing network (walk-forward, ${R.permutation.seeds}-network ensembles) against always predicting the team’s more common result.`)}
  ${table(
    ['Team', '28/10', '10-day, 4th prev.', 'Best calendar rule', 'p after search', 'Network', 'Base rate'],
    [...R.teams]
      .sort((a, b) => (a.best?.pFamily ?? 1) - (b.best?.pFamily ?? 1))
      .map((t) => ({
        cls: t.team === team ? 'hl' : '',
        cells: [t.team, ratio(t.rule), ratio(t.order[0]), t.best ? `${t.best.d1} & ${t.best.d2} days: ${t.best.hits}/${t.best.n}` : '–', t.best ? fp(t.best.pFamily) : '–', pct(t.nn.accuracy), pct(t.base.accuracy)],
      })),
    { num: [1, 2, 4, 5, 6] },
  )}
  <p><b>A team-specific lattice would show up in each team’s own network.</b> Trained on one team at a time, the results-and-timing network beat its team’s base rate on accuracy for ${accWins} of ${nT} teams but on log-loss for only ${llWins} of ${nT}. ${llWins < nT / 2 && signP < 0.05 ? `Losing to the base rate for most teams (sign test p = ${fp(signP)}) is the signature of fitting noise.` : `That split is what coin flips produce (sign test p = ${fp(signP)}).`} Pooled across the other ${others.length} teams, the 28/10 rule is right ${pooledCal.hits} of ${pooledCal.n} times (${pct(pooledCal.rate, 0)}), against ${pct(pooledCal.nullRate, 0)} in their shuffled seasons.</p>
</section>`);

  // ------------------------------------------------------------ 9. next
  const probs = nx ? Object.entries(nx.probs) : [];
  w(`<section class="page">
  <h2><span class="no">9</span>What happens next</h2>
  ${
    nx
      ? `<h3>Next game: ${nx.game.weekday} ${longDate(nx.game.date)} ${where(nx.game)}</h3>
  <p>${esc(short)} ${nx.game.spread > 0 ? `is favored by ${nx.game.spread} points` : nx.game.spread < 0 ? `is a ${-nx.game.spread}-point underdog` : 'is a pick’em'}. Every model was retrained on all ${nx.trainedOn} finished games through ${longDate(nx.lastPlayed.date)}.</p>
  ${tcap(`Probability that ${esc(short)} wins on ${longDate(nx.game.date)}.`)}
  ${table(
    ['Model', 'Win probability', 'Out-of-sample record (section 2)'],
    probs.map(([k, p]) => [k === 'always_win' ? `Always pick ${esc(short)} (base rate)` : esc(R.labels[k]), pct(p, 0), pct(m[k].accuracy)]),
    { num: [1, 2] },
  )}
  <p>Only the models that use the point spread beat the base rate out of sample, so the Vegas-based figure is the one to trust. The results-and-timing figure is shown for completeness; its track record says it is noise.</p>`
      : ''
  }
  <h3>The live test: ${live[0] ? `${longDate(live[0].game.date)} ${where(live[0].game)}` : 'none this season'}</h3>
  ${live
    .map(
      (u) =>
        `<p>${u.rules.length > 1 ? 'Both rules compare the same two games' : `The ${esc(R.rules[u.rules[0]].label)} compares two games`}: ${u.older.weekday} ${longDate(u.older.date)} ${where(u.older)} (${wl(u.older.result)}) and ${u.newer.weekday} ${longDate(u.newer.date)} ${where(u.newer)} (${u.newer.result === null ? 'not played yet' : wl(u.newer.result)}). ${u.newer.result === null && u.older.result !== null ? `<b>If ${esc(short)} ${u.older.result === 1 ? 'wins' : 'loses'} ${where(u.newer)} on ${longDate(u.newer.date)}, ${u.rules.length > 1 ? 'both rules call' : 'the rule calls'} a ${u.older.result === 1 ? 'win' : 'loss'} ${where(u.game)}. If not, ${u.rules.length > 1 ? 'neither makes a call' : 'it makes no call'}.</b>` : esc(u.status)} ${u.rules.length > 1 ? 'This is one shared test, not two: the rules cannot disagree on this game.' : ''}</p>`,
    )
    .join('')}
  <h3>The ledger</h3>
  <p><code>ledger.json</code> records each rule with the date it was written down, and <code>node cli.js ledger</code> scores it only on games played after that date. New rules should be added the day they are found; their record from then on is the only one that counts as evidence.</p>
  ${table(
    ['Rule', 'Written down', 'Forward record', 'Next call'],
    R.ledger.map((r) => {
      const next = r.calls.find((c) => c.game.result === null) ?? r.calls.at(-1);
      return [
        esc(r.text),
        longDate(r.registered),
        `${r.hits}/${r.n}`,
        next ? `${longDate(next.game.date)} ${where(next.game)}: ${condition(next).replace(` ${where(next.game)}`, '')}` : 'none yet',
      ];
    }),
  )}
  <h3>How long until the ledger can decide?</h3>
  <p>These rules fire rarely. Since ${modernFrom}, when Thursday games became a weekly fixture, they have made about ${perSeason.toFixed(1)} calls a season. To tell a rule that is truly right 90% of the time from the ${pct(p0, 0)} that “good seasons stay good” already produces, a fair test needs:</p>
  ${tcap(`Forward calls needed. “Hits needed” is the fewest hits that would be convincing (a one-sided exact test at the 5% level against ${pct(p0, 0)}); “chance of passing” assumes the rule really is right 90% of the time.`)}
  ${table(
    ['Forward calls', 'Hits needed', 'False-alarm rate', 'Chance of passing if the rule is real', 'Seasons at the current rate'],
    power.map((r) => [
      r.n,
      r.k === null ? 'not possible' : `${r.k} of ${r.n}`,
      r.falseAlarm === null ? '–' : pct(r.falseAlarm, 1),
      r.k === null ? '0%' : pct(r.power, 0),
      `about ${Math.round(r.n / perSeason)}`,
    ]),
    { num: [0, 2, 3, 4] },
  )}
  <p>Even a perfect run of 5 forward calls would not be convincing, and reaching ${needed ? needed.n : 'enough'} calls at the current rate takes roughly ${needed ? Math.round(needed.n / perSeason) : 'many'} seasons. Until then, the rules should be treated as unproven, and results from the rest of the league (where the same rules already run at about ${pct(pooledAny.rate, 0)}) are the faster check.</p>
</section>`);

  // ------------------------------------------------------------ 10. conclusions
  w(`<section>
  <h2><span class="no">10</span>Conclusions</h2>
  <h3>What the evidence supports</h3>
  <ul>
    <li>${esc(short)}’s results since ${o.from} are well described by team strength (season records, home field, the point spread). Once that is known, the calendar and the order of past results add nothing a network can use; adding them makes predictions worse.</li>
    <li>The 28/10 and 10-day rules are accurate descriptions of past games. Their records are what a search of this size produces by chance, and their success above 50% comes from good seasons staying good, which holds for every team.</li>
    <li>The recurring numbers (3, 4, 7, 10, 11, 14, 21, 27, 28) come from the NFL’s weekday schedule.</li>
  </ul>
  <h3>What would change this conclusion</h3>
  <ul>
    <li>A rule written down in advance that keeps hitting on future games well above ${pct(p0, 0)}, over enough calls (section 9).</li>
    <li>A rule that works across many teams at once, beyond what their shuffled seasons give. That would be testable quickly, because the league plays about 32 times as many games.</li>
    <li>A model that uses the lattice inputs and beats the point spread out of sample. None of the models here comes close.</li>
  </ul>
  <h3>A note on the other numbers</h3>
  <p>The year arithmetic (1999 − 1976 = 23; 2160 − 1976 = 184 = 8 × 23; 2160 − 1999 = 161 = 7 × 23) is one coincidence, not two: once 2160 − 1976 is a multiple of 23, subtracting 1999 − 1976 = 23 makes 2160 − 1999 one automatically. Numbers such as 1764, 1998, 2760 and 1380 could not be tested without a definition of what they count. Any rule that can be stated in days or game positions can be checked with <code>node cli.js query</code> and registered in the ledger.</p>
  <h2 style="margin-top:18pt"><span class="no">A</span>Method details</h2>
  <ul>
    <li><b>Data.</b> nflverse <code>games.csv</code>, ${R.data.games} ${esc(short)} games in ${o.from}–${o.to} (${R.decidedInWindow} with a winner). Features for a game use only earlier results plus facts known before kickoff (date, weekday, home/away, spread); a unit test flips every later result and checks that a game’s inputs do not change.</li>
    <li><b>Network.</b> Inputs → ${o.net.hidden} tanh units → sigmoid output. Full-batch Adam (learning rate ${o.net.lr}), L2 penalty ${o.net.l2}, early stopping on a random ${pct(o.net.valFrac, 0)} of the training games (patience ${o.net.patience}, at most ${o.net.maxEpochs} epochs), average of ${o.seeds} seeds. Logistic regression is the same code with no hidden layer. Written without dependencies in Node.js.</li>
    <li><b>Walk-forward.</b> Expanding window: train ${o.from}..Y−1, predict every game of season Y, for Y = ${o.testFrom}..${o.to} (${m.nn_lattice.n} games).</li>
    <li><b>Shuffle null.</b> Within each season, results are permuted across that season’s games (regular season and playoffs), keeping dates, opponents, home/away and the season record.</li>
    <li><b>Rule families.</b> Calendar: games exactly d1 and d2 days before agree (d2 &lt; d1 ≤ 63). Game-order: the gap before the game is g days (every g ≤ ${scan.settings.orderMaxGap}, or any gap) and the previous and k-th previous results agree (k = 2..${scan.settings.orderMaxK}), any season or same season only. Rules need at least ${minN} calls.</li>
    <li><b>Corrections.</b> “p after the search” is the share of ${scan.settings.nPerm.toLocaleString('en-US')} shuffled histories whose best rule (smallest two-sided binomial p) is at least as small (min-p family-wise correction). Interval tables use Benjamini–Hochberg q-values; accuracy ranges are Wilson 95% intervals; paired model comparisons use exact McNemar tests.</li>
  </ul>
  <h2 style="margin-top:14pt"><span class="no">B</span>Reproducing this report</h2>
  <pre>cd seahawks-nn
npm test                      # unit tests
node cli.js report            # full analysis (about 4 minutes)
node cli.js pdf               # this PDF, from results/results.json
node cli.js query --gap 10 --position 4 --same-season
node cli.js ledger            # forward record of the registered rules
npm run update-data           # new games from nflverse (needs GitHub access)</pre>
  <h2 style="margin-top:14pt"><span class="no">C</span>Glossary</h2>
  <dl class="gloss">
    <dt>Out-of-sample / walk-forward</dt><dd>Scoring a model only on games it was not trained on, season by season, in the order they happened.</dd>
    <dt>p-value</dt><dd>How often chance alone would produce a result at least this extreme. Small is surprising; 0.05 (5%) is the conventional line.</dd>
    <dt>p after the search (family-wise)</dt><dd>The p-value corrected for having looked at many rules: how often the best rule in a chance-only history looks this good.</dd>
    <dt>Shuffle test</dt><dd>Re-running an analysis on histories where each season’s results are put in random order, to see what chance produces with the same schedules and records.</dd>
    <dt>Log-loss</dt><dd>A score for probability forecasts that punishes confident misses. Lower is better; always saying 50% scores 0.693.</dd>
    <dt>Base rate</dt><dd>The accuracy of always predicting the more common result (for ${esc(short)}, a win).</dd>
  </dl>
</section>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(teamName)} pattern analysis</title><style>${CSS}</style></head><body>${html.join('\n')}</body></html>`;
}

export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {}
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return createRequire(join(root, 'noop.js'))(join(root, 'playwright'));
  } catch {
    return null;
  }
}

export async function buildPdf(R, { outFile, htmlFile }) {
  const html = renderPdfHtml(R);
  if (htmlFile) writeFileSync(htmlFile, html);
  const pw = await loadPlaywright();
  if (!pw) {
    if (!htmlFile) writeFileSync(outFile.replace(/\.pdf$/, '.html'), html);
    return { pdf: null, reason: 'Playwright not found; wrote the HTML instead (print it to PDF from a browser)' };
  }
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const team = TEAM_NAMES[R.options.team] ?? R.options.team;
    await page.pdf({
      path: outFile,
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="font-family:${FONT};font-size:7.5px;color:${C.muted};width:100%;padding:0 0.8in;display:flex;justify-content:space-between"><span>${esc(team)} pattern analysis · ${esc(R.generatedAt.slice(0, 10))}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      margin: { top: '0.75in', bottom: '0.8in', left: '0.8in', right: '0.8in' },
    });
  } finally {
    await browser.close();
  }
  return { pdf: outFile };
}
