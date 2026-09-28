import { isDecided } from './data.js';
import { fitModel, makeContext } from './models.js';
import { RULES, ruleInputs } from './rules.js';

export const PREDICT_MODELS = ['always_win', 'vegas', 'nn_conventional', 'nn_all', 'nn_lattice', 'nn_sequence'];

const lastPlayedIndex = (seq) => seq.findLastIndex((g) => g.result !== null);

// Train on every finished game, then score the next scheduled one. Only the
// next game can be scored honestly: later games' lag inputs are unknown.
export function predictNext(seq, { models = PREDICT_MODELS, seeds, net } = {}) {
  const last = lastPlayedIndex(seq);
  const next = last + 1;
  if (next >= seq.length) return null;
  const ctx = makeContext(seq);
  const train = seq.flatMap((g, i) => (i <= last && isDecided(g.result) ? [i] : []));
  const probs = {};
  for (const key of models) {
    if (key === 'vegas' && seq[next].spread === null) continue;
    probs[key] = fitModel(key, ctx, train, { seeds, net })([next])[0];
  }
  return { index: next, game: seq[next], lastPlayed: seq[last], trainedOn: train.length, probs };
}

const theGame = (g) => `the ${g.weekday} ${g.date} game ${g.home === 1 ? 'vs' : '@'} ${g.opp}`;
const word = (r) => (r === 1 ? 'win' : 'loss');

// What the rule says about a game, given the two games it compares.
export function ruleStatus(older, newer, game = null, rule = null) {
  if (older === newer) {
    // one input game (lag rules): repeat it, or call the opposite
    const r = older.result;
    const flip = rule?.reverse ? -1 : 1;
    if (r === 0) return 'No call (a tie).';
    if (r === null) return `Calls ${rule?.reverse ? 'the opposite of' : 'the same result as'} ${theGame(older)}.`;
    const call = flip * r;
    if (!game || game.result === null) return `The rule calls a ${word(call)} (${theGame(older)} was a ${word(r)}).`;
    return game.result === call ? `Called a ${word(call)}: hit.` : `Called a ${word(call)}: miss.`;
  }
  const [a, b] = [older.result, newer.result];
  if (a === 0 || b === 0) return 'No call (a tie).';
  if (a !== null && b !== null) {
    if (a !== b) return 'No call: the two results disagree.';
    if (!game || game.result === null) return `The rule calls a ${word(a)}.`;
    return game.result === a ? `Called a ${word(a)}: hit.` : `Called a ${word(a)}: miss.`;
  }
  if (a !== null) return `If ${theGame(newer)} is also a ${word(a)}, the rule calls a ${word(a)}; otherwise no call.`;
  if (b !== null) return `If ${theGame(older)} is also a ${word(b)}, the rule calls a ${word(b)}; otherwise no call.`;
  return 'Depends on two unplayed games.';
}

// Remaining games this season where a named rule can fire.
export function upcomingRuleCalls(seq, rules = RULES) {
  const last = lastPlayedIndex(seq);
  const season = seq[last + 1]?.season;
  const out = [];
  for (let j = last + 1; j < seq.length && seq[j].season === season; j++) {
    for (const [id, rule] of Object.entries(rules)) {
      const inputs = ruleInputs(seq, j, rule);
      if (!inputs) continue;
      const [older, newer] = inputs.map((i) => seq[i]);
      out.push({ rule: id, game: seq[j], older, newer, status: ruleStatus(older, newer, null, rule) });
    }
  }
  return out;
}
