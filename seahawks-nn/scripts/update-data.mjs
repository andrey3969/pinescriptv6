#!/usr/bin/env node
// Refresh data/games.csv from nflverse's games.csv (every NFL game, 1999-present).
//
//   node scripts/update-data.mjs                       # download from GitHub
//   node scripts/update-data.mjs path/to/games.csv     # use a local copy
//
// A local copy can come from `git clone --depth 1 https://github.com/nflverse/nfldata`.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv, toCsv } from '../src/csv.js';
import { DATA_FILE } from '../src/data.js';

const SOURCE_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const KEEP = [
  'game_id', 'season', 'game_type', 'week', 'gameday', 'weekday', 'gametime',
  'away_team', 'away_score', 'home_team', 'home_score', 'location', 'overtime',
  'spread_line', 'away_rest', 'home_rest', 'div_game',
];

const src = process.argv[2];
let text;
if (src) text = readFileSync(src, 'utf8');
else {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (pass a local games.csv instead)`);
  text = await res.text();
}

const rows = parseCsv(text);
const missing = KEEP.filter((c) => !(c in rows[0]));
if (missing.length) throw new Error(`source is missing columns: ${missing.join(', ')}`);
writeFileSync(DATA_FILE, toCsv(rows, KEEP));

const played = rows.filter((r) => r.home_score !== '').length;
const last = rows.filter((r) => r.home_score !== '').at(-1);
console.log(`wrote ${rows.length} games (${played} played, latest ${last?.gameday}) to ${DATA_FILE}`);
