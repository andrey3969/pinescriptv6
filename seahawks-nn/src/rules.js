// Hand-found prediction rules, in one place so the walk-forward table, the
// scans, the next-game notes and the ledger all read them the same way.
//
//   calendar  the games exactly d1 and d2 days before agree -> repeat that result
//   order     the game is exactly `gap` days after the previous one, and the
//             previous game and the k-th previous game agree -> repeat
//             (sameSeason: all of those games must be in one season)
import { isDecided } from './data.js';
import { scheduleIndex } from './features.js';

export const RULES = {
  rule_28_10: { type: 'calendar', d1: 28, d2: 10, label: '28/10-day rule' },
  rule_gap10_k4: { type: 'order', gap: 10, k: 4, sameSeason: false, label: '10-day gap, 4th-previous rule' },
};

// [older, newer] indices of the two games the rule compares for game j,
// or null when the rule cannot apply to game j.
export function ruleInputs(seq, j, rule) {
  if (rule.type === 'calendar') {
    const { byDay } = scheduleIndex(seq);
    const a = byDay.get(seq[j].day - rule.d1);
    const b = byDay.get(seq[j].day - rule.d2);
    return a === undefined || b === undefined ? null : [a, b];
  }
  const a = j - rule.k;
  if (a < 0 || seq[j].day - seq[j - 1].day !== rule.gap) return null;
  if (rule.sameSeason && seq[a].season !== seq[j].season) return null;
  return [a, j - 1];
}

// The rule's call (1 / -1), or null when the two inputs are not the same result.
export function ruleCall(results, inputs) {
  if (!inputs) return null;
  const [a, b] = inputs;
  return isDecided(results[a]) && results[a] === results[b] ? results[a] : null;
}

// Every game in seasons [from, to] where the rule's two inputs exist.
export function ruleCases(seq, rule, { from, to, results = seq.map((g) => g.result) }) {
  const out = [];
  seq.forEach((g, j) => {
    if (g.season < from || g.season > to) return;
    const inputs = ruleInputs(seq, j, rule);
    if (!inputs) return;
    const call = ruleCall(results, inputs);
    out.push({
      game: j,
      older: inputs[0],
      newer: inputs[1],
      call,
      hit: call !== null && isDecided(results[j]) ? results[j] === call : null,
    });
  });
  return out;
}

export function describeRule(rule) {
  if (rule.type === 'calendar') return `results ${rule.d1} and ${rule.d2} days before agree`;
  return `${rule.gap} days after the last game, last and ${ordinal(rule.k)}-previous agree${rule.sameSeason ? ' (same season)' : ''}`;
}

export const ordinal = (k) => `${k}${k % 10 === 1 && k !== 11 ? 'st' : k % 10 === 2 && k !== 12 ? 'nd' : k % 10 === 3 && k !== 13 ? 'rd' : 'th'}`;
