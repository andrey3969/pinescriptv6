import { isDecided } from './data.js';
import { scheduleIndex } from './features.js';
import { fitModel, makeContext } from './models.js';

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

function ruleStatus(first, middle) {
  const [a, b] = [first.result, middle.result];
  if (a === 0 || b === 0) return 'No call (a tie).';
  if (a !== null && b !== null) return a === b ? `The rule calls a ${word(a)}.` : 'No call: the two lookback results disagree.';
  if (a !== null) return `If ${theGame(middle)} is also a ${word(a)}, the rule calls a ${word(a)}; otherwise no call.`;
  if (b !== null) return `If ${theGame(first)} is also a ${word(b)}, the rule calls a ${word(b)}; otherwise no call.`;
  return 'Depends on two unplayed games.';
}

// Remaining games this season where both lookback games exist, with the
// rule's call already known, still pending, or impossible.
export function upcomingRuleCalls(seq, d1 = 28, d2 = 10) {
  const last = lastPlayedIndex(seq);
  const season = seq[last + 1]?.season;
  const { byDay } = scheduleIndex(seq);
  const out = [];
  for (let j = last + 1; j < seq.length && seq[j].season === season; j++) {
    const i = byDay.get(seq[j].day - d1);
    const k = byDay.get(seq[j].day - d2);
    if (i === undefined || k === undefined) continue;
    out.push({ game: seq[j], first: seq[i], middle: seq[k], status: ruleStatus(seq[i], seq[k]) });
  }
  return out;
}
