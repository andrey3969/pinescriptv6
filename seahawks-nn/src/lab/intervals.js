// Interval rules in the style of the handwritten blocks: "a game exactly d days
// after another reverses (or repeats) its result". Tested three ways, each
// against histories where every season's results are dealt out at random
// (records kept):
//   fixed       one direction for an interval, over all seasons
//   by gaps     the direction depends on the gaps in between (7+7+7, 4+10+7,
//               14+7, ...): learned on 1999-2012, scored on 2013-2025
//   carry-over  the direction a team showed in one season, applied to the
//               next season (the page's own workflow: 2024 -> 2025)
//   own era     each team's own direction over 1999-2012, applied to that
//               team in 2013-2025 ("every team has its own lattice")
import { allTeams, isDecided, teamSchedule } from '../data.js';
import { hashSeed, mulberry32, shuffleWithinSeason } from '../rng.js';
import { empiricalP, mean } from '../stats.js';

export const INTERVALS = [4, 6, 7, 8, 10, 11, 13, 14, 21, 28];

function pairsAt(seq, lag, from, to) {
  const byDay = new Map(seq.map((g, i) => [g.day, i]));
  const out = [];
  seq.forEach((g, j) => {
    if (g.season < from || g.season > to) return;
    const i = byDay.get(g.day - lag);
    if (i === undefined) return;
    const gaps = [];
    for (let k = i + 1; k <= j; k++) gaps.push(seq[k].day - seq[k - 1].day);
    out.push({ i, j, season: g.season, comp: gaps.join('+') });
  });
  return out;
}

// Chance that two games of a season share a result when the season's
// results are dealt at random, given both are decided: records alone.
function sameChance(seq, results) {
  const t = new Map();
  seq.forEach((g, i) => {
    const r = results[i];
    if (!isDecided(r)) return;
    const e = t.get(g.season) ?? { w: 0, l: 0 };
    if (r === 1) e.w++;
    else e.l++;
    t.set(g.season, e);
  });
  return new Map([...t].map(([s, { w, l }]) => [s, w + l > 1 ? (w * (w - 1) + l * (l - 1)) / ((w + l) * (w + l - 1)) : 0.5]));
}

// Per team, lag and season: pairs, reversals, expected reversals.
function tally(team, results) {
  const out = new Map();
  for (const lag of INTERVALS) {
    const bySeason = new Map();
    for (const p of team.pairs.get(lag)) {
      const a = results[p.i];
      const b = results[p.j];
      if (!isDecided(a) || !isDecided(b)) continue;
      const e = bySeason.get(p.season) ?? { n: 0, rev: 0, exp: 0, comps: new Map() };
      const rev = a !== b ? 1 : 0;
      const q = 1 - team.same.get(p.season);
      e.n++;
      e.rev += rev;
      e.exp += q;
      const c = e.comps.get(p.comp) ?? { n: 0, rev: 0, exp: 0 };
      c.n++;
      c.rev += rev;
      c.exp += q;
      e.comps.set(p.comp, c);
      bySeason.set(p.season, e);
    }
    out.set(lag, bySeason);
  }
  return out;
}

// All statistics for one history (real or dealt at random).
function statistics(teams, resultsList, { split = 2012, focus = 'SEA' }) {
  const perTeam = teams.map((team, t) => {
    team.same = sameChance(team.seq, resultsList[t]);
    return tally(team, resultsList[t]);
  });
  const out = {};
  for (const lag of INTERVALS) {
    const fixed = { league: { n: 0, rev: 0, exp: 0 }, team: { n: 0, rev: 0, exp: 0 } };
    const carry = { league: { n: 0, hits: 0, exp: 0 }, team: { n: 0, hits: 0, exp: 0 } };
    const era = { league: { n: 0, hits: 0, exp: 0 }, team: { n: 0, hits: 0, exp: 0 } };
    const learn = new Map();
    const learnTeam = new Map();
    perTeam.forEach((bySeason, t) => {
      const isFocus = teams[t].code === focus;
      // own era: the team's lean on the early seasons, scored on the later ones
      const early = { rev: 0, exp: 0 };
      for (const [s, e] of bySeason.get(lag)) {
        if (s > split) continue;
        early.rev += e.rev;
        early.exp += e.exp;
      }
      const eraLean = Math.sign(early.rev - early.exp);
      if (eraLean) {
        for (const [s, e] of bySeason.get(lag)) {
          if (s <= split) continue;
          for (const k of ['league', ...(isFocus ? ['team'] : [])]) {
            era[k].n += e.n;
            era[k].hits += eraLean > 0 ? e.rev : e.n - e.rev;
            era[k].exp += eraLean > 0 ? e.exp : e.n - e.exp;
          }
        }
      }
      for (const [s, e] of bySeason.get(lag)) {
        for (const k of ['league', ...(isFocus ? ['team'] : [])]) {
          fixed[k].n += e.n;
          fixed[k].rev += e.rev;
          fixed[k].exp += e.exp;
        }
        // by gaps: learn directions on the early seasons
        if (s <= split) {
          for (const [c, x] of e.comps) {
            for (const [m, ok] of [[learn, true], [learnTeam, isFocus]]) {
              if (!ok) continue;
              const y = m.get(c) ?? { n: 0, rev: 0, exp: 0 };
              y.n += x.n;
              y.rev += x.rev;
              y.exp += x.exp;
              m.set(c, y);
            }
          }
        }
        // carry-over: this season's lean, scored on the next season
        const next = bySeason.get(lag).get(s + 1);
        const lean = Math.sign(e.rev - e.exp);
        if (!next || !lean) continue;
        const hits = lean > 0 ? next.rev : next.n - next.rev;
        const exp = lean > 0 ? next.exp : next.n - next.exp;
        for (const k of ['league', ...(isFocus ? ['team'] : [])]) {
          carry[k].n += next.n;
          carry[k].hits += hits;
          carry[k].exp += exp;
        }
      }
    });
    const byGaps = {};
    for (const [k, m, teamOnly] of [['league', learn, false], ['team', learnTeam, true]]) {
      const x = { n: 0, hits: 0, exp: 0 };
      perTeam.forEach((bySeason, t) => {
        if (teamOnly && teams[t].code !== focus) return;
        for (const [s, e] of bySeason.get(lag)) {
          if (s <= split) continue;
          for (const [c, y] of e.comps) {
            const l = m.get(c);
            const lean = l ? Math.sign(l.rev - l.exp) : 0;
            if (!lean) continue;
            x.n += y.n;
            x.hits += lean > 0 ? y.rev : y.n - y.rev;
            x.exp += lean > 0 ? y.exp : y.n - y.exp;
          }
        }
      });
      byGaps[k] = x;
    }
    out[lag] = { fixed, byGaps, carry, era };
  }
  return out;
}

export function intervalRules(games, { team = 'SEA', from = 1999, to = 2025, split = 2012, reps = 1000, onProgress } = {}) {
  const teams = allTeams(games).map((code) => {
    const seq = teamSchedule(games, code);
    return { code, seq, pairs: new Map(INTERVALS.map((lag) => [lag, pairsAt(seq, lag, from, to)])) };
  });
  const base = teams.map((t) => t.seq.map((g) => g.result));
  const real = statistics(teams, base, { split, focus: team });
  const nulls = [];
  for (let k = 0; k < reps; k++) {
    const res = teams.map((t, i) => shuffleWithinSeason(t.seq, base[i], mulberry32(hashSeed('intervals', k, i))));
    nulls.push(statistics(teams, res, { split, focus: team }));
    onProgress?.(k + 1, reps);
  }
  // excess = observed minus expected; p = how often a random deal is at least as far from 0 (two-sided)
  const summarize = (get) => {
    const r = get(real);
    const excess = (x) => (x.rev ?? x.hits) - x.exp;
    const nullEx = nulls.map((n) => excess(get(n)));
    const centre = mean(nullEx);
    const e = excess(r);
    return {
      n: r.n,
      observed: r.rev ?? r.hits,
      expected: r.exp + centre,
      rate: (r.rev ?? r.hits) / r.n,
      expectedRate: (r.exp + centre) / r.n,
      p: r.n ? empiricalP(nullEx, (x) => Math.abs(x - centre) >= Math.abs(e - centre) - 1e-9) : NaN,
    };
  };
  const rows = INTERVALS.map((lag) => ({
    lag,
    team: {
      reversal: summarize((st) => st[lag].fixed.team),
      byGaps: summarize((st) => st[lag].byGaps.team),
      carry: summarize((st) => st[lag].carry.team),
      era: summarize((st) => st[lag].era.team),
    },
    league: {
      reversal: summarize((st) => st[lag].fixed.league),
      byGaps: summarize((st) => st[lag].byGaps.league),
      carry: summarize((st) => st[lag].carry.league),
      era: summarize((st) => st[lag].era.league),
    },
  }));
  return { team, from, to, split, reps, intervals: INTERVALS, rows };
}
