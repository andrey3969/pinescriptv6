# seahawks-nn

A neural network that tries to predict Seattle Seahawks results from nothing but
Seattle's own win/loss sequence and the calendar spacing of its games, plus the
statistical checks needed to tell a real pattern from a lucky one.

**Results: [`results/analysis.pdf`](results/analysis.pdf)** (detailed, with charts) and
[`results/REPORT.md`](results/REPORT.md) (regenerate with `node cli.js report`, then `node cli.js pdf`).

**Lattice lab: [`results/lattice-lab.pdf`](results/lattice-lab.pdf)**: about 300,000 lattices
(day intervals, two- and three-lookback rules, gap + k-th previous rules, game-count repeats,
streaks, phases, cycles, compressibility) on all 32 teams, against two null models, with a
hold-out test on 2013-2025, season cycles (the 23-year idea) and thirteen league-wide prediction
models against the point spread. Part II looks for lattices of my own and scores them against the
spread: 18 with a physical reason (rest, byes, body clock and time zones, rematches, overreaction,
a full-moon control), echoes in the part of each result the market did not expect, and a machine
search over ~27,000 lattices found on 1999-2012 and scored on 2013-2025 and 2026. All of them are
registered in `ledger.json` for forward scoring. Raw numbers in [`results/lab.json`](results/lab.json).

Zero dependencies: plain Node.js 20+, no `npm install`. Works for any team code (`--team KC`).
Only the PDF step needs Playwright's Chromium; without it `node cli.js pdf` writes the HTML instead.

## Commands

```sh
node cli.js report      # full analysis -> results/REPORT.md, results.json, predictions.csv (~4 min)
node cli.js report --quick          # same with fewer shuffles (~1 min)
node cli.js render      # rebuild REPORT.md from results/results.json without recomputing
node cli.js pdf         # detailed PDF analysis with charts -> results/analysis.pdf
node cli.js evaluate    # walk-forward accuracy of every model
node cli.js scan        # calendar and game-order rule families vs. shuffled seasons
node cli.js predict     # next game's win probability + where the named rules can fire this season
node cli.js ledger      # score the rules in ledger.json only on games after they were written down,
                        # and list the open picks of the league-wide lattices against the spread
node cli.js crossteam   # the rules on the other 31 teams, and every team's own rules found in
                        # 1999-2012 scored on 2013-2025, against shuffles and the point spread
node cli.js query --lag 28 --mid 10          # every game with games 28 and 10 days before it
node cli.js query --gap 10 --position 4      # every game 10 days after the last one vs. the 4th-previous
node cli.js query --gap 10 --position 4 --same-season   # same, all games in one season
node cli.js query --lag 14 --consecutive     # repeats/reversals, back-to-back games 14 days apart
node cli.js query --lag 14 --from 2003 --to 2025   # same for all pairs, any era
node cli.js query --equal-gap 6 --count 3 [--all-teams]   # "6 x 3 = 18": three 6-day gaps in a row
node cli.js lab         # lattice lab on all 32 teams -> results/lab.json + lattice-lab.pdf (~12 min)
node cli.js lab --quick             # fewer null histories, no calibration or power runs (~3 min)
node cli.js lab --parts own,power   # recompute only those parts, keep the rest of lab.json
node cli.js lab-pdf     # rebuild results/lattice-lab.pdf from results/lab.json
npm test                # unit tests (leakage, network, statistics, data)
npm run update-data     # refresh data/games.csv from nflverse on GitHub
npm run update-data -- ../nfldata/data/games.csv   # ...or from a local clone of nflverse/nfldata
```

Common options: `--team SEA --from 1999 --to 2025 --test-from 2004 --seeds 5 --workers 4`.

## What it tests

| Question | How |
| --- | --- |
| Can a network predict games from results + timing alone? | Walk-forward: train on 1999 through season Y-1, predict season Y, for every Y from 2004 on. |
| Is it better than simple rules? | Same test for: always pick the team, home team, repeat last result, season record, Vegas spread. |
| Is there any order in the real sequence? | Re-run everything on 200 histories where each season's results are dealt out in random order. |
| Is the 28/10 rule real? | Scan every two-lookback rule up to 63 days, compare the best real rules with the best rules of 2,000 shuffled histories. |
| Is the 10-day, 4th-previous rule real? | Same, for every game-order rule (any gap up to 21 days, positions 2–8, any season or same season), corrected together with the calendar rules. |
| Do the rules hold up going forward? | `ledger.json` records each rule with the date it was written down; `node cli.js ledger` scores it only on later games. |
| Do specific intervals repeat or reverse? | Same-result rates for every interval 1–400 days and every back-to-back gap, with false-discovery-rate correction. |
| Does each team have its own pattern? | The scan and the network for all 32 franchises. |
| Do the patterns hold on fresh data? | `crossteam`: Seattle's rules on the other 31 teams; each team's best and near-perfect rules found in 1999–2012, scored on 2013–2025; all against shuffles and the point spread. |
| Is there any lattice at all, on any team? | `lab`: ten families of lattices (~9,000 per team, ~300,000 in all) on every team and all 32 pooled. Each family is judged by its strongest lattice, by many weak ones together, by how many teams have their "own" lattice, and by a 1999–2012 → 2013–2025 hold-out. Two null models keep every team-season record: a shuffle, and a spread-weighted shuffle that also keeps who played whom and where. The engine is checked on pure-noise histories first. |
| Do seasons echo (23-year batches)? | `lab`: correlation of season win rates 1–26 seasons apart vs. random season order and vs. replays from the point spread. |
| Are there lattices of my own that beat the spread? | `lab` part II: mechanism lattices (rest, body clock, travel, rematches, overreaction, moon control), residual echoes (margin minus spread at game and day intervals, sign-flip null) and a machine search over one- to three-condition lattices (1999–2012 → 2013–2025 → 2026), all as picks against the spread; registered in `ledger.json`. |
| Can any model use lattices to predict? | `lab`: ridge, lasso, naive Bayes, random forest, neural network, pattern matcher and per-team models trained league-wide, walk-forward in four blocks, against the point spread. |

## Layout

```
cli.js              command line
src/data.js         loads data/games.csv; one team's games from its point of view
src/features.js     leak-free inputs (results by game order, by calendar day, gaps, weekday, spread, form)
src/nn.js           the network: tanh hidden layer, Adam, L2, early stopping, seed ensembles
src/models.js       baselines and walk-forward evaluation
src/rules.js        the hand-found rules (28/10 calendar rule, 10-day game-order rule)
src/scan.js         interval scans and rule-family scans against shuffled seasons
src/ledger.js       forward scoring of the rules in ledger.json
src/crossteam.js    out-of-sample tests on other teams and later seasons
src/jobs.js         runs shuffles / teams across worker threads
src/pipeline.js     the full analysis; src/report.js renders REPORT.md
src/pdf.js          the PDF analysis (HTML + inline SVG charts, printed with Chromium)
src/lab/            the lattice lab: families.js, spectral.js (lattice families), engine.js +
                    worker.js + familytest.js (null models, z-scores, family-wise tests),
                    seasons.js, ml.js (league-wide models), own.js (my lattices against
                    the spread), run.js, pdf.js
data/games.csv      nflverse games.csv (every NFL game since 1999), trimmed to the columns used
```

Data: [nflverse/nfldata](https://github.com/nflverse/nfldata) `games.csv`, compiled by Lee Sharpe.
Relocated franchises are merged (OAK→LV, SD→LAC, STL→LA).
