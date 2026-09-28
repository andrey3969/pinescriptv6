// Forward-test ledger: each registered rule is scored only on games dated
// after the day it was written down.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDecided, teamSchedule } from './data.js';
import { ruleStatus } from './predict.js';
import { ruleCall, ruleInputs } from './rules.js';

export const LEDGER_FILE = fileURLToPath(new URL('../ledger.json', import.meta.url));
export const loadLedger = (file = LEDGER_FILE) => JSON.parse(readFileSync(file, 'utf8'));

export function scoreLedger(games, ledger) {
  const schedules = new Map();
  return ledger.rules.map((rule) => {
    if (!schedules.has(rule.team)) schedules.set(rule.team, teamSchedule(games, rule.team));
    const seq = schedules.get(rule.team);
    const results = seq.map((g) => g.result);
    const calls = [];
    seq.forEach((g, j) => {
      if (g.date <= rule.registered) return;
      const inputs = ruleInputs(seq, j, rule);
      if (!inputs) return;
      const [older, newer] = inputs.map((i) => seq[i]);
      const call = ruleCall(results, inputs);
      calls.push({
        game: g,
        older,
        newer,
        call,
        hit: call !== null && isDecided(g.result) ? g.result === call : null,
        status: ruleStatus(older, newer, g),
      });
    });
    const scored = calls.filter((c) => c.hit !== null);
    return { ...rule, calls, n: scored.length, hits: scored.filter((c) => c.hit).length };
  });
}
