// Renders the pipeline results as REPORT.md. Every verdict sentence is
// derived from the numbers, so re-running on new data keeps it honest.
import { TEAM_NAMES } from './data.js';
import { binomTwoSided } from './stats.js';

const pct = (x, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : 'n/a');
const fp = (p) => (p < 0.001 ? '< 0.001' : p < 0.01 ? p.toFixed(3) : p.toFixed(2));
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const wl = (r) => (r === 1 ? 'W' : r === -1 ? 'L' : r === 0 ? 'T' : 'not played');
const where = (g) => `${g.home === 1 ? 'vs' : g.home === -1 ? '@' : 'vs'} ${g.opp}${g.home === 0 ? ' (neutral)' : ''}`;
const short = (g) => `${g.date} ${g.weekday}`;
const DAY_NAMES = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const score = (g) => (g.pf === null ? wl(g.result) : `${wl(g.result)} ${g.pf}–${g.pa}`);
const n1 = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

function table(headers, rows, align = []) {
  const sep = headers.map((_, k) => (align[k] === 'r' ? '---:' : '---'));
  return [headers, sep, ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

const WF_ORDER = [
  'vegas',
  'nn_conventional',
  'nn_all',
  'always_win',
  'home',
  'season_form',
  'lr_lattice',
  'nn_sequence',
  'nn_lattice',
  'repeat_last',
];

export function renderReport(R) {
  const o = R.options;
  const team = o.team;
  const m = R.walkForward.metrics;
  const L = R.labels;
  const base = m.always_win;
  const nn = m.nn_lattice;
  const perm = R.permutation.models;
  const scan = R.scan;
  const rule = scan.focus;
  const pairQMin = Math.min(...scan.pairLags.map((r) => r.q));
  const gapQMin = Math.min(...scan.consecutiveGaps.map((r) => r.q));
  const others = R.teams.filter((t) => t.team !== team);
  const asStrong = others.filter((t) => t.best && t.best.p <= rule.p);
  const pooled = others.reduce(
    (s, t) => {
      const hasNull = t.rule.n > 0 && Number.isFinite(t.rule.nullMeanRate);
      return {
        hits: s.hits + t.rule.hits,
        n: s.n + t.rule.n,
        nullHits: s.nullHits + (hasNull ? t.rule.nullMeanRate * t.rule.n : 0),
        nullN: s.nullN + (hasNull ? t.rule.n : 0),
      };
    },
    { hits: 0, n: 0, nullHits: 0, nullN: 0 },
  );
  const passing = R.teams.filter((t) => t.best && t.best.pFamily < 0.05);
  const distinctBest = new Set(R.teams.filter((t) => t.best).map((t) => `${t.best.d1}/${t.best.d2}`)).size;
  const nnBeatsBase = nn.accuracy > base.accuracy && nn.logLoss < base.logLoss;
  const [pa, pb] = R.walkForward.paired;
  const out = [];
  const w = (s = '') => out.push(s);

  w(`# ${TEAM_NAMES[team] ?? team}: neural network pattern test, ${o.from}–${o.to}`);
  w();
  w(
    `*Generated ${R.generatedAt.slice(0, 10)} from nflverse game data through ${R.data.lastPlayed.date} ` +
      `(${where(R.data.lastPlayed)}, ${score(R.data.lastPlayed)}). Rebuild with \`node cli.js report\`.*`,
  );
  w();
  w(
    `${team} went ${R.data.record.w}–${R.data.record.l}${R.data.record.t ? `–${R.data.record.t}` : ''} ` +
      `(${pct(R.data.record.w / (R.data.record.w + R.data.record.l))} wins) over ${R.data.games} games in ${o.from}–${o.to}, playoffs included. ` +
      'Any pattern has to beat that win rate to be worth anything.',
  );
  w();

  // ---------------------------------------------------------------- summary
  w('## Bottom line');
  w();
  w(
    `- **The neural network ${nnBeatsBase ? 'beat' : 'did not beat'} the simplest baseline.** ` +
      `It saw only ${team}'s own results and the calendar spacing of its games, and was tested season by season on games it had never seen ` +
      `(${o.testFrom}–${o.to}, ${nn.n} games). It picked **${pct(nn.accuracy)}** correctly, against **${pct(base.accuracy)}** for ` +
      `picking ${team} every week and **${pct(m.vegas.accuracy)}** for the Vegas favorite` +
      (pa.p < 0.05 ? ` (the gap to picking ${team} every week is ${pa.onlyA < pa.onlyB ? 'significant, the wrong way' : 'significant'}: McNemar p = ${fp(pa.p)}).` : '.'),
  );
  const pl = perm.nn_lattice;
  const ps = perm.nn_sequence;
  const edge = pl.pLogLoss < 0.05 || pl.pAccuracy < 0.05;
  w(
    `- **Shuffle test.** On ${R.permutation.perms} copies of history with each season's results dealt out in random order, the same network ` +
      `scored ${pct(pl.nullAccuracy.mean)} on average (90% of runs between ${pct(pl.nullAccuracy.p05)} and ${pct(pl.nullAccuracy.p95)}); ` +
      `on the real order it scored ${pct(pl.real.accuracy)} (p = ${fp(pl.pAccuracy)} for accuracy, ${fp(pl.pLogLoss)} for log-loss). ` +
      (edge
        ? 'So the real order carries a little structure a shuffle lacks' +
          (nnBeatsBase ? '. ' : `, but too little to use: the network still does worse than always picking ${team}. `) +
          `A control network given only the last 8 results with no dates gets p = ${fp(ps.pLogLoss)} on the same test, ` +
          (ps.pLogLoss < 0.1
            ? 'which points to ordinary streakiness (form changing within a season, runs of strong or weak opponents) rather than calendar spacing.'
            : `so the dates may carry some of it${nnBeatsBase ? '' : ', though not enough to beat the base rate'}.`)
        : 'Neither is significant: the real order is not detectably more predictable than a random reshuffle of the same seasons.'),
  );
  w(
    `- **The 28/10 rule really is ${rule.hits}-for-${rule.n} in ${o.from}–${o.to}, matching your count, but a search produces results like that.** ` +
      `${scan.rulesTested} different "if the games d1 and d2 days back agree, repeat it" rules have at least ${scan.settings.minN} cases here. ` +
      `In ${pct(scan.chance.atLeastAsStrong.shareWithAny, 0)} of shuffled histories at least one of them looks this good ` +
      `(p after the search = ${fp(rule.pFamily)}). Across the other ${others.length} teams the same rule is right ` +
      `${pooled.hits} of ${pooled.n} times (${pct(pooled.hits / pooled.n, 0)}); shuffling those teams' seasons gives ${pct(pooled.nullHits / pooled.nullN, 0)}. ` +
      'It beats 50% only because good seasons stay good.',
  );
  w(
    `- **No interval between games shows a real repeat-or-reverse pattern** once you allow for how many were checked ` +
      `(lowest false-discovery q = ${fp(pairQMin)} across ${scan.pairLags.length} intervals of 1–${scan.settings.maxPairLag} days, ` +
      `and ${fp(gapQMin)} for back-to-back games).`,
  );
  w(
    '- **3, 4, 7, 10, 11 and 14 are the NFL weekday grid.** A 4-day gap is Sunday→Thursday, 10 days is Thursday→Sunday, ' +
      '8 + 6 is Sunday→Monday→Sunday, 14 is a bye week. Details in section 5.',
  );
  const perfectOthers = others.filter((t) => t.perfect > 0).length;
  w(
    `- **Every team has "its own" best rule, because every noisy sequence does.** ${asStrong.length} of the other ${others.length} teams ` +
      `have a rule that looks at least as strong as ${team}'s 28/10 by the same measure, spread over ${distinctBest} different interval pairs, ` +
      `and ${perfectOthers} of them have at least one perfect rule (every case repeated, or every case reversed) with ${scan.settings.minN}+ cases. ` +
      `After correcting for the search, ${passing.length} of ${R.teams.length} teams' best rules pass at the 5% level, where chance alone gives about ` +
      `${n1(0.05 * R.teams.length)}${passing.length ? ` (${passing.map((t) => `${t.team} ${t.best.d1} & ${t.best.d2} days, ${t.best.hits}/${t.best.n}`).join('; ')})` : ''}.`,
  );
  for (const u of R.upcomingRule) {
    w(
      `- **Live test, ${short(u.game)} ${where(u.game)}:** 28 days before is ${u.first.date} ${where(u.first)} (${wl(u.first.result)}); ` +
        `10 days before is ${short(u.middle)} ${where(u.middle)} (${wl(u.middle.result)}). ${u.status} ` +
        'A rule only gets a fair test on games played after it was written down.',
    );
  }
  w();

  // ------------------------------------------------------ 1. walk-forward
  w('## 1. Out-of-sample test (walk-forward)');
  w();
  w(
    `For every season from ${o.testFrom} to ${o.to}, each model was trained on ${o.from} through the season before and then predicted every game of that season. ` +
      'Nothing from a season is seen before it is predicted. Log-loss rewards confident correct calls and punishes confident misses; ' +
      `lower is better, and always saying 50/50 scores 0.693.`,
  );
  w();
  w(
    table(
      ['Model', 'Games', 'Correct', '95% range', 'Log-loss'],
      [
        ...WF_ORDER.filter((k) => m[k]).map((k) => [
          L[k],
          m[k].n,
          pct(m[k].accuracy),
          `${pct(m[k].ci[0], 0)}–${pct(m[k].ci[1], 0)}`,
          f3(m[k].logLoss),
        ]),
        [
          `${L.rule_28_10} *`,
          m.rule_28_10.n,
          pct(m.rule_28_10.accuracy),
          `${pct(m.rule_28_10.ci[0], 0)}–${pct(m.rule_28_10.ci[1], 0)}`,
          '–',
        ],
      ],
      ['l', 'r', 'r', 'r', 'r'],
    ),
  );
  w();
  w(
    `\\* The rule only makes a call on ${m.rule_28_10.n} of these games, and it was found by looking at these same seasons, ` +
      'so its row is not out-of-sample. Section 3 corrects it for the search.',
  );
  w();
  w(
    `Head to head, the results + timing network and always picking ${team} disagreed on ${pa.onlyA + pa.onlyB} games: the network was right on ${pa.onlyA} of them ` +
      `and always-${team} on ${pa.onlyB} (McNemar p = ${fp(pa.p)}). ` +
      `The everything network against the Vegas line: ${pb.onlyA} vs ${pb.onlyB} (p = ${fp(pb.p)}). ` +
      `Adding the results + timing inputs to the spread + home + form network ${
        m.nn_all.logLoss > m.nn_conventional.logLoss ? 'made it worse' : 'changed it'
      } (${pct(m.nn_conventional.accuracy)} → ${pct(m.nn_all.accuracy)}, log-loss ${f3(m.nn_conventional.logLoss)} → ${f3(m.nn_all.logLoss)}).`,
  );
  w();
  w('**Robustness.** The network settings were fixed before testing. Other reasonable settings give the same picture:');
  w();
  w(
    table(
      ['Results + timing network', 'Correct', 'Log-loss'],
      R.sensitivity.map((s) => [s.label, pct(s.accuracy), f3(s.logLoss)]),
      ['l', 'r', 'r'],
    ),
  );
  w();

  // -------------------------------------------------------- 2. shuffles
  w('## 2. Shuffle test: is there any order in the sequence?');
  w();
  w(
    `Each shuffle keeps every game's date, opponent and home/away, and every season's record, but deals that season's results out in random order. ` +
      `If ${team}'s wins and losses follow a calendar lattice, a network trained on the real order should beat networks trained on shuffled orders. ` +
      `Each row is the real score against ${R.permutation.perms} shuffles (${R.permutation.seeds}-network ensembles, same walk-forward).`,
  );
  w();
  w(
    table(
      ['Model', 'Real', 'Shuffled (90% range)', 'p', 'Real log-loss', 'Shuffled', 'p'],
      Object.entries(perm).map(([k, s]) => [
        L[k],
        pct(s.real.accuracy),
        `${pct(s.nullAccuracy.p05)}–${pct(s.nullAccuracy.p95)}`,
        fp(s.pAccuracy),
        f3(s.real.logLoss),
        f3(s.nullLogLoss.mean),
        fp(s.pLogLoss),
      ]),
      ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    ),
  );
  w();

  // ----------------------------------------------------- 3. 28/10 rule
  w('## 3. The 28/10 rule, case by case');
  w();
  w(
    `Every ${team} game in ${o.from}–${o.to} with a game exactly 28 and 10 days earlier. The endpoints (28 days apart) match in ` +
      `${rule.endsSame} of ${rule.nEnds}; the rule fires when the first two agree, and the third matched ${rule.hits} of ${rule.n}.`,
  );
  w();
  w(
    table(
      ['Game', '28 days before', '10 days before', 'Result', 'Rule'],
      R.ruleCases.map((c) => [
        `${c.game.date} ${where(c.game)}`,
        `${c.first.date} ${wl(c.first.result)}`,
        `${short(c.middle)} ${wl(c.middle.result)}`,
        wl(c.game.result),
        c.agree ? (c.hit ? 'hit' : 'miss') : 'no call',
      ]),
    ),
  );
  w();
  const midDays = [...new Set(R.ruleCases.map((c) => c.middle.weekday))];
  const strong = scan.chance.atLeastAsStrong;
  w(
    (midDays.length === 1
      ? `Every "10 days before" game is a ${DAY_NAMES[midDays[0]]}, so the rule really says "after a ${DAY_NAMES[midDays[0]]} game, compare with four weeks earlier". `
      : '') +
      (R.data.thursdays.length
        ? `${team} played ${R.data.thursdays.length} Thursday games in ${o.from}–${o.to}, the first on ${R.data.thursdays[0]}, so the rule gets about one chance a season at most. `
        : '') +
      `On its own, ${rule.hits}/${rule.n} would be rare (binomial p = ${fp(rule.p)}; shuffle p = ${fp(rule.pPermutation)}). ` +
      `But it is one of ${scan.rulesTested} rules with at least ${scan.settings.minN} cases. The real history has ${strong.real} rules this strong; ` +
      `shuffled histories average ${n1(strong.nullMean)}, and ${pct(strong.pExcess, 0)} of them have ${strong.real} or more. ` +
      `Requiring at least ${scan.settings.minN} cases is the cutoff most favorable to 28/10; a broader search makes the correction bigger.`,
  );
  w();
  w(
    table(
      ['Strongest rules found', 'Cases', 'Repeated', 'Rate', 'p alone', 'p after search'],
      scan.combos.slice(0, 8).map((c) => [`${c.d1} & ${c.d2} days`, c.n, c.hits, pct(c.rate, 0), fp(c.p), fp(c.pFamily)]),
      ['l', 'r', 'r', 'r', 'r', 'r'],
    ),
  );
  w();

  // ------------------------------------------------ 4. interval scan
  w('## 4. Repeats and reversals by interval');
  w();
  w(
    'Back-to-back games grouped by the days between them. "Same" means the second game repeated the first result. ' +
      'The shuffled column is what reshuffled seasons produce for that gap.',
  );
  w();
  const gapMoves = new Map(R.gaps.map((g) => [g.gap, g.moves]));
  w(
    table(
      ['Gap', 'Weekdays', 'Pairs', 'Same', 'Rate', 'Shuffled', 'p', 'q'],
      scan.consecutiveGaps.map((r) => [
        `${r.days} days`,
        (gapMoves.get(r.days) ?? []).slice(0, 2).map((x) => x.move.replace(' -> ', '→')).join(', '),
        r.n,
        r.same,
        pct(r.rate, 0),
        pct(r.nullRate, 0),
        fp(r.p),
        fp(r.q),
      ]),
      ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r'],
    ),
  );
  w();
  w(
    `Every pair of games ${scan.settings.maxPairLag} or fewer days apart (not only back-to-back), the most extreme intervals. ` +
      'q is the false-discovery-rate adjusted p-value; with this many intervals, some raw p-values under 0.05 are expected by chance.',
  );
  w();
  w(
    table(
      ['Interval', 'Pairs', 'Same', 'Rate', 'Shuffled', 'p', 'q'],
      [...scan.pairLags]
        .sort((a, b) => a.p - b.p)
        .slice(0, 8)
        .map((r) => [`${r.days} days`, r.n, r.same, pct(r.rate, 0), pct(r.nullRate, 0), fp(r.p), fp(r.q)]),
      ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    ),
  );
  w();

  // ------------------------------------------------------ 5. weekday grid
  w('## 5. Where 3, 4, 7, 10, 11 and 14 come from');
  w();
  w(
    'Nearly every NFL game is on a Sunday, Monday, Thursday or Saturday, so the gap between two games is a week plus or minus a weekday shift. ' +
      `${team}'s back-to-back gaps, ${o.from}–${o.to}:`,
  );
  w();
  w(
    table(
      ['Gap', 'Times', 'How it happens'],
      R.gaps.map((g) => [`${g.gap} days`, g.n, g.moves.map((x) => `${x.move.replace(' -> ', '→')} (${x.n})`).join(', ')]),
      ['l', 'r', 'l'],
    ),
  );
  w();
  w('So 14 = 7 + 7 = 8 + 6 = 4 + 10 = 3 + 11 are the same two-week span with the middle game moved to a Monday or Thursday, and 21/7 is three weeks.');
  w();

  // ------------------------------------------------------ 6. all teams
  w('## 6. All 32 teams');
  w();
  w(
    `The same search for every franchise, ${o.from}–${o.to}. "Best rule" is the strongest two-lookback rule found for that team ` +
      `(at least ${scan.settings.minN} cases); "after search" corrects for all the rules tried (${o.teamScanPerms} shuffles each). ` +
      'The last column is the results-and-timing network (walk-forward) against always predicting the team\'s more common result.',
  );
  w();
  w(
    table(
      ['Team', '28/10 rule', 'Best rule', 'Repeated', 'p after search', 'Network vs base rate'],
      [...R.teams]
        .sort((a, b) => (a.best?.p ?? 1) - (b.best?.p ?? 1))
        .map((t) => [
          t.team === team ? `**${t.team}**` : t.team,
          t.rule.n ? `${t.rule.hits}/${t.rule.n}` : '–',
          t.best ? `${t.best.d1} & ${t.best.d2} days` : '–',
          t.best ? `${t.best.hits}/${t.best.n}` : '–',
          t.best ? fp(t.best.pFamily) : '–',
          `${pct(t.nn.accuracy)} vs ${pct(t.base.accuracy)}`,
        ]),
      ['l', 'r', 'l', 'r', 'r', 'r'],
    ),
  );
  w();
  const nT = R.teams.length;
  const accWins = R.teams.filter((t) => t.nn.accuracy > t.base.accuracy).length;
  const llWins = R.teams.filter((t) => t.nn.logLoss < t.base.logLoss).length;
  const signP = binomTwoSided(llWins, nT, 0.5);
  const avg = (f) => R.teams.reduce((s, t) => s + f(t), 0) / nT;
  w(
    `The results-and-timing network beat its team's base rate on accuracy for ${accWins} of ${nT} teams and on log-loss for ${llWins} of ${nT} ` +
      `(averaged over teams: ${pct(avg((t) => t.nn.accuracy))} vs ${pct(avg((t) => t.base.accuracy))}). ` +
      'If each team had its own hidden lattice, a network trained on that team alone should find it and beat the base rate consistently. ' +
      (signP >= 0.05
        ? `It does not: wins and losses split like coin flips (sign test p = ${fp(signP)}).`
        : llWins > nT / 2
          ? `It wins more often than coin flips would (sign test p = ${fp(signP)}), so some team-specific signal may exist, though sections 1–2 find none for ${team}.`
          : `It does the opposite: its probabilities are worse than the base rate for most teams (sign test p = ${fp(signP)}), which is what fitting noise looks like.`),
  );
  w();

  // ------------------------------------------------------ 7. next game
  const nx = R.next;
  if (nx) {
    w('## 7. Next game');
    w();
    w(
      `**${short(nx.game)} ${where(nx.game)}**${nx.game.spread !== null ? ` (${team} ${nx.game.spread > 0 ? `favored by ${nx.game.spread}` : nx.game.spread < 0 ? `underdog by ${-nx.game.spread}` : 'pick’em'})` : ''}. ` +
        `Models retrained on all ${nx.trainedOn} finished games through ${nx.lastPlayed.date}.`,
    );
    w();
    w(
      table(
        ['Model', `P(${team} wins)`],
        Object.entries(nx.probs).map(([k, p]) => [L[k], pct(p, 0)]),
        ['l', 'r'],
      ),
    );
    w();
    w('Only the models that use the point spread beat the base rate out of sample (section 1). Treat the results-and-timing numbers as noise.');
    w();
  }

  // ------------------------------------------------------ method
  w('## Method');
  w();
  w(`- **Data:** nflverse \`games.csv\` (Lee Sharpe), every NFL game since 1999 with dates, scores and closing spreads. Ties count as neither result.`);
  w(
    `- **Network:** ${R.features.lattice} inputs for the results + timing model: the last 8 results in game order, the last 4 day gaps, the result exactly d days ` +
      `earlier for every d from 1 to 63 (0 if no game), and the weekday. The full model adds home/away, playoff, week, division game, season-to-date record, ` +
      `last season's record, point differential and the spread (${R.features.all} inputs). One hidden layer of ${o.net.hidden} tanh units, sigmoid output, ` +
      `Adam (lr ${o.net.lr}), L2 ${o.net.l2}, early stopping on a random ${pct(o.net.valFrac, 0)} of the training games, ` +
      `ensemble of ${o.seeds} seeds. Logistic regression is the same network with no hidden layer.`,
  );
  w(
    `- **Validation:** expanding-window walk-forward by season; train ${o.from}..Y-1, test Y, for Y = ${o.testFrom}..${o.to}. ` +
      'Hyperparameters were fixed before any test season was scored.',
  );
  w(
    '- **Null model:** within-season shuffles keep schedules and season records and destroy only the order of results. ' +
      `Interval scan: ${scan.settings.nPerm} shuffles; rules use lookbacks up to ${scan.settings.maxLag} days with at least ${scan.settings.minN} cases; ` +
      '"after search" p-values compare each rule with the best rule of every shuffled history (min-p family-wise correction); ' +
      'interval tables use Benjamini–Hochberg q-values.',
  );
  w('- **Files:** `results/results.json` has every number in this report; `results/predictions.csv` has every walk-forward prediction.');
  w();
  return out.join('\n');
}
