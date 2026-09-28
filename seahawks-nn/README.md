# seahawks-nn

A neural network that tries to predict Seattle Seahawks results from nothing but
Seattle's own win/loss sequence and the calendar spacing of its games, plus the
statistical checks needed to tell a real pattern from a lucky one.

**Results: [`results/analysis.pdf`](results/analysis.pdf)** (detailed, with charts) and
[`results/REPORT.md`](results/REPORT.md) (regenerate with `node cli.js report`, then `node cli.js pdf`).

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
node cli.js ledger      # score the rules in ledger.json only on games after they were written down
node cli.js query --lag 28 --mid 10          # every game with games 28 and 10 days before it
node cli.js query --gap 10 --position 4      # every game 10 days after the last one vs. the 4th-previous
node cli.js query --gap 10 --position 4 --same-season   # same, all games in one season
node cli.js query --lag 14 --consecutive     # repeats/reversals, back-to-back games 14 days apart
node cli.js query --lag 14 --from 2003 --to 2025   # same for all pairs, any era
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
src/jobs.js         runs shuffles / teams across worker threads
src/pipeline.js     the full analysis; src/report.js renders REPORT.md
src/pdf.js          the PDF analysis (HTML + inline SVG charts, printed with Chromium)
data/games.csv      nflverse games.csv (every NFL game since 1999), trimmed to the columns used
```

Data: [nflverse/nfldata](https://github.com/nflverse/nfldata) `games.csv`, compiled by Lee Sharpe.
Relocated franchises are merged (OAK→LV, SD→LAC, STL→LA).
