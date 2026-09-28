import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.js';

export const DATA_FILE = fileURLToPath(new URL('../data/games.csv', import.meta.url));

export const TEAM_NAMES = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills',
  CAR: 'Carolina Panthers', CHI: 'Chicago Bears', CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns',
  DAL: 'Dallas Cowboys', DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers',
  HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars', KC: 'Kansas City Chiefs',
  LA: 'Los Angeles Rams', LAC: 'Los Angeles Chargers', LV: 'Las Vegas Raiders', MIA: 'Miami Dolphins',
  MIN: 'Minnesota Vikings', NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants',
  NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers', SEA: 'Seattle Seahawks',
  SF: 'San Francisco 49ers', TB: 'Tampa Bay Buccaneers', TEN: 'Tennessee Titans', WAS: 'Washington Commanders',
};

// Relocated franchises keep one code so their history stays continuous.
const FRANCHISE = { OAK: 'LV', SD: 'LAC', STL: 'LA' };
export const franchise = (code) => FRANCHISE[code] ?? code;

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Whole days since 1970-01-01, so calendar lags are plain subtraction.
export function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}
export const isoDate = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
export const weekdayName = (day) => WEEKDAYS[(((day + 4) % 7) + 7) % 7]; // day 0 was a Thursday

export const loadGames = (file = DATA_FILE) => parseCsv(readFileSync(file, 'utf8'));

const num = (s) => (s === '' || s === 'NA' || s == null ? null : Number(s));

// One team's games in date order, from that team's point of view.
// result: 1 win, -1 loss, 0 tie, null not played yet.
// spread: points the team was favored by (negative = underdog).
export function teamSchedule(games, team) {
  const seq = [];
  for (const g of games) {
    const home = franchise(g.home_team);
    const away = franchise(g.away_team);
    if (home !== team && away !== team) continue;
    const isHome = home === team;
    const hs = num(g.home_score);
    const as = num(g.away_score);
    const played = hs !== null && as !== null;
    const spread = num(g.spread_line);
    const day = dayNumber(g.gameday);
    seq.push({
      gameId: g.game_id,
      season: Number(g.season),
      gameType: g.game_type,
      week: Number(g.week),
      date: g.gameday,
      day,
      weekday: weekdayName(day),
      opp: isHome ? away : home,
      home: g.location === 'Neutral' ? 0 : isHome ? 1 : -1,
      designatedHome: isHome, // the side the point spread is quoted for, even at neutral sites
      div: g.div_game === '1',
      pf: played ? (isHome ? hs : as) : null,
      pa: played ? (isHome ? as : hs) : null,
      result: played ? Math.sign(isHome ? hs - as : as - hs) : null,
      spread: spread === null ? null : isHome ? spread : -spread,
    });
  }
  return seq.sort((a, b) => a.day - b.day);
}

export const allTeams = (games) =>
  [...new Set(games.flatMap((g) => [franchise(g.home_team), franchise(g.away_team)]))].sort();

export const resultChar = (r) => (r === 1 ? 'W' : r === -1 ? 'L' : r === 0 ? 'T' : '?');

export const isDecided = (r) => r === 1 || r === -1;
