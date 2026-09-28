// Out-of-sample checks that use other teams as fresh data:
//   ruleOnTeams   a rule found on one team, applied unchanged to the others
//   splitHalf     each team's best rule found in early seasons, scored on later ones
//   equalGaps     "equal-period" stretches (e.g. 6 x 2, 7 x 3) pooled across the league
// Each is compared with within-season shuffles and with the point spread.
import { allTeams, isDecided, teamSchedule } from './data.js';
import { hashSeed, mulberry32, shuffleWithinSeason } from './rng.js';
import { ordinal, ruleCases } from './rules.js';
import { intervalScan } from './scan.js';
import { empiricalP, mean } from './stats.js';

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// The market's win probability from the point spread: P(win) = sigmoid(b * spread),
// with b fitted (Newton's method) on every decided game that has a line.
export function fitMarket(games) {
  const rows = [];
  for (const g of games) {
    if (g.home_score === '' || g.spread_line === '') continue;
    const d = Number(g.home_score) - Number(g.away_score);
    if (d !== 0) rows.push([Number(g.spread_line), d > 0 ? 1 : 0]);
  }
  let b = 0.1;
  for (let it = 0; it < 30; it++) {
    let grad = 0;
    let hess = 0;
    for (const [s, y] of rows) {
      const p = sigmoid(b * s);
      grad += (y - p) * s;
      hess += p * (1 - p) * s * s;
    }
    b += grad / hess;
  }
  return { b, games: rows.length, prob: (spread) => (spread === null ? 0.5 : sigmoid(b * spread)) };
}

// Score a set of calls: hits, what the market expected, and the Vegas favorite
// on the same games (each game once, even when several rules call it).
function marketCompare(calls, market) {
  let expected = 0;
  let variance = 0;
  let favN = 0;
  let favHits = 0;
  let agree = 0;
  const seen = new Set();
  for (const { game, call } of calls) {
    const pWin = market.prob(game.spread);
    const p = call === 1 ? pWin : 1 - pWin;
    expected += p;
    variance += p * (1 - p);
    if (game.spread && !seen.has(game)) {
      seen.add(game);
      const fav = game.spread > 0 ? 1 : -1;
      favN++;
      if (fav === game.result) favHits++;
      if (fav === call) agree++;
    }
  }
  const hits = calls.filter((c) => c.call === c.game.result).length;
  return {
    n: calls.length,
    hits,
    marketExpected: expected,
    z: variance ? (hits - expected) / Math.sqrt(variance) : 0,
    favorite: { n: favN, hits: favHits, agreesWithRule: agree },
  };
}

function pooledNull({ schedules, evaluate, nPerm, seed }) {
  const out = [];
  for (let k = 0; k < nPerm; k++) {
    const shuffled = schedules.map((seq, t) =>
      shuffleWithinSeason(seq, seq.map((g) => g.result), mulberry32(hashSeed(seed, t, k))),
    );
    const s = evaluate(shuffled);
    if (s.n) out.push(s.hits / s.n);
  }
  return out;
}

// A rule, unchanged, on other teams.
export function ruleOnTeams(games, rule, { teams, from, to, nPerm = 2000, market }) {
  const schedules = teams.map((t) => teamSchedule(games, t));
  const collect = (resultsList) => {
    const calls = [];
    schedules.forEach((seq, t) => {
      for (const c of ruleCases(seq, rule, { from, to, results: resultsList[t] })) {
        if (c.call !== null && isDecided(resultsList[t][c.game])) calls.push({ game: seq[c.game], call: c.call, result: resultsList[t][c.game] });
      }
    });
    return calls;
  };
  const real = collect(schedules.map((seq) => seq.map((g) => g.result)));
  const evaluate = (resultsList) => {
    const calls = collect(resultsList);
    return { n: calls.length, hits: calls.filter((c) => c.call === c.result).length };
  };
  const nulls = pooledNull({ schedules, evaluate, nPerm, seed: `teams-${rule.type}-${rule.d1 ?? rule.gap}-${rule.d2 ?? rule.k}` });
  const rate = real.filter((c) => c.call === c.result).length / real.length;
  return {
    rule,
    ...marketCompare(real, market),
    rate,
    shuffledRate: mean(nulls),
    pShuffle: empiricalP(nulls, (x) => x >= rate - 1e-12),
  };
}

// Find rules in the search seasons, then score those exact rules (and their
// direction: repeat or reverse) on the test seasons.
//   select 'best'   each team's most impressive calendar and game-order rule
//   select 'strong' every rule that was right (or wrong) 90%+ of the time
export function splitHalf(games, { teams, searchFrom, searchTo, testFrom, testTo, minN = 8, nPerm = 2000, market, select = 'best' }) {
  const asRule = (x, type) =>
    type === 'calendar'
      ? { type, d1: x.d1, d2: x.d2, search: x }
      : { type, gap: x.gap, k: x.k, sameSeason: x.sameSeason, search: x };
  const strong = (x) => x.rate >= 0.9 || x.rate <= 0.1;
  const picks = teams.map((team) => {
    const seq = teamSchedule(games, team);
    const s = intervalScan(seq, { from: searchFrom, to: searchTo, nPerm: 0, pairs: false, minN });
    const found =
      select === 'strong'
        ? [...s.combos.filter(strong).map((x) => asRule(x, 'calendar')), ...s.order.rules.filter(strong).map((x) => asRule(x, 'order'))]
        : [s.combos[0] && asRule(s.combos[0], 'calendar'), s.order.rules[0] && asRule(s.order.rules[0], 'order')].filter(Boolean);
    return { team, seq, rules: found.map((r) => ({ ...r, direction: r.search.rate >= 0.5 ? 1 : -1 })) };
  });
  const collect = (resultsList) => {
    const calls = [];
    picks.forEach(({ seq, rules }, t) => {
      for (const rule of rules) {
        for (const c of ruleCases(seq, rule, { from: testFrom, to: testTo, results: resultsList[t] })) {
          if (c.call === null || !isDecided(resultsList[t][c.game])) continue;
          calls.push({ game: seq[c.game], call: c.call * rule.direction, result: resultsList[t][c.game], rule, team: picks[t].team });
        }
      }
    });
    return calls;
  };
  const real = collect(picks.map(({ seq }) => seq.map((g) => g.result)));
  const evaluate = (resultsList) => {
    const calls = collect(resultsList);
    return { n: calls.length, hits: calls.filter((c) => c.call === c.result).length };
  };
  const nulls = pooledNull({ schedules: picks.map((p) => p.seq), evaluate, nPerm, seed: 'split-half' });
  const rate = real.filter((c) => c.call === c.result).length / real.length;
  const searchHits = picks.flatMap((p) => p.rules).reduce((s, r) => s + (r.direction === 1 ? r.search.hits : r.search.n - r.search.hits), 0);
  const searchN = picks.flatMap((p) => p.rules).reduce((s, r) => s + r.search.n, 0);
  return {
    window: { searchFrom, searchTo, testFrom, testTo },
    rulesFound: picks.reduce((s, p) => s + p.rules.length, 0),
    searchRate: searchHits / searchN,
    searchHits,
    searchN,
    ...marketCompare(real, market),
    rate,
    shuffledRate: mean(nulls),
    pShuffle: empiricalP(nulls, (x) => x >= rate - 1e-12),
    perTeam: picks.map(({ team, rules }) => ({
      team,
      rules: rules.map((r) => {
        const calls = real.filter((c) => c.team === team && c.rule === r);
        return {
          rule: r.type === 'calendar' ? `${r.d1} & ${r.d2} days` : `${r.gap ? `${r.gap}-day gap` : 'any gap'}, ${ordinal(r.k)} previous${r.sameSeason ? ', same season' : ''}`,
          direction: r.direction === 1 ? 'repeat' : 'reverse',
          search: `${r.direction === 1 ? r.search.hits : r.search.n - r.search.hits}/${r.search.n}`,
          test: `${calls.filter((c) => c.call === c.result).length}/${calls.length}`,
        };
      }),
    })),
  };
}

// Stretches of `count` back-to-back gaps all `gap` days long, pooled over teams:
// does the last game repeat the first?
export function equalGaps(games, { teams, gap, count, from, to, nPerm = 2000, market = null }) {
  const schedules = teams.map((t) => teamSchedule(games, t));
  const ends = schedules.map((seq) =>
    seq.flatMap((g, j) => {
      if (j < count || g.season < from || g.season > to) return [];
      for (let t = 0; t < count; t++) if (seq[j - t].day - seq[j - t - 1].day !== gap) return [];
      return [j];
    }),
  );
  const evaluate = (resultsList) => {
    let n = 0;
    let hits = 0;
    ends.forEach((js, t) => {
      for (const j of js) {
        const a = resultsList[t][j - count];
        const b = resultsList[t][j];
        if (!isDecided(a) || !isDecided(b)) continue;
        n++;
        if (a === b) hits++;
      }
    });
    return { n, hits };
  };
  const real = evaluate(schedules.map((seq) => seq.map((g) => g.result)));
  const nulls = pooledNull({ schedules, evaluate, nPerm, seed: `equal-${gap}-${count}` });
  const rate = real.hits / real.n;
  const center = mean(nulls);
  // As a betting rule: "the last game repeats the first", against the spread.
  const calls = ends.flatMap((js, t) =>
    js
      .filter((j) => isDecided(schedules[t][j - count].result) && isDecided(schedules[t][j].result))
      .map((j) => ({ game: schedules[t][j], call: schedules[t][j - count].result })),
  );
  return {
    gap,
    count,
    stretches: ends.reduce((s, js) => s + js.length, 0),
    ...real,
    rate,
    shuffledRate: center,
    p: empiricalP(nulls, (x) => Math.abs(x - center) >= Math.abs(rate - center) - 1e-12),
    market: market ? marketCompare(calls, market) : null,
  };
}

export function crossTeamAll(games, { team = 'SEA', from = 1999, to = 2025, nPerm = 2000, rules }) {
  const market = fitMarket(games);
  const everyone = allTeams(games);
  const others = everyone.filter((t) => t !== team);
  return {
    market: { b: market.b, games: market.games },
    rulesOnOthers: Object.entries(rules).map(([id, rule]) => ({
      id,
      ...ruleOnTeams(games, rule, { teams: others, from, to, nPerm, market }),
    })),
    sameSeasonOnOthers: ruleOnTeams(games, { type: 'order', gap: 10, k: 4, sameSeason: true }, { teams: others, from, to, nPerm, market }),
    splitHalf: splitHalf(games, { teams: everyone, searchFrom: from, searchTo: 2012, testFrom: 2013, testTo: to, nPerm, market }),
    splitHalfStrong: splitHalf(games, {
      teams: everyone,
      searchFrom: from,
      searchTo: 2012,
      testFrom: 2013,
      testTo: to,
      nPerm,
      market,
      select: 'strong',
    }),
    equalGaps: [
      [6, 3],
      [6, 2],
      [7, 3],
    ].map(([gap, count]) => equalGaps(games, { teams: everyone, gap, count, from, to, nPerm, market })),
  };
}
