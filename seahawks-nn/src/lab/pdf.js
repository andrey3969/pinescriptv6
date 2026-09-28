// The lattice lab as a PDF: HTML with inline SVG charts, printed with
// Playwright's Chromium (same kit and palette as the Seattle analysis).
import { writeFileSync } from 'node:fs';
import { TEAM_NAMES } from '../data.js';
import { C, CSS, FONT, dot, esc, line, loadPlaywright, pct, svg, table, text } from '../pdf.js';
import { mulberry32 } from '../rng.js';
import { wilson } from '../stats.js';

export const ORDER = ['calLag', 'cal2', 'cal3', 'order', 'orderLag', 'markov', 'modular', 'specGame', 'specCal', 'lz'];
export const PLAIN = {
  calLag: {
    name: 'Day-interval repeats',
    short: 'Day intervals',
    what: 'Does a game repeat (or reverse) the result of the game exactly d days earlier? Every d from 1 to 400 days, plus the long lags 1380, 1764, 1998, 2160, 2760 and 8400 days.',
    example: '7, 10, 14, 28 days apart',
  },
  cal2: {
    name: 'Two-lookback rules',
    short: '2-lookback',
    what: 'When the games d1 and d2 days back had the same result, does the next game repeat it? Every pair of distances up to 63 days.',
    example: 'the 28/10 rule',
  },
  cal3: {
    name: 'Three-lookback rules',
    short: '3-lookback',
    what: 'Three earlier games at set day distances (up to 42 days) all agree: does the next game follow them?',
    example: '28, 21 and 7 days',
  },
  order: {
    name: 'Gap + k-th previous rules',
    short: 'Gap + k-th',
    what: 'The game comes g days after the last one (any gap, or exactly 1-21 days) and the last and k-th previous games agree (k = 2-8), in any season or the same season: repeat?',
    example: '10-day gap, 4th previous',
  },
  orderLag: {
    name: 'Game-count repeats',
    short: 'Game count',
    what: 'Same result k games apart, k = 1-40. k = 1 is the classic runs test for streakiness.',
    example: '4 games apart',
  },
  markov: {
    name: 'Streak patterns',
    short: 'Streaks',
    what: 'Win rate right after each run of the last 1-5 results.',
    example: 'after L-L-L',
  },
  modular: {
    name: 'Phase lattices',
    short: 'Phases',
    what: 'Win rate on days whose day number leaves remainder a when divided by n, for n = 2-60 (n = 7 is the day of the week). Tested per team only: pooled, every game is one win and one loss.',
    example: 'every 3rd day; Thursdays',
  },
  specGame: {
    name: 'Cycles in game order',
    short: 'Game cycles',
    what: 'Fourier periodogram of each team’s season-adjusted W/L sequence: is there a cycle every 2-100 games?',
    example: 'a cycle every 4 games',
  },
  specCal: {
    name: 'Cycles in calendar time',
    short: 'Day cycles',
    what: 'The same over calendar days: a cycle every 3-400 days, 300 periods.',
    example: 'a cycle every 21 days',
  },
  lz: {
    name: 'Compressibility',
    short: 'Compress.',
    what: 'Lempel-Ziv complexity of the W/L string. Any hidden repeating structure makes a sequence easier to compress.',
    example: 'one number per team',
  },
};

// p-values: three decimals below 0.1, so the text agrees with the 0.05 shading.
export const fp = (p) => (!Number.isFinite(p) ? '–' : p < 0.001 ? '< 0.001' : p < 0.1 ? p.toFixed(3) : p.toFixed(2));
const MAIN = 'spread';
const OTHER = 'shuffle';
const ALPHA = 0.005; // 0.05 over the ten families
const z1 = (z) => (Number.isFinite(z) ? z.toFixed(1) : '–');
const signed = (z) => (Number.isFinite(z) ? `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}` : '–');
const num = (x) => x.toLocaleString('en-US');
const n1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
const fams = (L) => ORDER.filter((k) => L.families[k]);

// ------------------------------------------------------------------ verdicts
export function verdicts(L) {
  return fams(L).map((key) => {
    const f = L.families[key];
    const t = (kind) => {
      const x = f.nulls[kind];
      return {
        max: x.pooled?.max.p ?? null,
        dense: x.pooled?.meanZ2.p ?? null,
        teams: x.teams.sig.p,
        teamsReal: x.teams.sig.real,
        teamsExpected: x.teams.sig.nullMean,
        held: x.teams.split.top1.p,
        heldPooled: x.pooled?.split.top1.p ?? null,
      };
    };
    const main = t(MAIN);
    const other = t(OTHER);
    const ps = (x) => [x.max, x.dense, x.teams, x.held, x.heldPooled].filter((p) => p !== null);
    return {
      key,
      main,
      other,
      signalMain: ps(main).some((p) => p < ALPHA),
      signalOther: ps(other).some((p) => p < ALPHA),
      minMain: Math.min(...ps(main)),
      minOther: Math.min(...ps(other)),
    };
  });
}

// ------------------------------------------------------------------ figures
// Figure 1: every league-wide lattice as a dot; tick = what pure noise reaches.
function figStrip(L) {
  const keys = fams(L).filter((k) => L.families[k].pooledTest);
  const W = 640;
  const H = 292;
  const left = 46;
  const right = 10;
  const top = 34;
  const bottom = H - 52;
  const all = keys.flatMap((k) => L.families[k].nulls[MAIN].pooled.z.filter((z) => z !== null).map((z) => strengthOf(L.families[k], z)));
  const yMin = Math.min(-3, Math.floor(Math.min(...all)));
  const yMax = Math.max(5, Math.ceil(Math.max(...all, ...keys.map((k) => L.families[k].nulls[MAIN].pooled.max.null95))));
  const y = (v) => bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top);
  const band = (W - left - right) / keys.length;
  let b = '';
  for (let v = yMin; v <= yMax; v++) {
    b += line(left, y(v), W - right, y(v), v === 0 ? C.axis : C.grid);
    b += text(left - 6, y(v) + 3.5, String(v), { anchor: 'end', size: 9.5, fill: C.muted });
  }
  b += text(12, (top + bottom) / 2, 'Strength (z vs. spread-weighted shuffle)', { size: 9.5, fill: C.ink2, anchor: 'middle' }).replace('<text ', `<text transform="rotate(-90 12 ${((top + bottom) / 2).toFixed(1)})" `);
  keys.forEach((k, c) => {
    const f = L.families[k];
    const P = f.nulls[MAIN].pooled;
    const x0 = left + c * band;
    const rand = mulberry32(1000 + c);
    let best = null;
    P.z.forEach((z, i) => {
      if (z === null) return;
      const s = strengthOf(f, z);
      const cx = x0 + band * (0.18 + 0.64 * rand());
      if (!best || s > best.s) best = { s, cx, i };
      b += `<circle cx="${cx.toFixed(1)}" cy="${y(s).toFixed(1)}" r="1.5" fill="${C.accent}" fill-opacity="0.3"/>`;
    });
    const thr = P.max.null95;
    b += line(x0 + band * 0.1, y(thr), x0 + band * 0.9, y(thr), C.ink, 2);
    if (best) b += dot(best.cx, y(best.s), 4, C.orange);
    const [l1, l2] = splitLabel(PLAIN[k].short);
    b += text(x0 + band / 2, bottom + 16, l1, { anchor: 'middle', size: 9.5, fill: C.ink2 });
    if (l2) b += text(x0 + band / 2, bottom + 28, l2, { anchor: 'middle', size: 9.5, fill: C.ink2 });
    b += text(x0 + band / 2, bottom + 41, `${num(P.eligible)}`, { anchor: 'middle', size: 8.5, fill: C.muted });
  });
  // legend
  let lx = left;
  b += `<circle cx="${lx + 4}" cy="14" r="3" fill="${C.accent}" fill-opacity="0.45"/>`;
  b += text(lx + 12, 17.5, 'one lattice, all 32 teams pooled', { size: 9.5 });
  lx += 190;
  b += dot(lx + 4, 14, 4, C.orange);
  b += text(lx + 13, 17.5, 'strongest lattice in the family', { size: 9.5 });
  lx += 185;
  b += line(lx, 14, lx + 16, 14, C.ink, 2);
  b += text(lx + 21, 17.5, '95% of pure-noise histories stay below', { size: 9.5 });
  return svg(W, H, b, 'Strength of every league-wide lattice by family, with the family-wise noise threshold');
}
const strengthOf = (f, z) => (f.sided === 'two' ? Math.abs(z) : f.sided === 'upper' ? z : -z);
function splitLabel(s) {
  if (s.length <= 11 || !s.includes(' ')) return [s];
  const k = s.lastIndexOf(' ', 11) > 0 ? s.lastIndexOf(' ', 11) : s.indexOf(' ');
  return [s.slice(0, k), s.slice(k + 1)];
}

// Figure 2: day-interval z-scores, 1-400 days, league-wide.
function figLags(L) {
  const cur = L.curves.calLag;
  const items = cur.pooled[MAIN];
  const thr = L.families.calLag.nulls[MAIN].pooled.max.null95;
  const W = 640;
  const H = 262;
  const left = 46;
  const right = 12;
  const top = 44;
  const bottom = H - 34;
  const zs = items.map((x) => x.z).filter(Number.isFinite);
  const lim = Math.max(5, Math.ceil(Math.max(thr, ...zs.map(Math.abs))));
  // log scale: the short intervals of the hand analysis get room
  const x = (d) => left + (Math.log(d) / Math.log(400)) * (W - left - right);
  const y = (z) => bottom - ((z + lim) / (2 * lim)) * (bottom - top);
  let b = '';
  for (let z = -lim; z <= lim; z++) {
    if (z % (lim > 6 ? 2 : 1)) continue;
    b += line(left, y(z), W - right, y(z), z === 0 ? C.axis : C.grid);
    b += text(left - 6, y(z) + 3.5, String(z), { anchor: 'end', size: 9.5, fill: C.muted });
  }
  for (const d of [1, 2, 3, 4, 7, 10, 14, 21, 28, 50, 100, 200, 400]) b += text(x(d), bottom + 14, String(d), { anchor: 'middle', size: 9.5, fill: C.muted });
  b += text((left + W - right) / 2, bottom + 28, 'Days between the two games (log scale)', { anchor: 'middle', size: 9.5, fill: C.ink2 });
  for (const s of [-1, 1]) b += `<line x1="${left}" y1="${y(s * thr).toFixed(1)}" x2="${W - right}" y2="${y(s * thr).toFixed(1)}" stroke="${C.ink}" stroke-width="1.2" stroke-dasharray="4 3"/>`;
  const named = new Set([4, 7, 10, 11, 14, 18, 21, 27, 28, 364]);
  const pts = [];
  items.forEach((it, k) => {
    if (!Number.isFinite(it.z)) return;
    const d = cur.lags[k];
    const hl = named.has(d);
    if (hl) pts.push({ d, cx: x(d), cy: y(it.z) });
    b += `<circle cx="${x(d).toFixed(1)}" cy="${y(it.z).toFixed(1)}" r="${hl ? 3.6 : 2.2}" fill="${hl ? C.orange : C.accent}" fill-opacity="${hl ? 1 : 0.5}" stroke="#ffffff" stroke-width="${hl ? 1.2 : 0}"/>`;
  });
  // Greedy label placement: above, below, then further out, avoiding earlier labels and dots.
  const boxes = pts.map((p) => ({ x0: p.cx - 4, x1: p.cx + 4, y0: p.cy - 4, y1: p.cy + 4 }));
  const hit = (r) => boxes.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
  for (const p of pts.sort((a2, b2) => a2.cx - b2.cx)) {
    const label = `${p.d}d`;
    const w = 6 * label.length;
    for (const dy of [-10, 16, -22, 28, -34, 40]) {
      const ty = p.cy + dy;
      const r = { x0: p.cx - w / 2, x1: p.cx + w / 2, y0: ty - 9, y1: ty + 2 };
      if (ty < top - 2 || ty > bottom - 2 || hit(r)) continue;
      boxes.push(r);
      if (Math.abs(dy) > 16) b += line(p.cx, p.cy + Math.sign(dy) * 4, p.cx, ty + (dy < 0 ? 2 : -9), C.ink2, 0.8);
      b += text(p.cx, ty, label, { anchor: 'middle', size: 8.5, fill: C.ink, halo: true });
      break;
    }
  }
  b += `<line x1="${left}" y1="13" x2="${left + 18}" y2="13" stroke="${C.ink}" stroke-width="1.2" stroke-dasharray="4 3"/>`;
  b += text(left + 24, 16.5, 'family-wise 95% noise band', { size: 9.5 });
  b += `<circle cx="${left + 190}" cy="13" r="2.4" fill="${C.accent}" fill-opacity="0.6"/>`;
  b += text(left + 198, 16.5, 'one interval', { size: 9.5 });
  b += dot(left + 282, 13, 3.6, C.orange);
  b += text(left + 290, 16.5, 'intervals named in the hand analysis', { size: 9.5 });
  b += text(W - right, 34, 'above 0: repeats · below 0: reversals', { anchor: 'end', size: 9, fill: C.muted });
  return svg(W, H, b, 'Same-result z-score for every day interval from 1 to 400 days, league-wide');
}

// Figure 3: families x teams, each team's family-wise p-value.
const HEAT = [
  [0.001, '#0d366b', '< 0.001'],
  [0.01, '#1c5cab', '0.001-0.01'],
  [0.05, '#3987e5', '0.01-0.05'],
  [0.2, '#86b6ef', '0.05-0.2'],
  [1.01, '#cde2fb', '0.2 or more'],
];
const heatColor = (p) => HEAT.find(([cut]) => p < cut)[1];
function figHeat(L) {
  const keys = fams(L);
  const teams = L.settings.teams;
  const W = 640;
  const left = 118;
  const right = 58;
  const top = 44;
  const cw = (W - left - right) / teams.length;
  const ch = 17;
  const H = top + keys.length * ch + 40;
  let b = '';
  teams.forEach((t, c) => {
    const cx = left + c * cw + cw / 2;
    b += `<text x="${cx.toFixed(1)}" y="${top - 6}" font-size="8" fill="${t === L.team ? C.ink : C.ink2}" font-weight="${t === L.team ? 700 : 400}" text-anchor="start" transform="rotate(-60 ${cx.toFixed(1)} ${top - 6})">${esc(t)}</text>`;
  });
  b += text(W - right + 6, top - 6, 'flagged', { size: 8.5, fill: C.ink2 });
  keys.forEach((k, r) => {
    const f = L.families[k];
    const cy = top + r * ch;
    b += text(left - 8, cy + ch / 2 + 3.5, PLAIN[k].name, { anchor: 'end', size: 9, fill: C.ink2 });
    f.nulls[MAIN].teams.perTeam.forEach((pt, c) => {
      const x0 = left + c * cw;
      b += `<rect x="${(x0 + 1).toFixed(1)}" y="${(cy + 1).toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${ch - 2}" rx="2" fill="${heatColor(pt.p)}"/>`;
      if (pt.p < 0.05) b += `<circle cx="${(x0 + cw / 2).toFixed(1)}" cy="${(cy + ch / 2).toFixed(1)}" r="2" fill="#ffffff"/>`;
    });
    const s = f.nulls[MAIN].teams.sig;
    b += text(W - right + 6, cy + ch / 2 + 3.5, `${s.real} vs ${n1(s.nullMean)}`, { size: 9, fill: C.ink });
  });
  let lx = left;
  const ly = top + keys.length * ch + 16;
  b += text(lx - 8, ly + 8, 'Team’s p-value', { anchor: 'end', size: 9, fill: C.ink2 });
  for (const [, col, lab] of HEAT) {
    b += `<rect x="${lx}" y="${ly}" width="12" height="11" rx="2" fill="${col}"/>`;
    b += text(lx + 16, ly + 9, lab, { size: 9 });
    lx += 26 + lab.length * 5.2;
  }
  b += `<circle cx="${lx + 6}" cy="${ly + 5.5}" r="2.4" fill="#ffffff" stroke="${C.ink2}" stroke-width="0.8"/>`;
  b += text(lx + 14, ly + 9, 'p < 0.05', { size: 9 });
  return svg(W, H, b, 'Family-wise p-value of every team in every family');
}

// Figure 4: did each team's strongest 1999-2012 lattice hold up in 2013-2025?
function figSplit(L) {
  const keys = fams(L);
  const W = 640;
  const left = 150;
  const right = 118;
  const top = 34;
  const rowH = 21;
  const H = top + keys.length * rowH + 34;
  const vals = keys.flatMap((k) => {
    const s = L.families[k].nulls[MAIN].teams.split.top1;
    return [s.real, s.null05, s.null95];
  });
  const lim = Math.max(1, Math.ceil(Math.max(...vals.map(Math.abs)) * 2) / 2);
  const x = (v) => left + ((v + lim) / (2 * lim)) * (W - left - right);
  let b = '';
  for (let v = -lim; v <= lim + 1e-9; v += 0.5) {
    b += line(x(v), top - 6, x(v), H - 30, v === 0 ? C.axis : C.grid);
    b += text(x(v), H - 16, v.toFixed(1), { anchor: 'middle', size: 9.5, fill: C.muted });
  }
  b += text(x(0), H - 3, 'Average z in 2013-2025 of each team’s strongest 1999-2012 lattice (+ = it held)', { anchor: 'middle', size: 9.5, fill: C.ink2 });
  b += text(W - right + 10, top - 12, 'held / expected', { size: 9, fill: C.ink2 });
  keys.forEach((k, r) => {
    const s = L.families[k].nulls[MAIN].teams.split;
    const cy = top + r * rowH + rowH / 2;
    b += text(left - 10, cy + 3.5, PLAIN[k].name, { anchor: 'end', size: 9.5, fill: C.ink2 });
    b += `<rect x="${x(s.top1.null05).toFixed(1)}" y="${(cy - 4).toFixed(1)}" width="${(x(s.top1.null95) - x(s.top1.null05)).toFixed(1)}" height="8" rx="4" fill="${C.grid}"/>`;
    b += dot(x(s.top1.real), cy, 4.5, C.accent);
    b += text(W - right + 10, cy + 3.5, `${s.held.real} / ${n1(s.held.nullMean)} of 32`, { size: 9.5, fill: C.ink });
  });
  b += `<rect x="${left}" y="8" width="22" height="8" rx="4" fill="${C.grid}"/>`;
  b += text(left + 28, 15.5, '90% of pure-noise histories', { size: 9.5 });
  b += dot(left + 200, 12, 4.5, C.accent);
  b += text(left + 209, 15.5, 'real data', { size: 9.5 });
  return svg(W, H, b, 'Split-half check: strongest early lattices scored on later seasons');
}

// Figure 5: win rate after short streaks, real vs. the spread-weighted shuffle.
function figStreaks(L) {
  const cur = L.curves.markov;
  const idx = cur.labels.map((l, i) => [l, i]).filter(([l]) => l.split('-').length <= 3);
  const items = cur.pooled[MAIN];
  const W = 640;
  const left = 96;
  const right = 90;
  const top = 30;
  const rowH = 17;
  const H = top + idx.length * rowH + 34;
  const lo = 0.38;
  const hi = 0.62;
  const x = (v) => left + ((v - lo) / (hi - lo)) * (W - left - right);
  let b = '';
  for (let v = 0.4; v <= 0.6 + 1e-9; v += 0.05) {
    b += line(x(v), top - 6, x(v), H - 30, Math.abs(v - 0.5) < 1e-9 ? C.axis : C.grid);
    b += text(x(v), H - 16, pct(v, 0), { anchor: 'middle', size: 9.5, fill: C.muted });
  }
  b += text(x(0.5), H - 3, 'Win rate in the next game (all 32 teams)', { anchor: 'middle', size: 9.5, fill: C.ink2 });
  b += text(W - right + 10, top - 12, 'games', { size: 9, fill: C.ink2 });
  idx.forEach(([label, i], r) => {
    const it = items[i];
    const cy = top + r * rowH + rowH / 2;
    b += text(left - 10, cy + 3.5, label, { anchor: 'end', size: 9.5, fill: C.ink2 });
    const a = it.nullRate - 1.96 * it.nullSd;
    const c = it.nullRate + 1.96 * it.nullSd;
    b += `<rect x="${x(a).toFixed(1)}" y="${(cy - 3.5).toFixed(1)}" width="${(x(c) - x(a)).toFixed(1)}" height="7" rx="3.5" fill="${C.grid}"/>`;
    b += line(x(it.nullRate), cy - 5, x(it.nullRate), cy + 5, C.ink2, 1.5);
    b += dot(x(it.rate), cy, 4, C.accent);
    b += text(W - right + 10, cy + 3.5, num(it.n), { size: 9.5, fill: C.ink });
  });
  b += `<rect x="${left}" y="8.5" width="22" height="7" rx="3.5" fill="${C.grid}"/>`;
  b += line(left + 11, 7, left + 11, 17, C.ink2, 1.5);
  b += text(left + 28, 15.5, 'expected from the schedule and records (95% range)', { size: 9.5 });
  b += dot(left + 320, 12, 4, C.accent);
  b += text(left + 329, 15.5, 'real win rate', { size: 9.5 });
  return svg(W, H, b, 'Win rate after streak patterns, real versus expected');
}

// Figure 6: periodograms (league average), real vs. the null band.
function figSpectrum(L, key, { unit, ticks }) {
  const cur = L.curves[key];
  const items = cur.pooled[MAIN];
  const periods = cur.periods;
  const W = 640;
  const H = 190;
  const left = 46;
  const right = 12;
  const top = 26;
  const bottom = H - 34;
  const lp = periods.map(Math.log);
  const xMin = Math.min(...lp);
  const xMax = Math.max(...lp);
  const x = (p) => left + ((Math.log(p) - xMin) / (xMax - xMin)) * (W - left - right);
  const hiBand = items.map((it) => it.nullMean + 1.96 * it.nullSd);
  const yMax = Math.max(...items.map((it) => it.value), ...hiBand) * 1.08;
  const y = (v) => bottom - (v / yMax) * (bottom - top);
  let b = '';
  const step = yMax > 2 ? 1 : yMax > 1 ? 0.5 : 0.25;
  for (let v = 0; v <= yMax; v += step) {
    b += line(left, y(v), W - right, y(v), v === 0 ? C.axis : C.grid);
    b += text(left - 6, y(v) + 3.5, v.toFixed(step < 1 ? 2 : 0), { anchor: 'end', size: 9.5, fill: C.muted });
  }
  for (const t of ticks) b += text(x(t), bottom + 14, String(t), { anchor: 'middle', size: 9.5, fill: C.muted });
  b += text((left + W - right) / 2, bottom + 28, `Cycle length (${unit}, log scale)`, { anchor: 'middle', size: 9.5, fill: C.ink2 });
  // band as a polygon, sorted by x
  const order = periods.map((p, i) => i).sort((a, c) => periods[a] - periods[c]);
  const up = order.map((i) => `${x(periods[i]).toFixed(1)},${y(items[i].nullMean + 1.96 * items[i].nullSd).toFixed(1)}`);
  const dn = order
    .slice()
    .reverse()
    .map((i) => `${x(periods[i]).toFixed(1)},${y(Math.max(0, items[i].nullMean - 1.96 * items[i].nullSd)).toFixed(1)}`);
  b += `<polygon points="${[...up, ...dn].join(' ')}" fill="${C.grid}" fill-opacity="0.9"/>`;
  const path = (f) => order.map((i, k) => `${k ? 'L' : 'M'}${x(periods[i]).toFixed(1)},${y(f(items[i])).toFixed(1)}`).join(' ');
  b += `<path d="${path((it) => it.nullMean)}" fill="none" stroke="${C.ink2}" stroke-width="1" stroke-dasharray="3 2"/>`;
  b += `<path d="${path((it) => it.value)}" fill="none" stroke="${C.accent}" stroke-width="2" stroke-linejoin="round"/>`;
  b += `<rect x="${left}" y="8" width="18" height="8" fill="${C.grid}"/>`;
  b += text(left + 24, 15.5, 'noise: 95% range', { size: 9.5 });
  b += `<line x1="${left + 130}" y1="12" x2="${left + 148}" y2="12" stroke="${C.ink2}" stroke-dasharray="3 2"/>`;
  b += text(left + 154, 15.5, 'noise: average', { size: 9.5 });
  b += line(left + 250, 12, left + 268, 12, C.accent, 2);
  b += text(left + 274, 15.5, 'real data (average over 32 teams)', { size: 9.5 });
  return svg(W, H, b, `Periodogram of results by ${unit}, real versus noise`);
}

// Figure 7: season-level echoes, lag 1-26 seasons.
function figSeasons(L) {
  const S = L.seasons;
  const W = 640;
  const H = 230;
  const left = 46;
  const right = 12;
  const top = 30;
  const bottom = H - 34;
  const vals = S.lags.flatMap((x) => [x.r, x.perm.lo, x.perm.hi, x.market.mean]);
  const lim = Math.ceil(Math.max(...vals.map(Math.abs)) * 10) / 10;
  const n = S.lags.length;
  const bw = (W - left - right) / n;
  const x = (L0) => left + (L0 - 0.5) * bw;
  const y = (v) => bottom - ((v + lim) / (2 * lim)) * (bottom - top);
  let b = '';
  for (let v = -lim; v <= lim + 1e-9; v += 0.1) {
    b += line(left, y(v), W - right, y(v), Math.abs(v) < 1e-9 ? C.axis : C.grid);
    b += text(left - 6, y(v) + 3.5, (Math.abs(v) < 1e-9 ? 0 : v).toFixed(1), { anchor: 'end', size: 9.5, fill: C.muted });
  }
  for (const s of S.lags) {
    const cx = x(s.lag);
    b += `<rect x="${(cx - bw * 0.3).toFixed(1)}" y="${y(s.perm.hi).toFixed(1)}" width="${(bw * 0.6).toFixed(1)}" height="${(y(s.perm.lo) - y(s.perm.hi)).toFixed(1)}" rx="3" fill="${C.grid}"/>`;
    b += line(cx - bw * 0.32, y(s.market.mean), cx + bw * 0.32, y(s.market.mean), C.orange, 2);
    b += dot(cx, y(s.r), 4, C.accent);
    const hl = S.highlight.includes(s.lag);
    b += text(cx, bottom + 14, String(s.lag), { anchor: 'middle', size: 9, fill: hl ? C.ink : C.muted, weight: hl ? 700 : 400 });
  }
  b += text((left + W - right) / 2, bottom + 28, 'Seasons apart', { anchor: 'middle', size: 9.5, fill: C.ink2 });
  b += `<rect x="${left}" y="8" width="16" height="9" rx="3" fill="${C.grid}"/>`;
  b += text(left + 22, 15.5, 'no memory: 95% range', { size: 9.5 });
  b += line(left + 150, 12, left + 168, 12, C.orange, 2);
  b += text(left + 174, 15.5, 'what the point spreads imply', { size: 9.5 });
  b += dot(left + 350, 12, 4, C.accent);
  b += text(left + 359, 15.5, 'real correlation', { size: 9.5 });
  return svg(W, H, b, 'Correlation of season win rates L seasons apart');
}

// Figure 8: accuracy of every league-wide model, walk-forward 2004-2025.
function figML(L) {
  const models = L.ml.models;
  const W = 640;
  const left = 232;
  const right = 60;
  const top = 34;
  const rowH = 20;
  const H = top + models.length * rowH + 34;
  const lo = 0.48;
  const hi = 0.7;
  const x = (v) => left + ((v - lo) / (hi - lo)) * (W - left - right);
  let b = '';
  for (let v = 0.5; v <= hi + 1e-9; v += 0.05) {
    b += line(x(v), top - 8, x(v), H - 30, C.grid);
    b += text(x(v), H - 16, pct(v, 0), { anchor: 'middle', size: 9.5, fill: C.muted });
  }
  b += text(x((lo + hi) / 2), H - 3, 'Share of games called correctly, 2004-2025 (both sides of every game)', { anchor: 'middle', size: 9.5, fill: C.ink2 });
  const mk = models.find((m) => m.key === 'market').overall.accuracy;
  b += line(x(mk), top - 14, x(mk), H - 30, C.ink2, 1);
  b += text(x(mk) - 5, top - 17, `Point spread ${pct(mk)}`, { size: 9.5, fill: C.ink2, anchor: 'end' });
  models.forEach((m, i) => {
    const cy = top + i * rowH + rowH / 2;
    const hl = m.group === 'lattice' || m.group === 'team';
    const col = m.key === 'market' ? C.ink : hl ? C.accent : C.context;
    const [a, c] = wilson(Math.round(m.overall.accuracy * m.overall.n), m.overall.n);
    b += text(left - 12, cy + 3.5, m.label, { anchor: 'end', size: 9.5, fill: hl ? C.ink : C.ink2 });
    b += line(x(a), cy, x(c), cy, col, 2);
    b += dot(x(m.overall.accuracy), cy, 4.5, col);
    b += text(x(c) + 8, cy + 3.5, pct(m.overall.accuracy), { size: 9.5, fill: C.ink, halo: true });
  });
  return svg(W, H, b, 'Out-of-sample accuracy of every model');
}

// ------------------------------------------------------------------ document
export function renderLabHtml(L) {
  const team = L.team;
  const teamName = TEAM_NAMES[team] ?? team;
  const V = verdicts(L);
  const F = L.families;
  const keys = fams(L);
  const nl = L.nullLabels;
  const reps = L.settings.reps;
  const signalMain = V.filter((v) => v.signalMain);
  const signalOther = V.filter((v) => v.signalOther);
  const flagged = keys.reduce((s, k) => s + F[k].nulls[MAIN].teams.sig.real, 0);
  const flaggedExp = keys.reduce((s, k) => s + F[k].nulls[MAIN].teams.sig.nullMean, 0);
  const held = keys.reduce((s, k) => s + F[k].nulls[MAIN].teams.split.held.real, 0);
  const heldExp = keys.reduce((s, k) => s + F[k].nulls[MAIN].teams.split.held.nullMean, 0);
  const heldN = keys.length * L.settings.teams.length;
  const ml = L.ml.models;
  const mlBy = Object.fromEntries(ml.map((m) => [m.key, m]));
  const bestLattice = ml.filter((m) => m.group === 'lattice' || m.group === 'team').sort((a, b) => b.overall.accuracy - a.overall.accuracy)[0];
  const lat = ml.filter((m) => m.group === 'lattice' || m.group === 'team');
  const latRange = [Math.min(...lat.map((m) => m.overall.accuracy)), Math.max(...lat.map((m) => m.overall.accuracy))];
  const allBehind = lat.every((m) => m.overall.accuracy < mlBy.market.overall.accuracy);
  const comboWorse = mlBy.marketLattice.vsMarket.dLogLoss > 0;
  const mlVerdict = `${allBehind ? 'Every lattice-based model predicts worse than the point spread' : 'Some lattice-based models match the point spread'}, and adding lattice inputs to the spread makes it ${comboWorse ? 'worse, not better' : 'slightly better'}.`;
  const html = [];
  const push = (s) => html.push(s);

  // ---------------------------------------------------------------- cover
  push(`<div class="kicker">Lattice lab · all 32 NFL teams · ${L.settings.from}-${L.settings.to}</div>
<h1>Do NFL results follow calendar lattices?</h1>
<p class="lede">${num(L.hypotheses)} lattices on every franchise, ten families of patterns, two null models, a hold-out test on later seasons, season cycles and thirteen prediction models${L.own ? ', then lattices of my own against the point spread' : ''}. ${signalMain.length ? `${signalMain.length} of ${keys.length} families show structure beyond the schedule` : 'None survives once each team’s schedule is accounted for'}.</p>
<p class="meta">Generated ${esc(L.generated.slice(0, 10))} · ${num(L.ml.rows)} team-games (both sides of ${num(L.ml.rows / 2)} games, ties left out) · ${num(reps)} null histories of each kind per test · data: nflverse games.csv</p>
<div class="tiles">
  <div class="tile hl"><div class="label">Lattice families with a league-wide signal after correction</div><div class="value">${signalMain.length} of ${keys.length}</div><div class="note">spread-weighted shuffle, p &lt; ${ALPHA}</div></div>
  <div class="tile"><div class="label">Team-family pairs flagged as a team’s own lattice</div><div class="value">${flagged}</div><div class="note">${n1(flaggedExp)} expected from noise alone, out of ${keys.length * 32}</div></div>
  <div class="tile"><div class="label">Teams’ best 1999-2012 lattices that held their direction in 2013-2025</div><div class="value">${pct(held / heldN, 0)}</div><div class="note">${held} of ${heldN}; ${pct(heldExp / heldN, 0)} expected from noise</div></div>
  <div class="tile"><div class="label">Best lattice model, games called correctly</div><div class="value">${pct(bestLattice.overall.accuracy)}</div><div class="note">${esc(bestLattice.label.replace('Lattice: ', ''))}; point spread ${pct(mlBy.market.overall.accuracy)}</div></div>
  <div class="tile"><div class="label">Adding lattice inputs to the point spread</div><div class="value">${mlBy.marketLattice.vsMarket.dLogLoss > 0 ? 'Worse' : 'Better'}</div><div class="note">log loss ${mlBy.marketLattice.vsMarket.dLogLoss > 0 ? '+' : ''}${mlBy.marketLattice.vsMarket.dLogLoss.toFixed(4)}; better in ${mlBy.marketLattice.vsMarket.seasonsBetter} of ${mlBy.marketLattice.vsMarket.seasons} seasons</div></div>
</div>`);

  const verdictLine = signalMain.length
    ? `Only ${signalMain.map((v) => PLAIN[v.key].name.toLowerCase()).join(', ')} ${signalMain.length === 1 ? 'shows' : 'show'} anything beyond chance once the schedule is accounted for, and ${signalMain.length === 1 ? 'it does' : 'they do'} not help predict games (section 7).`
    : 'No family of lattices beats chance once each team’s schedule is accounted for.';
  const otherOnly = signalOther.filter((v) => !v.signalMain);
  const otherLine = otherOnly.length
    ? `Under the plain shuffle, which ignores opponents and venues, ${otherOnly.map((v) => PLAIN[v.key].name.toLowerCase()).join(' and ')} ${otherOnly.length === 1 ? 'shows' : 'show'} weak, diffuse structure; it disappears under the spread-weighted shuffle, so it comes from who played whom and where, not from the calendar.`
    : 'The plain shuffle, which ignores opponents and venues, finds nothing either.';
  push(`<div class="callout"><p><b>Bottom line.</b> ${verdictLine} ${otherLine} No team has more “own lattices” than noise produces (${flagged} flags against ${n1(flaggedExp)} expected). ${mlVerdict}${L.own ? ` Part II: ${ownSummary(L).line.replace(/^./, (c) => c.toUpperCase())}` : ''}</p></div>`);

  push(`<h3>What the lab did</h3>
<ul>
<li><b>Ten families of lattices</b> (section 1): day intervals, two- and three-lookback calendar rules like 28/10, the 10-day / 4th-previous type, game-count repeats, streaks, phases (day number mod n), cycles in game order and in calendar time, and compressibility. ${num(L.hypotheses)} individual lattices in all, each tested on every team and on all 32 pooled.</li>
<li><b>Two null models</b>, both keeping every team’s exact record in every season: a <i>shuffle</i> deals each season’s results out in random order; a <i>spread-weighted shuffle</i> deals the same wins out again but lets them land more often on games the team was favored in, so it also keeps who played whom and where. A lattice is real only if it beats both.</li>
<li><b>Four kinds of evidence</b> per family: the strongest single lattice (corrected for the whole family), many weak lattices at once, each team’s own lattice (${num(reps)} null histories per team), and a hold-out test: patterns found in 1999-2012 scored on 2013-2025.</li>
<li><b>Calibration and power</b> (section 8): on pure noise the engine flags about as many teams as chance predicts, and it finds lattices planted in noise.</li>
<li><b>Season cycles</b> (the 23-year idea) and <b>thirteen prediction models</b> trained league-wide, walk-forward, against the point spread.${L.own ? ` <b>Part II</b> (sections 9-12) adds lattices of my own, scored against the spread and registered for the rest of 2026.` : ''}</li>
</ul>`);

  // ---------------------------------------------------------------- 1. what was tested
  push(`<section class="page"><h2><span class="no">1</span>What was tested</h2>
<p>Each family is a whole set of lattices of one kind. A lattice is scored by how far its real record is from what the null model expects, as a z-score (0 = exactly as expected; beyond ±2 is unusual for one lattice, but with thousands of lattices some will be).</p>
${table(
  ['Family', 'What it asks', 'Example', 'Lattices'],
  keys.map((k) => [`<b>${PLAIN[k].name}</b>`, PLAIN[k].what, PLAIN[k].example, num(F[k].items)]),
  { num: [3] },
)}
<h3>The two null models</h3>
<div class="two"><div class="rule"><b>${esc(nl.shuffle)}.</b> Every team keeps its exact won-lost record in every season, but the order of the results within the season is random. Anything a lattice finds beyond this is order that the season records alone do not explain.</div>
<div class="rule"><b>${esc(nl.spread)}.</b> Same records, but each game’s chance of being one of the wins follows the point spread (odds proportional to e<sup>b·spread</sup>, b = ${L.market.bWithin.toFixed(3)} fitted on how wins fall within team-seasons). Favored games take the wins more often, so the schedule — opponent strength, home and away, rest — is built in. This is the main null.</div></div>
<p class="small">Every test draws ${num(reps)} histories from each null. The first ${num(reps)} learn what each lattice looks like under the null; a second, independent ${num(reps)} are scored exactly like the real history, so the real data is compared with like. The z-scores use the observed spread of each lattice across null histories, so overlapping cases and small samples are accounted for.</p>
</section>`);

  // ---------------------------------------------------------------- 2. league-wide
  const cell = (p) =>
    p === null || p === undefined ? '<td class="num muted">–</td>' : `<td class="num${p < ALPHA ? ' sig2' : p < 0.05 ? ' sig1' : ''}">${fp(p)}</td>`;
  const matrixRows = V.map((v) => {
    const f = F[v.key];
    const s = f.nulls[MAIN].teams.sig;
    const so = f.nulls[OTHER].teams.sig;
    return `<tr><td><b>${PLAIN[v.key].name}</b></td>${cell(v.main.max)}${cell(v.main.dense)}<td class="num">${s.real} / ${n1(s.nullMean)}</td>${cell(v.main.teams)}${cell(v.main.held)}<td class="split"></td>${cell(v.other.max)}${cell(v.other.dense)}<td class="num">${so.real} / ${n1(so.nullMean)}</td>${cell(v.other.held)}</tr>`;
  }).join('');
  push(`<section class="page"><h2><span class="no">2</span>League-wide: the summary matrix</h2>
<p>One row per family, one column per kind of evidence. Each number is a p-value: the share of noise histories that did at least as well as the real one. Small is interesting; ${ALPHA} is the bar after correcting for ten families (shaded dark), 0.05 is shaded light.</p>
<p class="tcap"><b>Table 1.</b> p-values by family and test. “Teams flagged” = teams whose own strongest lattice beats noise at p &lt; 0.05, real / expected from noise.</p>
<table class="mx keep"><thead><tr><th rowspan="2">Family</th><th colspan="5" class="grp">${esc(nl.spread)} (main)</th><th class="split"></th><th colspan="4" class="grp">${esc(nl.shuffle)}</th></tr>
<tr><th class="num">Strongest lattice</th><th class="num">Many weak ones</th><th class="num">Teams flagged</th><th class="num">Teams p</th><th class="num">Held up 2013-25</th><th class="split"></th><th class="num">Strongest</th><th class="num">Many weak</th><th class="num">Teams</th><th class="num">Held up</th></tr></thead><tbody>${matrixRows}</tbody></table>
<p class="small">“Strongest lattice”: the best of all 32 teams pooled, corrected for every lattice in the family. “Many weak ones”: the average squared z-score of the whole family, which picks up diffuse structure no single lattice shows. “Held up”: each team’s strongest lattice found in 1999-2012, scored on 2013-2025. Phase lattices have no pooled test (pooled, every game is one win and one loss).</p>`);

  // top items across families
  const topAll = keys
    .filter((k) => F[k].pooledTest)
    .flatMap((k) => F[k].nulls[MAIN].pooled.top.slice(0, 3).map((it) => ({ k, it, fw: F[k].nulls[MAIN].pooled.max })))
    .sort((a, b) => strengthOf(F[b.k], b.it.z) - strengthOf(F[a.k], a.it.z))
    .slice(0, 12);
  const rateCell = (k, it) =>
    F[k].kind === 'value'
      ? `${it.value.toFixed(3)} vs ${it.nullMean.toFixed(3)}`
      : `${pct(it.rate)} vs ${pct(it.nullRate)} <span class="muted">(${num(it.n)})</span>`;
  push(`<p class="tcap"><b>Table 2.</b> The strongest league-wide lattices of all families (${esc(nl.spread).toLowerCase()}). “One-off p” ignores that thousands were tried; “family p” accounts for it. Rates are same-result rates (repeat families) or win rates (streaks); cycles and compressibility show the statistic itself.</p>
${table(
  ['Family', 'Lattice', 'Real vs expected (games)', 'z', 'One-off p', 'Family p'],
  topAll.map(({ k, it }) => [PLAIN[k].name, esc(it.label), rateCell(k, it), signed(it.z), fp(it.p), fp(it.pFamily)]),
  { num: [3, 4, 5] },
)}
<figure>${figStrip(L)}<figcaption><b>Figure 1.</b> Every league-wide lattice as a dot (${num(keys.filter((k) => F[k].pooledTest).reduce((s, k) => s + F[k].nulls[MAIN].pooled.eligible, 0))} with enough games; count under each family). The black tick is the height that the strongest lattice of a pure-noise history stays below 95% of the time; a real lattice matters only above it. ${(() => {
    const over = keys.filter((k) => F[k].pooledTest && F[k].nulls[MAIN].pooled.max.real > F[k].nulls[MAIN].pooled.max.null95);
    return over.length ? `Above it: ${over.map((k) => PLAIN[k].name.toLowerCase()).join(', ')}.` : 'No family’s strongest lattice clears it.';
  })()}</figcaption></figure>
</section>`);

  // ---------------------------------------------------------------- 3. intervals & numerology
  const named = L.named;
  const cellsFor = (x, scope) => {
    const a = x.scopes[scope][MAIN];
    if (!Number.isFinite(a.z)) return [a.n ? num(a.n) : '0', '<span class="muted">too few</span>', '', ''];
    return [num(a.n), `${pct(a.rate)} vs ${pct(a.nullRate)}`, signed(a.z), fp(a.p)];
  };
  const namedRows = named.map((x) => {
    const lg = x.scopes.pooled[MAIN];
    if (!lg.n && !x.scopes[team][MAIN].n) return { cells: [esc(x.label), '<span class="muted">no two games this far apart</span>', '', '', '', '', '', '', ''] };
    return [esc(x.label), ...cellsFor(x, 'pooled'), ...cellsFor(x, team)];
  });
  const namedTable = `<table class="named"><thead><tr><th rowspan="2">Lattice</th><th colspan="4" class="grp">All 32 teams</th><th class="split"></th><th colspan="4" class="grp">${esc(teamName)}</th></tr>
<tr><th class="num">Cases</th><th class="num">Real vs expected</th><th class="num">z</th><th class="num">p</th><th class="split"></th><th class="num">Cases</th><th class="num">Real vs expected</th><th class="num">z</th><th class="num">p</th></tr></thead>
<tbody>${namedRows
    .map((r) => {
      const cells = r.cells ?? r;
      if (r.cells) return `<tr><td>${cells[0]}</td><td colspan="9">${cells[1]}</td></tr>`;
      return `<tr><td>${cells[0]}</td>${cells.slice(1, 5).map((c) => `<td class="num">${c}</td>`).join('')}<td class="split"></td>${cells.slice(5).map((c) => `<td class="num">${c}</td>`).join('')}</tr>`;
    })
    .join('')}</tbody></table>`;
  push(`<section><h2><span class="no">3</span>Day intervals and the named numbers</h2>
<p>The hand analysis singled out intervals of 3, 4, 7, 10, 11, 14, 21 and 28 days and long lags of 1380, 1764, 1998, 2160 and 2760 days. Figure 2 shows every interval from 1 to 400 days at once, league-wide. Pairs of games only exist at some intervals, mostly near whole weeks, so the dots cluster at 7, 14, 21 … days.</p>
<figure>${figLags(L)}<figcaption><b>Figure 2.</b> Same-result z-score for each day interval, all 32 teams pooled, against the ${esc(nl.spread).toLowerCase()}. Above zero the two games repeat more often than expected; below zero they reverse more often. The dashed lines are the family-wise noise band for all ${num(F.calLag.items)} intervals together: ${F.calLag.nulls[MAIN].pooled.max.real > F.calLag.nulls[MAIN].pooled.max.null95 ? 'the strongest interval crosses it' : 'no interval crosses it'}.</figcaption></figure>
<p class="tcap"><b>Table 3.</b> The intervals and rules named in the hand analysis. \u201cReal vs expected\u201d: how often the two games had the same result, against what the ${esc(nl.spread).toLowerCase()} expects. p-values are for that one lattice alone, with no correction for the others (the plain shuffle gives similar values). \u201cToo few\u201d: under ${L.settings.minN} cases.</p>
${namedTable}
${numerologyNote(L)}
</section>`);

  // ---------------------------------------------------------------- 4. teams
  const flaggedRows = keys.flatMap((k) =>
    F[k].nulls[MAIN].teams.perTeam
      .filter((pt) => pt.p < 0.05)
      .map((pt) => ({ k, pt })),
  );
  push(`<section class="page"><h2><span class="no">4</span>Does every team have its own lattice?</h2>
<p>If each franchise ran on its own pattern, some teams would stand out in some families far more often than noise allows. Figure 3 gives each team’s family-wise p-value in each family: the chance that pure noise produces a lattice as strong as that team’s best one. With 32 teams, about ${n1(0.05 * 32)} per family fall below 0.05 by luck alone.</p>
<figure>${figHeat(L)}<figcaption><b>Figure 3.</b> Each cell is one team in one family, against the ${esc(nl.spread).toLowerCase()}; darker = stronger. White dots mark p &lt; 0.05. Right: teams flagged in that family versus the number expected from noise. In all: ${flagged} flags against ${n1(flaggedExp)} expected.</figcaption></figure>
${flaggedRows.length
  ? `<p class="tcap"><b>Table 5.</b> Every flagged team-family pair, its strongest lattice, and what that lattice did on the later seasons. “Later z” is the 2013-2025 z-score of the team’s strongest 1999-2012 lattice in that family, signed so that + means it kept its direction.</p>
${table(
  ['Team', 'Family', 'Strongest lattice (1999-2025)', 'Real vs expected', 'Team p', 'Later z'],
  flaggedRows.map(({ k, pt }) => [
    `<b>${esc(pt.team)}</b>`,
    PLAIN[k].name,
    esc(pt.best?.label ?? '–'),
    pt.best ? rateCell(k, pt.best) : '–',
    fp(pt.p),
    signed(pt.split.top1),
  ]),
  { num: [4, 5] },
)}`
  : ''}
<figure>${figSplit(L)}<figcaption><b>Figure 4.</b> The hold-out test. For every team and family, the strongest lattice found in 1999-2012 was scored on 2013-2025, signed so that + means it kept going the same way. A real pattern shows up as a dot to the right of the gray noise range. Right: how many of the 32 teams’ patterns kept their direction.</figcaption></figure>
</section>`);

  // ---------------------------------------------------------------- 5. streaks, cycles
  push(`<section><h2><span class="no">5</span>Streaks, phases and cycles</h2>
<p>Streak patterns ask the momentum question directly: after W-W or L-L-L, is the next result more likely to repeat? Figure 5 compares the real win rate after every run of up to three results with what the ${esc(nl.spread).toLowerCase()} expects. The expectation is not 50%: teams that just won three straight are usually good teams, and the null keeps that.</p>
<figure>${figStreaks(L)}<figcaption><b>Figure 5.</b> Win rate in the next game after each run of results (oldest first; “W-L” = a win, then a loss), all 32 teams. The gray bar is the 95% range expected from each team’s season records and schedule. Streak family, league-wide: strongest pattern p = ${fp(F.markov.nulls[MAIN].pooled.max.p)}, whole family p = ${fp(F.markov.nulls[MAIN].pooled.meanZ2.p)}.</figcaption></figure>
<p>Cycles are the Fourier view of a lattice: a result that repeats every k games, or every P days, puts a peak in the periodogram at that cycle length. Both periodograms follow the noise band closely. The schedule’s own rhythm (weekly games, bye weeks, 17-game seasons) is in both the real data and the noise, so it cancels out.</p>
<figure>${figSpectrum(L, 'specGame', { unit: 'games', ticks: [2, 3, 4, 5, 7, 10, 17, 25, 50, 100] })}<figcaption><b>Figure 6a.</b> Cycles in game order, average over the 32 teams. Family p: strongest cycle ${fp(F.specGame.nulls[MAIN].pooled.max.p)}, all cycles together ${fp(F.specGame.nulls[MAIN].pooled.meanZ2.p)}.</figcaption></figure>
<figure>${figSpectrum(L, 'specCal', { unit: 'days', ticks: [3, 4, 7, 10, 14, 21, 28, 50, 100, 200, 400] })}<figcaption><b>Figure 6b.</b> Cycles in calendar time. Family p: strongest cycle ${fp(F.specCal.nulls[MAIN].pooled.max.p)}, all cycles together ${fp(F.specCal.nulls[MAIN].pooled.meanZ2.p)}. Phase lattices (day number mod n, including weekdays) are tested per team in Figure 3; compressibility, the catch-all test for any repeating structure, gives p = ${fp(F.lz.nulls[MAIN].pooled.max.p)} league-wide.</figcaption></figure>
</section>`);

  // ---------------------------------------------------------------- 6. seasons
  const S = L.seasons;
  const lagRow = (Lg) => S.lags.find((x) => x.lag === Lg);
  const own23 = S.team?.pairs.find((p) => p.lag === 23);
  push(`<section><h2><span class="no">6</span>Season cycles: the 23-year batches</h2>
<p>The hand analysis proposed 23-year batches (1999 − 1976 = 23; 161 = 7 × 23; 184 = 8 × 23). If seasons echo 23 years later, a team’s season win rate should correlate with its win rate 23 seasons before. Figure 7 shows that correlation for every gap from 1 to ${S.lags.length} seasons, all 32 teams pooled, each team measured from its own ${S.window.from}-${S.window.to} average.</p>
<figure>${figSeasons(L)}<figcaption><b>Figure 7.</b> Correlation between season win rates L seasons apart. Gray: the 95% range if seasons had no memory (${num(S.permReps)} random orderings of each team’s seasons). Orange: what the point spreads imply, from ${num(S.marketReps)} replays of every game. Lags 7, 8 and 23 are in bold.</figcaption></figure>
${table(
  ['Seasons apart', 'Pairs', 'Correlation', 'No memory: p', 'Corrected for 26 lags', 'Point spreads imply', 'vs. spreads: p'],
  [1, 2, 7, 8, 14, 15, 16, 23].map((Lg) => {
    const s = lagRow(Lg);
    return { cells: [String(Lg), String(s.pairs), s.r.toFixed(3), fp(s.perm.p), fp(s.perm.pFamily), s.market.mean.toFixed(3), fp(s.market.p)], cls: Lg === 23 ? 'hl' : '' };
  }),
  { num: [1, 2, 3, 4, 5, 6] },
)}
<p>${seasonText(S)}</p>
${own23 ? `<p class="tcap"><b>Table 6.</b> ${esc(teamName)} seasons 23 years apart (win rate, playoffs included).</p>
${table(['Season', 'Win rate', '23 seasons later', 'Win rate', 'Same side of average?'], own23.pairs.map((p) => [String(p.a), pct(p.rateA), String(p.b), pct(p.rateB), (p.rateA - S.team.mean) * (p.rateB - S.team.mean) > 0 ? 'yes' : 'no']), { num: [1, 3] })}` : ''}
<p class="small">Season spread check: real team-seasons stray ${pct(S.seasonSpread.real)} from each team’s average (root mean square); replays of every game from the point spread give ${pct(S.seasonSpread.market.mean)} (95% range ${pct(S.seasonSpread.market.lo)}-${pct(S.seasonSpread.market.hi)}). ${S.seasonSpread.real > S.seasonSpread.market.hi ? 'Real seasons are more lopsided than the spreads imply: the market’s errors about a team persist within a season. That is team quality the line catches up on, not a calendar lattice, and section 7 shows it cannot be turned into better predictions with lattice inputs.' : 'Real seasons are as lopsided as the spreads imply.'}</p>
</section>`);

  // ---------------------------------------------------------------- 7. ML
  const on = L.ml.orderNull;
  const mlRows = ml.map((m) => ({
    cells: [
      esc(m.label),
      pct(m.overall.accuracy),
      m.overall.logLoss.toFixed(4),
      m.vsMarket ? `${m.vsMarket.dLogLoss >= 0 ? '+' : '−'}${Math.abs(m.vsMarket.dLogLoss).toFixed(4)}` : 'benchmark',
      m.vsMarket ? `${m.vsMarket.ci[0] >= 0 ? '+' : '−'}${Math.abs(m.vsMarket.ci[0]).toFixed(4)} to ${m.vsMarket.ci[1] >= 0 ? '+' : '−'}${Math.abs(m.vsMarket.ci[1]).toFixed(4)}` : '',
      m.vsMarket ? `${m.vsMarket.seasonsBetter} / ${m.vsMarket.seasons}` : '',
    ],
    cls: m.key === 'market' ? 'hl' : '',
  }));
  push(`<section class="page"><h2><span class="no">7</span>Can any model turn lattices into predictions?</h2>
<p>Statistics can miss a pattern that a flexible model would find, so thirteen models were trained on all 32 teams at once, walk-forward: fit on every season before ${L.ml.blocks[0].split('-')[0]}, predict ${L.ml.blocks.join(', ')} in turn, never scoring a game the model had seen. The lattice inputs are each team’s last 8 results, its results exactly 1-63 days back and at the long named lags, the gaps between games and the weekday. The models range from linear (ridge, lasso) through naive Bayes, a random forest and a neural network to a pattern matcher that looks up what happened after the same recent results, gap and weekday, and per-team models that let every franchise have its own pattern.</p>
<figure>${figML(L)}<figcaption><b>Figure 8.</b> Share of games called correctly, 2004-2025, with 95% ranges. Blue: models that see only lattice inputs (and, for two, the team’s identity); black: the point spread; gray: other baselines.</figcaption></figure>
<p class="tcap"><b>Table 7.</b> Log loss rewards honest probabilities (lower is better; a coin flip scores 0.6931). Δ is the model minus the point spread: positive = worse than the spread. The range is a 95% bootstrap over seasons.</p>
${table(['Model', 'Correct', 'Log loss', 'Δ vs spread', '95% range', 'Seasons better'], mlRows, { num: [1, 2, 3, 4, 5] })}
<p>Every lattice model lands between ${pct(latRange[0])} and ${pct(latRange[1])} — better than a coin, because recent results reveal how good a team is — ${allBehind ? `and every one is behind the point spread at ${pct(mlBy.market.overall.accuracy)}` : `against ${pct(mlBy.market.overall.accuracy)} for the point spread`}. ${mlBy.perTeam.overall.accuracy < mlBy.ridge.overall.accuracy ? `Letting each team have its own model makes it worse (${pct(mlBy.perTeam.overall.accuracy)}, against ${pct(mlBy.ridge.overall.accuracy)} for one league-wide model): the “own pattern” it learns on early seasons does not carry forward.` : `Letting each team have its own model gives ${pct(mlBy.perTeam.overall.accuracy)}.`} Adding lattice inputs to the spread ${comboWorse ? 'raises' : 'lowers'} log loss by ${Math.abs(mlBy.marketLattice.vsMarket.dLogLoss).toFixed(4)} (95% range ${mlBy.marketLattice.vsMarket.ci[0].toFixed(4)} to ${mlBy.marketLattice.vsMarket.ci[1].toFixed(4)}); adding season form instead changes it by ${mlBy.marketForm.vsMarket.dLogLoss.toFixed(4)}.</p>
${on ? `<p class="tcap"><b>Table 8.</b> Order check: the same lattice models refit on ${on.ridge.accuracy.values.length} leagues whose seasons were shuffled (records kept). If the order of results carried a lattice, the real history would beat every shuffled one.</p>
${table(
  ['Model', 'Real: correct', 'Shuffled: average', 'Shuffled: 5-95%', 'Real: log loss', 'Shuffled: average'],
  Object.entries(on).map(([k, v]) => [esc(mlBy[k].label), pct(mlBy[k].overall.accuracy), pct(v.accuracy.mean), `${pct(v.accuracy.q05)}-${pct(v.accuracy.q95)}`, mlBy[k].overall.logLoss.toFixed(4), v.logLoss.mean.toFixed(4)]),
  { num: [1, 2, 3, 4, 5] },
)}
<p class="small">${orderNote(on, mlBy)}</p>` : ''}
</section>`);

  // ---------------------------------------------------------------- 8. calibration
  if (L.placebo) {
    const pl = L.placebo;
    const rows = keys.map((k) => {
      const a = pl.shuffle?.[k];
      const b = pl.spread?.[k];
      const c = (x) => (x ? [x.pooledMaxP === null ? '–' : fp(x.pooledMaxP), x.pooledMeanZ2P === null ? '–' : fp(x.pooledMeanZ2P), `${x.teamsSig} / ${n1(x.teamsSigNull)}`] : ['–', '–', '–']);
      return [PLAIN[k].name, ...c(b), ...c(a)];
    });
    push(`<section><h2><span class="no">8</span>Calibration: does the engine cry wolf?</h2>
<p>A test that flags everything is useless, and so is one that can never flag anything. To check both, one extra history was drawn from each null model — pure noise by construction — and run through the whole engine as if it were the real data, against ${num(pl.spread?.reps ?? pl.shuffle?.reps)} fresh null histories. A calibrated engine gives it ordinary p-values and flags about 1.6 teams per family.</p>
<p class="tcap"><b>Table 9.</b> The engine on pure noise: p-values and teams flagged (flagged / expected).</p>
<table class="mx keep"><thead><tr><th rowspan="2">Family</th><th colspan="3" class="grp">Noise from the ${esc(nl.spread).toLowerCase()}</th><th colspan="3" class="grp">Noise from the ${esc(nl.shuffle).toLowerCase()}</th></tr>
<tr><th class="num">Strongest</th><th class="num">Many weak</th><th class="num">Teams</th><th class="num">Strongest</th><th class="num">Many weak</th><th class="num">Teams</th></tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>
<p>${placeboNote(pl, keys)}</p>
<p class="small">A first version of the engine used null models that re-played games from the point spread without keeping season records. On this check they flagged pure noise as a pattern (real team-seasons are more lopsided than spread-based replays), so they were replaced by the two record-keeping nulls used here.</p>
${L.power ? powerHtml(L) : ''}
</section>`);
  }

  // ---------------------------------------------------------------- 9-12. my own lattices
  if (L.own) push(ownHtml(L));

  // ---------------------------------------------------------------- 9. conclusions
  const own = L.own ? ownSummary(L) : null;
  push(`<section class="page"><h2><span class="no">${L.own ? 13 : 9}</span>What it means</h2>
<div class="callout"><p><b>In plain terms:</b> across ${num(L.hypotheses)} lattices on all 32 teams since ${L.settings.from}, the results look like what you get when each team’s season record is dealt out over its schedule at random, with a bit more of the wins going to the games the betting line favored. Intervals like 7, 10, 14 and 28 days, rules like 28/10 and 10-day/4th-previous, the long numbers (1380, 1764, 1998, 2160, 2760) and the 23-year batches all sit where chance puts them.${own ? ` My own lattices do no better against the point spread: ${own.line}` : ''}</p></div>
<ul>
<li><b>Why hand-found lattices look convincing.</b> Searching many intervals and rules on one team always turns up some that were right 8 or 9 times in 10 by luck. That is why every family here is judged by its strongest lattice against the strongest lattices of noise histories, and by whether it holds up on later seasons. Patterns found that way fail on fresh seasons and on other teams, which is what happened to 28/10 and 10-day/4th-previous in the Seattle analysis.</li>
<li><b>The 3-4-7-10-11-14 numbers are the schedule.</b> NFL games fall on a weekly grid (Sunday, Monday, Thursday, the occasional Saturday), so the gaps between games cluster at a handful of values: 3, 4, 6, 7, 8, 10, 11, 13 and 14 days. They are real intervals, but they carry no information about results.</li>
<li><b>What does carry information</b> is ordinary team quality: good teams keep winning within a season and for a year or two, franchises have long eras, and the betting line captures nearly all of it. That is why the point spread calls ${pct(mlBy.market.overall.accuracy)} of games and no lattice model beats it.</li>
<li><b>What would change this verdict:</b> a lattice written down before the games it predicts, beating the point spread on those games over a few seasons. The forward ledger (<code>node cli.js ledger</code>) is set up to score exactly that${own ? `: it now holds ${own.registered} lattices dated ${own.date}, yours and mine` : ''}.</li>
</ul>
<h3>Reproduce</h3>
<pre>node cli.js lab            # this report: results/lab.json + results/lattice-lab.pdf (~12 min)
node cli.js lab --quick    # fewer null histories (~3 min)
node cli.js lab --parts own,power   # recompute only some parts
node cli.js lab-pdf        # rebuild the PDF from results/lab.json
node cli.js ledger         # score the registered lattices on games after their date</pre>
<h3>Method notes</h3>
<dl class="gloss">
<dt>z-score of a lattice</dt><dd>For repeat and streak families, (hits − n·μ) / √(n·v), where μ is the lattice’s average rate across null histories and v its observed per-case variance there (so overlap between cases is counted). For cycles and compressibility, (value − null mean) / null sd. Lattices with fewer than ${L.settings.minN} cases are skipped.</dd>
<dt>Family-wise p</dt><dd>The share of null histories whose strongest lattice in the family is at least as strong as the real strongest one. It answers “how often does noise produce a best lattice this good?” and needs no further correction within the family.</dd>
<dt>Teams flagged</dt><dd>Each team gets its own family-wise p from ${num(reps)} null histories; the count with p &lt; 0.05 is compared with the same count in every null history (each ranked against the others).</dd>
<dt>Hold-out</dt><dd>Lattices are ranked on 1999-${L.settings.discTo} and scored on ${L.settings.discTo + 1}-${L.settings.to}. The z-score in the later half is signed by the direction found earlier, so + means the pattern continued. The same pick-then-score procedure is run on every null history.</dd>
<dt>Spread-weighted shuffle</dt><dd>Within each team-season, W wins are placed on the games with probability proportional to the product of e<sup>b·spread</sup> over the chosen games (a conditional Bernoulli draw, sampled exactly by dynamic programming). b is the conditional-logit slope, ${L.market.bWithin.toFixed(3)}; across all games the spread’s slope is ${L.market.b.toFixed(3)}.</dd>
${L.own ? `<dt>Against the spread</dt><dd>A lattice picks one side of a game: the side that fits its conditions (or the other side, for a fade). Games where both sides fit, or where the point spread is missing, are skipped; pushes are not counted. A pick wins when its side covers (final margin beats the spread). The mechanism lattices were written down before any of them was scored and are corrected together (Holm). The machine search\u2019s family-wise p is the share of sign-flipped histories (each game\u2019s cover outcome flipped with probability 1/2) whose best lattice is at least as strong.</dd>` : ''}
<dt>Machine learning</dt><dd>Penalties are chosen on the last three training seasons, then refit on all training seasons. Ridge and lasso are exact logistic fits (Newton and FISTA); the forest has 100 trees, depth ≤ 8, leaves of ≥ 40 games; the network is the Seattle analysis’s (16 tanh units, 3 seeds, early stopping).</dd>
</dl>`);
  push(`<p class="small">Data: nflverse <code>games.csv</code> (Lee Sharpe), every NFL game since 1999; relocated franchises merged (OAK→LV, SD→LAC, STL→LA).${L.timings && Object.keys(L.timings).length >= 6 ? ` Run time ${Math.round(L.seconds / 60)} min.` : ''}</p></section>`);

  const css = `${CSS}
table.mx { font-size: 8.3pt; }
table.named { font-size: 8.1pt; }
table.named th.grp { text-align: center; border-bottom: 1px solid ${C.grid}; }
table.named td.split, table.named th.split { width: 8pt; border-bottom: none; }
table.mx th.grp { text-align: center; border-bottom: 1px solid ${C.grid}; }
table.mx td.split, table.mx th.split { width: 6pt; border-bottom: none; }
td.sig1 { background: ${C.accentSoft}; }
td.sig2 { background: #cde2fb; font-weight: 700; }
.muted { color: ${C.muted}; }
table.mech { font-size: 8pt; }
table.mech td { padding-top: 2.2pt; padding-bottom: 2.2pt; }
table.mech td .muted { font-size: 7.4pt; }
table.mech tr.ctl td { background: #f6f5f1; }
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lattice lab</title><style>${css}</style></head><body>${html.join('\n')}</body></html>`;
}

// ---------------------------------------------------------------- power
function powerHtml(L) {
  const P = L.power;
  const rows = P.plants.map((x) => [
    esc(x.label),
    `${pct(x.rate)} vs ${pct(x.nullRate)}`,
    num(Math.round(x.n)),
    `${x.detected} of ${x.runs}`,
    `${x.topItem} of ${x.runs}`,
    fp(x.medianP),
  ]);
  const league = P.plants.filter((x) => x.scope === 'pooled');
  const team = P.plants.filter((x) => x.scope !== 'pooled');
  const firstFound = (list) => list.find((x) => x.detected >= Math.ceil(0.8 * x.runs));
  const lf = firstFound(league.filter((x) => x.id === 'lag7'));
  const of = firstFound(league.filter((x) => x.id === 'order'));
  const tf = firstFound(team);
  const pts = (x) => `${Math.round(100 * (x.rate - x.nullRate))} points`;
  return `<h3>Would it find a real lattice?</h3>
<p>The other half of calibration is power: lattices of known strength were planted in noise histories and the engine was asked to find them (${P.runs} plantings per strength, ${num(P.reps)} null histories each).</p>
<p class="tcap"><b>Table 10.</b> Planted lattices. “Found”: the family-wise p-value (league-wide, or the team’s own) was below 0.05. “Top-ranked”: the planted lattice was the strongest of its whole family.</p>
${table(['Planted lattice', 'Planted rate vs expected', 'Cases', 'Found', 'Top-ranked', 'Median p'], rows, { num: [1, 2, 3, 4, 5] })}
<p>${lf ? `League-wide, a 7-day repeat lattice that moves the rate by about ${pts(lf)} is found ${lf.detected} times in ${lf.runs}. ` : ''}${of ? `A 10-day / 4th-previous rule is found once it repeats about ${pct(of.rate, 0)} of the time instead of ${pct(of.nullRate, 0)}, far short of the 90% the hand analysis reported for Seattle. ` : ''}${tf ? `For one team the bar is higher: Seattle’s 7-day interval must move about ${pts(tf)}.` : 'For one team, even strong lattices are hard to find.'} The engine sees lattices of the size the hand analysis described, if they span more than a handful of games, so its silence on the real results is a finding, not a blind spot.</p>`;
}

// ---------------------------------------------------------------- my own lattices
const MECH_NAMES = {
  rest3: 'More rest: 3+ days',
  bye: 'Off a bye',
  thuHome: 'Thursday home team',
  earlyWest: 'West team at 1 pm ET (fade)',
  nightWest: 'West vs East at night',
  travel: '2+ time zones (fade road)',
  revenge: 'Revenge rematch',
  bounce: 'After a 21+ point loss',
  letdown: 'After a 21+ point win (fade)',
  atsHot: '3 straight covers (fade)',
  atsCold: '3 straight non-covers',
  divDog: 'Division underdog',
  bigDog: 'Underdog by 10+',
  earlyLast: 'Weeks 1-4, bad last season',
  primeFav: 'Big favorite at night (fade)',
  moon: 'Full moon, home team (control)',
  hand1004: 'Hand rule: 10-day / 4th',
  hand2810: 'Hand rule: 28/10',
  'search-1': 'Machine lattice #1',
  'search-2': 'Machine lattice #2',
  'search-3': 'Machine lattice #3',
};
const rec = (x) => (x && x.n ? `${x.hits}/${x.n}` : '–');
const rate = (x) => (x && x.n ? pct(x.rate) : '–');

function figMechanisms(O) {
  const ms = O.mechanisms;
  const W = 640;
  const left = 186;
  const right = 16;
  const top = 42;
  const rowH = 21;
  const H = top + ms.length * rowH + 34;
  const lo = 0.25;
  const hi = 0.85;
  const x = (v) => left + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (W - left - right);
  let b = '';
  for (let v = 0.3; v <= 0.8 + 1e-9; v += 0.1) {
    b += line(x(v), top - 8, x(v), H - 30, Math.abs(v - 0.5) < 1e-9 ? C.axis : C.grid);
    b += text(x(v), H - 16, pct(v, 0), { anchor: 'middle', size: 9.5, fill: C.muted });
  }
  b += `<line x1="${x(O.breakEven).toFixed(1)}" y1="${top - 8}" x2="${x(O.breakEven).toFixed(1)}" y2="${H - 30}" stroke="${C.ink}" stroke-width="1" stroke-dasharray="4 3"/>`;
  b += text(x(O.breakEven) + 5, top - 12, 'break-even at -110: 52.4%', { size: 9, fill: C.ink2 });
  b += text((left + W - right) / 2, H - 3, 'Share of picks that covered the spread (95% range)', { anchor: 'middle', size: 9.5, fill: C.ink2 });
  ms.forEach((m, i) => {
    const cy = top + i * rowH + rowH / 2;
    b += text(left - 12, cy + 3.5, MECH_NAMES[m.id] ?? m.id, { anchor: 'end', size: 9.5, fill: m.control ? C.muted : C.ink2 });
    for (const [w, dy, col] of [['disc', -3.5, C.accent], ['valid', 3.5, C.orange]]) {
      const s = m[w];
      if (!s.n) continue;
      b += line(x(s.lo), cy + dy, x(s.hi), cy + dy, col, 1.6);
      b += `<circle cx="${x(s.rate).toFixed(1)}" cy="${(cy + dy).toFixed(1)}" r="3.3" fill="${col}" stroke="#ffffff" stroke-width="1.2"/>`;
    }
  });
  b += dot(left, 13, 3.6, C.accent);
  b += text(left + 9, 16.5, '1999-2012', { size: 9.5 });
  b += dot(left + 90, 13, 3.6, C.orange);
  b += text(left + 99, 16.5, '2013-2025', { size: 9.5 });
  return svg(W, H, b, 'Cover rate of each mechanism lattice in two periods');
}

function figResidual(O) {
  const items = [
    ...O.residual.game.map((x) => ({ ...x, label: String(x.lag), group: 'games' })),
    ...O.residual.day.map((x) => ({ ...x, label: String(x.lag), group: 'days' })),
  ].map((x) => ({ ...x, sd: x.sd ?? Math.abs(x.r / x.z) }));
  const W = 640;
  const H = 230;
  const left = 46;
  const right = 10;
  const top = 30;
  const bottom = H - 46;
  const gapSlots = 1;
  const slots = items.length + gapSlots;
  const bw = (W - left - right) / slots;
  const lim = Math.max(0.05, Math.ceil(Math.max(...items.map((x) => Math.max(Math.abs(x.r), 1.96 * x.sd))) * 50) / 50);
  const y = (v) => bottom - ((v + lim) / (2 * lim)) * (bottom - top);
  let b = '';
  const step = lim > 0.06 ? 0.02 : 0.01;
  for (let v = -lim; v <= lim + 1e-9; v += step) {
    b += line(left, y(v), W - right, y(v), Math.abs(v) < 1e-9 ? C.axis : C.grid);
    b += text(left - 6, y(v) + 3.5, (Math.abs(v) < 1e-9 ? 0 : v).toFixed(2), { anchor: 'end', size: 9, fill: C.muted });
  }
  let slot = 0;
  let prevGroup = null;
  const groupSpan = {};
  for (const it of items) {
    if (prevGroup && it.group !== prevGroup) slot += gapSlots;
    prevGroup = it.group;
    const cx = left + (slot + 0.5) * bw;
    (groupSpan[it.group] ??= []).push(cx);
    b += `<rect x="${(cx - bw * 0.32).toFixed(1)}" y="${y(1.96 * it.sd).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${(y(-1.96 * it.sd) - y(1.96 * it.sd)).toFixed(1)}" rx="3" fill="${C.grid}"/>`;
    b += dot(cx, y(it.r), 3.6, C.accent);
    b += text(cx, bottom + 13, it.label, { anchor: 'middle', size: 8.5, fill: C.muted });
    slot++;
  }
  for (const [g, xs] of Object.entries(groupSpan)) {
    b += text((xs[0] + xs[xs.length - 1]) / 2, bottom + 28, g === 'games' ? 'games apart (same season)' : 'days apart', { anchor: 'middle', size: 9.5, fill: C.ink2 });
  }
  b += `<rect x="${left}" y="8" width="16" height="9" rx="3" fill="${C.grid}"/>`;
  b += text(left + 22, 16, 'no echo: 95% range (sign-flipped histories)', { size: 9.5 });
  b += dot(left + 300, 12, 3.6, C.accent);
  b += text(left + 309, 16, 'real correlation of the two surprises', { size: 9.5 });
  return svg(W, H, b, 'Correlation of spread surprises at game and day intervals');
}

function figSearch(O) {
  const pts = O.search.lattices.filter((x) => x.valid.n);
  const W = 640;
  const H = 300;
  const left = 50;
  const right = 20;
  const top = 30;
  const bottom = H - 40;
  const dx = pts.map((p) => p.discovery.hits / p.discovery.n);
  const x0 = Math.floor(Math.min(0.5, ...dx) * 20) / 20;
  const x1 = Math.ceil(Math.max(...dx) * 20) / 20 + 0.02;
  const y0 = 0.35;
  const y1 = Math.max(0.7, x1);
  const x = (v) => left + ((v - x0) / (x1 - x0)) * (W - left - right);
  const y = (v) => bottom - ((v - y0) / (y1 - y0)) * (bottom - top);
  let b = '';
  for (let v = 0.35; v <= y1 + 1e-9; v += 0.05) {
    b += line(left, y(v), W - right, y(v), Math.abs(v - 0.5) < 1e-9 ? C.axis : C.grid);
    b += text(left - 6, y(v) + 3.5, pct(v, 0), { anchor: 'end', size: 9.5, fill: C.muted });
  }
  for (let v = x0; v <= x1 + 1e-9; v += 0.05) b += text(x(v), bottom + 14, pct(v, 0), { anchor: 'middle', size: 9.5, fill: C.muted });
  b += text((left + W - right) / 2, bottom + 30, 'Cover rate on 1999-2012, where each lattice was found', { anchor: 'middle', size: 9.5, fill: C.ink2 });
  b += text(12, (top + bottom) / 2, 'Cover rate on 2013-2025', { anchor: 'middle', size: 9.5, fill: C.ink2 }).replace('<text ', `<text transform="rotate(-90 12 ${((top + bottom) / 2).toFixed(1)})" `);
  const d0 = Math.max(x0, y0);
  const d1 = Math.min(x1, y1);
  b += `<line x1="${x(d0).toFixed(1)}" y1="${y(d0).toFixed(1)}" x2="${x(d1).toFixed(1)}" y2="${y(d1).toFixed(1)}" stroke="${C.ink2}" stroke-width="1" stroke-dasharray="3 3"/>`;
  b += text(x(d1) - 6, y(d1) + 16, 'if they held up', { anchor: 'end', size: 9, fill: C.ink2, halo: true });
  b += `<line x1="${left}" y1="${y(O.breakEven).toFixed(1)}" x2="${W - right}" y2="${y(O.breakEven).toFixed(1)}" stroke="${C.ink}" stroke-width="1" stroke-dasharray="4 3"/>`;
  b += text(W - right, y(O.breakEven) - 5, 'break-even 52.4%', { anchor: 'end', size: 9, fill: C.ink2, halo: true });
  pts.forEach((p) => {
    const vx = p.discovery.hits / p.discovery.n;
    b += dot(x(vx), y(p.valid.rate), 4.2, C.accent);
  });
  pts.slice(0, 3).forEach((p) => b += text(x(p.discovery.hits / p.discovery.n) + 7, y(p.valid.rate) + 3.5, `#${p.rank}`, { size: 9, fill: C.ink, halo: true }));
  return svg(W, H, b, 'Machine-found lattices: cover rate where found versus later');
}

function seattleNote(O, team) {
  const name = TEAM_NAMES[team] ?? team;
  const ms = O.mechanisms.filter((m) => m.team?.n >= 20);
  if (!ms.length) return '';
  const best = [...ms].sort((a, b) => a.team.p - b.team.p)[0];
  return `In ${esc(name)} games the samples are small: the most extreme, ${esc((MECH_NAMES[best.id] ?? best.id).toLowerCase())}, is ${rec(best.team)} (p = ${fp(best.team.p)}), one of ${ms.length} checked.`;
}

function teamsNote(O) {
  const ms = O.mechanisms.filter((m) => Number.isFinite(m.teams.p));
  const low = ms.filter((m) => m.teams.p < 0.05);
  const minP = Math.min(...ms.map((m) => m.teams.p));
  const holm = Math.min(1, minP * ms.length);
  return `Do the lattices work for some franchises and not others? ${low.length} of ${ms.length} show a team-to-team spread with p &lt; 0.05 (${n1(0.05 * ms.length)} expected by chance; the smallest, p = ${fp(minP)}, is ${fp(holm)} after correcting for ${ms.length}), so ${holm < 0.05 ? 'one lattice may differ by team' : 'none belongs to particular franchises either'}.`;
}

export function ownSummary(L) {
  const O = L.own;
  const real = O.mechanisms.filter((m) => !m.control && !m.id.startsWith('hand'));
  const best = [...real].sort((a, b) => a.all.p - b.all.p)[0];
  const survive = real.filter((m) => m.all.pHolm < 0.05);
  const beatBE = real.filter((m) => m.valid.n && m.valid.rate > O.breakEven);
  const v = O.search.validation;
  return {
    registered: (O.forward?.length ?? 0) + 2,
    date: O.forward?.[0]?.registered ?? L.generated.slice(0, 10),
    survive,
    best,
    beatBE,
    line: `${survive.length ? `${survive.length} of ${real.length} lattices with a physical reason survive correction` : `none of the ${real.length} lattices with a physical reason survives correction`} (strongest: ${esc((MECH_NAMES[best.id] ?? best.id).toLowerCase())}, ${pct(best.all.rate)} over 1999-2025, corrected p = ${fp(best.all.pHolm)}), and the ${O.search.lattices.length} best of ${num(O.search.tried)} machine-found lattices covered ${pct(v.rate)} of ${num(v.picks)} picks on the seasons after they were found.`,
  };
}

function ownHtml(L) {
  const O = L.own;
  const S = ownSummary(L);
  const B = O.baselines;
  const real = O.mechanisms.filter((m) => !m.control && !m.id.startsWith('hand'));
  const moon = O.mechanisms.find((m) => m.control);
  const hand = O.mechanisms.filter((m) => m.id.startsWith('hand'));
  const mechRows = O.mechanisms.map((m) => ({
    cells: [
      `<b>${esc(MECH_NAMES[m.id] ?? m.id)}</b><br><span class="muted">${esc(m.why)}</span>`,
      num(m.all.n),
      `${rate(m.all)}`,
      fp(m.all.p),
      fp(m.all.pHolm),
      rate(m.valid),
      m.fresh.n ? `${rec(m.fresh)}` : '–',
      Number.isFinite(m.teams.p) ? fp(m.teams.p) : '–',
      m.team?.n ? rec(m.team) : '–',
    ],
    cls: m.control ? 'ctl' : '',
  }));
  const R = O.residual;
  const allRes = [...R.game.map((x) => ({ ...x, kind: 'game' })), ...R.day.map((x) => ({ ...x, kind: 'day' }))];
  const minFam = [...allRes].sort((a, b) => a.pFamily - b.pFamily)[0];
  const lag1 = R.game.find((x) => x.lag === 1);
  const Sx = O.search;
  const top = Sx.lattices.slice(0, 10);
  const forward = O.forward ?? [];
  const open = forward.flatMap((r) => r.picks.filter((p) => p.cover === null).map((p) => ({ ...p, id: r.id })));
  const byGame = new Map();
  for (const p of open) {
    const k = `${p.date}|${p.game}`;
    if (!byGame.has(k)) byGame.set(k, []);
    byGame.get(k).push(p);
  }
  const line2 = (p) => `${esc(p.pick)} ${p.spread > 0 ? '−' : '+'}${Math.abs(p.spread)}`;
  const openRows = [...byGame.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, ps]) => {
      const [date, game] = k.split('|');
      const [, , away, home] = game.split('_');
      const sides = new Map();
      for (const p of ps) {
        const key = line2(p);
        if (!sides.has(key)) sides.set(key, []);
        sides.get(key).push(p.id.replace('ats-', ''));
      }
      return [date.slice(5), `${esc(away)} at ${esc(home)}`, [...sides].map(([side, ids]) => `<b>${side}</b> <span class="muted">(${ids.map((i) => esc(MECH_NAMES[i] ?? i)).join(', ')})</span>`).join('<br>')];
    });
  // picks needed to show a 55% edge beats break-even with 80% power (one-sided 5%)
  const need = (p1, p0) => Math.ceil(((1.645 * Math.sqrt(p0 * (1 - p0)) + 0.8416 * Math.sqrt(p1 * (1 - p1))) / (p1 - p0)) ** 2);
  const perSeason = Math.round(real.reduce((s, m) => s + m.all.n, 0) / real.length / 27);

  return `<section class="page"><div class="kicker">Part II</div><h2><span class="no">9</span>Lattices of my own, against the point spread</h2>
<p>Everything so far tested the lattices from the hand analysis and their relatives on wins and losses. This part looks for lattices of my own, and scores them the way that decides whether there is an edge: against the point spread. A lattice picks a side (back a team, or fade it), and the pick wins if that side covers. At the usual −110 odds a pick must win ${pct(O.breakEven)} of the time just to break even, so 50% means no edge. For reference, over ${O.windows.disc[0]}-${O.windows.valid[1]} home teams covered ${pct(B.home.all.rate)} of the time and favorites ${pct(B.favorites.all.rate)} (so underdogs ${pct(1 - B.favorites.all.rate)}).</p>
<p>First, lattices with a reason to exist, written down before any of them was scored: rest and byes, the body clock (a 1 pm Eastern kickoff is 10 am for a Pacific team; at night a Pacific team is at its daily peak), travel across time zones, short weeks, rematches, overreaction to blowouts and to cover streaks, and the betting-folklore angles (division and big underdogs, big favorites at night). A full-moon lattice is included as a control that should show nothing. The two hand-found rules are included as bets.</p>
<figure>${figMechanisms(O)}<figcaption><b>Figure 9.</b> Cover rate of each lattice in ${O.windows.disc[0]}-${O.windows.disc[1]} (blue) and ${O.windows.valid[0]}-${O.windows.valid[1]} (orange), with 95% ranges. A real edge sits right of the dashed break-even line in both periods.</figcaption></figure>
<p class="tcap"><b>Table 11.</b> The lattices with a reason, ${O.windows.disc[0]}-${O.windows.valid[1]}. “Corrected”: Holm over the ${O.mechanisms.length} lattices. “2026”: games played so far this season (through ${esc(O.lastPlayed)}), not used anywhere else. “Teams differ”: p-value that the cover rate differs by team (32 teams, chi-square). “Seattle”: picks in Seattle games.</p>
<table class="mech"><thead><tr><th>Lattice</th><th class="num">Picks</th><th class="num">Covered</th><th class="num">p</th><th class="num">Corrected</th><th class="num">2013-25</th><th class="num">2026</th><th class="num">Teams differ</th><th class="num">Seattle</th></tr></thead>
<tbody>${mechRows.map((r) => `<tr class="${r.cls}">${r.cells.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>
<p>${S.survive.length ? `${S.survive.length} lattice${S.survive.length > 1 ? 's' : ''} survive${S.survive.length > 1 ? '' : 's'} the correction.` : `None survives the correction.`} The strongest, ${esc((MECH_NAMES[S.best.id] ?? S.best.id).toLowerCase())}, covered ${pct(S.best.all.rate)} of ${num(S.best.all.n)} picks (corrected p = ${fp(S.best.all.pHolm)}) and ${pct(S.best.valid.rate)} in ${O.windows.valid[0]}-${O.windows.valid[1]}${S.best.valid.rate < O.breakEven ? ', below break-even' : ''}. ${S.beatBE.length} of ${real.length} beat the break-even line on ${O.windows.valid[0]}-${O.windows.valid[1]}, about what luck gives when the true rate is 50-51%. The moon control covered ${pct(moon.all.rate)}. The hand rules as bets: ${hand.map((m) => `${esc((MECH_NAMES[m.id] ?? m.id).replace('Hand rule: ', ''))} ${rec(m.all)} (${pct(m.all.rate)}, p = ${fp(m.all.p)})`).join('; ')}, on every team since ${O.windows.disc[0]}. ${teamsNote(O)} ${seattleNote(O, L.team)}</p>
</section>
<section><h2><span class="no">10</span>What the market did not expect</h2>
<p>The spread is the market’s best guess of the margin; the surprise is the real margin minus the spread. If any lattice drove results beyond what the market knows, surprises would echo: a team that beat the spread would beat it again a set number of games or days later. Figure 10 correlates each team’s surprises at every interval from 1 to 8 games and at ${R.day.length} day intervals, against ${num(O.residual.reps ?? 2000)} histories where each game’s surprise had its sign flipped at random.</p>
<figure>${figResidual(O)}<figcaption><b>Figure 10.</b> Correlation between a team’s spread surprises at the given interval, all teams ${O.windows.disc[0]}-${O.windows.valid[1]}. Gray: the range that surprises with no echo produce 95% of the time. One game apart: r = ${lag1.r.toFixed(3)}. The most extreme interval, ${minFam.lag} ${minFam.kind === 'game' ? 'games' : 'days'} apart (r = ${minFam.r.toFixed(3)}, ${num(minFam.pairs)} pairs), has a family-wise p of ${fp(minFam.pFamily)}.</figcaption></figure>
<p>Surprises do not echo: beating the spread one week says nothing about the next week, or about the game 7, 14 or 28 days later. This is the cleanest test of the lattice idea, because it removes everything the market already prices in. If a calendar rhythm moved results, this is where it would show.</p>
</section>
<section class="page"><h2><span class="no">11</span>A machine search for lattices</h2>
<p>Last, I let the computer look. A grammar of ${Sx.atoms} yes/no facts known before kickoff (home or road, the spread, rest and rest difference, weekday, kickoff time, time zones and body clock, month, week, previous results and covers of both teams, streaks, results exactly 7, 14, 21 and 28 days before, the 10-day gap and 4th-previous pattern, the 28/10 pattern, the last meeting with the opponent, this and last season’s record, the moon) combined into every lattice of one or two facts and, for the most promising pairs, three: ${num(Sx.tried)} lattices, of which ${num(Sx.testable)} made at least ${Sx.minN} picks on ${O.windows.disc[0]}-${O.windows.disc[1]}. Each was scored as a back or a fade, whichever did better.</p>
<p>The best reached z = ${Sx.lattices[0].discovery.z.toFixed(2)} (${Sx.lattices[0].discovery.hits} of ${Sx.lattices[0].discovery.n} picks). That sounds like p &lt; 0.001, but the same search run on ${num(Sx.nullReps)} histories where every game’s cover was a coin flip finds a best lattice of z = ${Sx.nullMax.mean.toFixed(2)} on average (95% of the time below ${Sx.nullMax.q95.toFixed(2)}). Family-wise p = ${fp(Sx.lattices[0].pFamily)}: the best lattice is exactly as good as the best lattice in noise.</p>
<figure>${figSearch(O)}<figcaption><b>Figure 11.</b> The ${Sx.lattices.length} best machine-found lattices (duplicates that pick the same games removed): cover rate where they were found against cover rate on the ${O.windows.valid[0]}-${O.windows.valid[1]} seasons. Real lattices would sit near the diagonal; these fall back to about 50%. Together they covered ${pct(Sx.validation.rate)} of ${num(Sx.validation.picks)} later picks; ${Sx.validation.above50} of ${Sx.lattices.length} stayed above 50% and ${Sx.validation.aboveBreakEven} above break-even.</figcaption></figure>
<p class="tcap"><b>Table 12.</b> The ten best machine-found lattices.</p>
${table(
  ['#', 'Lattice', 'Found on 1999-2012', 'Family p', '2013-2025', '2026'],
  top.map((x) => [String(x.rank), esc(x.text), `${x.discovery.hits}/${x.discovery.n} (${pct(x.discovery.hits / x.discovery.n)})`, fp(x.pFamily), `${rec(x.valid)} (${rate(x.valid)})`, x.fresh.n ? rec(x.fresh) : '–']),
  { num: [0, 2, 3, 4, 5] },
)}
</section>
<section class="page"><h2><span class="no">12</span>Registered for the rest of 2026</h2>
<p>A lattice found in old games can only be tested fairly on games that have not been played. So every lattice in this part — the ${O.mechanisms.length} with a reason and the top 3 from the machine search — is now written into <code>ledger.json</code> with today’s date (${esc(S.date)}), next to the two hand-found Seattle rules. <code>node cli.js ledger</code> scores each one only on games after that date. These are the picks for the games that already have a line:</p>
${openRows.length ? table(['Date', 'Game', 'Pick against the spread (lattices)'], openRows, {}) : '<p class="small">No upcoming game has a line yet.</p>'}
<p>None of these lattices showed an edge on ${O.windows.disc[0]}-${O.windows.valid[1]}, so the expected result is about 50%, and the picks should not be bet. The ledger is the honest way to find out if that is wrong, but it is slow: to show that a lattice winning 55% of its picks really beats the 52.4% break-even (80% power) takes about ${num(need(0.55, O.breakEven))} picks, and a typical lattice here makes about ${perSeason} picks a season. Showing 55% against a plain coin flip takes about ${num(need(0.55, 0.5))}.</p>
</section>`;
}

function seasonText(S) {
  const at = (L) => S.lags.find((x) => x.lag === L);
  const l1 = at(1);
  const eraLags = S.lags.filter((x) => x.lag >= 10 && x.r < 0 && x.perm.pFamily < 0.05).map((x) => x.lag);
  const flagged = S.lags.filter((x) => x.perm.pFamily < 0.05);
  const vsSpread = S.lags.filter((x) => x.market.pFamily < 0.05).map((x) => x.lag);
  const l23 = at(23);
  const parts = [];
  if (l1.r > 0 && l1.perm.p < 0.05) parts.push(`Good teams stay good for a year or two (one season apart: r = ${l1.r.toFixed(2)}).`);
  if (eraLags.length)
    parts.push(
      `Franchises also move in long eras: a team far above its own average tends to be below it about ${eraLags[0]}${eraLags.length > 1 ? `-${eraLags[eraLags.length - 1]}` : ''} seasons later (the gaps still flagged after correcting for all ${S.lags.length}).`,
    );
  if (vsSpread.length) parts.push(`Against what the point spreads imply, ${vsSpread.length === 1 ? 'the gap of' : 'gaps of'} ${vsSpread.join(', ')} seasons still stand out.`);
  else if (flagged.length) parts.push('All of this is what the point spreads imply too, because the spreads follow the same team quality: against the spreads nothing is left (last column).');
  parts.push(
    `At 23 seasons the correlation is ${l23.r.toFixed(3)}, ${l23.perm.p < 0.05 ? 'outside' : 'inside'} the no-memory range (p = ${fp(l23.perm.p)}), measured on only ${l23.pairs} team pairs because the data starts in ${S.window.from}.`,
  );
  return parts.join(' ');
}

function numerologyNote(L) {
  const scored = L.named.filter((x) => Number.isFinite(x.scopes.pooled[MAIN].z));
  const strongest = [...scored].sort((a, b) => Math.abs(b.scopes.pooled[MAIN].z) - Math.abs(a.scopes.pooled[MAIN].z))[0];
  const sp = strongest.scopes.pooled[MAIN];
  const below = scored.filter((x) => x.scopes.pooled[MAIN].p < 0.05).length;
  const never = L.named.filter((x) => !x.scopes.pooled[MAIN].n).map((x) => x.label.replace('Same result ', '').replace(' apart', '').replace(/ \(.*\)/, ''));
  const team = TEAM_NAMES[L.team] ?? L.team;
  return `<p>League-wide, ${below} of the ${scored.length} named lattices with enough cases reach p &lt; 0.05 on their own, against ${n1(0.05 * scored.length)} expected by luck; the largest deviation is \u201c${esc(strongest.label.toLowerCase())}\u201d at z = ${signed(sp.z)}. Some named numbers never occur as an exact gap between two games of the same team: ${never.join(', ')}. Three days would mean playing on a Thursday and again that Sunday, and 161 and 184 days reach from September into the off-season.</p>
<p class="small">For ${esc(team)}, the 28/10 and 10-day/4th-previous rules show small p-values here because they were found by searching these very games. The Seattle analysis corrects for that search, and it leaves them at p = 0.57 and 0.56.</p>`;
}

function orderNote(on, mlBy) {
  const parts = Object.entries(on).map(([k, v]) => {
    const real = mlBy[k].overall.accuracy;
    const beat = v.accuracy.values.filter((x) => x >= real).length;
    return `${mlBy[k].label.replace('Lattice: ', '')}: ${beat} of ${v.accuracy.values.length} shuffled leagues did at least as well`;
  });
  return `${parts.join('; ')}. Where the real history does better, it is by the within-season form that a shuffle destroys (a team that loses its quarterback in week 6 keeps losing), which the point spread already prices in.`;
}

function placeboNote(pl, keys) {
  const parts = [];
  for (const kind of ['spread', 'shuffle']) {
    const x = pl[kind];
    if (!x) continue;
    const flags = keys.reduce((s, k) => s + (x[k]?.teamsSig ?? 0), 0);
    const exp = keys.reduce((s, k) => s + (x[k]?.teamsSigNull ?? 0), 0);
    const low = keys.filter((k) => x[k]?.pooledMaxP !== null && x[k]?.pooledMaxP < 0.05).length;
    parts.push(`noise from the ${kind === 'spread' ? 'spread-weighted shuffle' : 'plain shuffle'} got ${flags} team flags against ${n1(exp)} expected, and ${low} of ${keys.filter((k) => x[k]?.pooledMaxP !== null).length} strongest-lattice p-values below 0.05`);
  }
  return `On pure noise, ${parts.join('; ')}.`;
}

export async function buildLabPdf(L, { outFile, htmlFile }) {
  const html = renderLabHtml(L);
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
    await page.pdf({
      path: outFile,
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="font-family:${FONT};font-size:7.5px;color:${C.muted};width:100%;padding:0 0.8in;display:flex;justify-content:space-between"><span>Lattice lab · all 32 NFL teams · ${esc(L.generated.slice(0, 10))}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      margin: { top: '0.75in', bottom: '0.8in', left: '0.8in', right: '0.8in' },
    });
  } finally {
    await browser.close();
  }
  return { pdf: outFile };
}
