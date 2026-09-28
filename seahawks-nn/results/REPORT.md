# Seattle Seahawks: neural network pattern test, 1999–2025

*Generated 2026-09-28 from nflverse game data through 2026-09-27 (@ WAS, L 31–33). Rebuild with `node cli.js report`.*

SEA went 269–199–1 (57.5% wins) over 469 games in 1999–2025, playoffs included. Any pattern has to beat that win rate to be worth anything.

## Bottom line

- **The neural network did not beat the simplest baseline.** It saw only SEA's own results and the calendar spacing of its games, and was tested season by season on games it had never seen (2004–2025, 386 games). It picked **52.3%** correctly, against **59.1%** for picking SEA every week and **69.2%** for the Vegas favorite (the gap to picking SEA every week is significant, the wrong way: McNemar p = 0.03).
- **Shuffle test.** On 200 copies of history with each season's results dealt out in random order, the same network scored 53.5% on average (90% of runs between 50.2% and 56.5%); on the real order it scored 52.8% (p = 0.63 for accuracy, 0.08 for log-loss). Neither is significant: the real order is not detectably more predictable than a random reshuffle of the same seasons.
- **The 28/10 rule really is 8-for-8 in 1999–2025, matching your count, but a search produces results like that.** 116 different "if the games d1 and d2 days back agree, repeat it" rules have at least 8 cases here. In 57% of shuffled histories at least one of them looks this good (p after the search = 0.57). Across the other 31 teams the same rule is right 118 of 198 times (60%); shuffling those teams' seasons gives 57%. It beats 50% only because good seasons stay good.
- **No interval between games shows a real repeat-or-reverse pattern** once you allow for how many were checked (lowest false-discovery q = 0.41 across 87 intervals of 1–400 days, and 0.34 for back-to-back games).
- **3, 4, 7, 10, 11 and 14 are the NFL weekday grid.** A 4-day gap is Sunday→Thursday, 10 days is Thursday→Sunday, 8 + 6 is Sunday→Monday→Sunday, 14 is a bye week. Details in section 5.
- **Every team has "its own" best rule, because every noisy sequence does.** 26 of the other 31 teams have a rule that looks at least as strong as SEA's 28/10 by the same measure, spread over 24 different interval pairs, and 11 of them have at least one perfect rule (every case repeated, or every case reversed) with 8+ cases. After correcting for the search, 2 of 32 teams' best rules pass at the 5% level, where chance alone gives about 1.6 (PHI 35 & 21 days, 56/74; SF 42 & 28 days, 62/83).
- **Live test, 2026-10-25 Sun vs KC:** 28 days before is 2026-09-27 @ WAS (L); 10 days before is 2026-10-15 Thu @ DEN (not played). If the Thu 2026-10-15 game @ DEN is also a loss, the rule calls a loss; otherwise no call. A rule only gets a fair test on games played after it was written down.

## 1. Out-of-sample test (walk-forward)

For every season from 2004 to 2025, each model was trained on 1999 through the season before and then predicted every game of that season. Nothing from a season is seen before it is predicted. Log-loss rewards confident correct calls and punishes confident misses; lower is better, and always saying 50/50 scores 0.693.

| Model | Games | Correct | 95% range | Log-loss |
| --- | ---: | ---: | ---: | ---: |
| Vegas point spread | 386 | 69.2% | 64%–74% | 0.586 |
| Neural net: spread + home + form | 386 | 65.3% | 60%–70% | 0.610 |
| Neural net: everything | 386 | 60.4% | 55%–65% | 0.665 |
| Always pick this team | 386 | 59.1% | 54%–64% | 0.684 |
| Pick the home team | 386 | 58.3% | 53%–63% | 0.673 |
| Season-to-date record | 386 | 57.8% | 53%–63% | 0.685 |
| Logistic regression: results + timing | 386 | 55.4% | 50%–60% | 0.685 |
| Neural net: last 8 results, no dates | 386 | 55.2% | 50%–60% | 0.692 |
| Neural net: results + timing | 386 | 52.3% | 47%–57% | 0.695 |
| Repeat the previous result | 386 | 48.7% | 44%–54% | 0.698 |
| 28/10-day agreement rule * | 8 | 100.0% | 68%–100% | – |

\* The rule only makes a call on 8 of these games, and it was found by looking at these same seasons, so its row is not out-of-sample. Section 3 corrects it for the search.

Head to head, the results + timing network and always picking SEA disagreed on 130 games: the network was right on 52 of them and always-SEA on 78 (McNemar p = 0.03). The everything network against the Vegas line: 39 vs 73 (p = 0.002). Adding the results + timing inputs to the spread + home + form network made it worse (65.3% → 60.4%, log-loss 0.610 → 0.665).

**Robustness.** The network settings were fixed before testing. Other reasonable settings give the same picture:

| Results + timing network | Correct | Log-loss |
| --- | ---: | ---: |
| default (16 hidden, L2 0.01, early stopping) | 52.3% | 0.695 |
| 4 hidden units | 52.3% | 0.697 |
| 64 hidden units | 52.6% | 0.709 |
| weak L2 (0.001) | 50.0% | 0.696 |
| strong L2 (0.1) | 53.4% | 0.689 |
| no early stopping, 200 epochs | 50.0% | 0.956 |

## 2. Shuffle test: is there any order in the sequence?

Each shuffle keeps every game's date, opponent and home/away, and every season's record, but deals that season's results out in random order. If SEA's wins and losses follow a calendar lattice, a network trained on the real order should beat networks trained on shuffled orders. Each row is the real score against 200 shuffles (3-network ensembles, same walk-forward).

| Model | Real | Shuffled (90% range) | p | Real log-loss | Shuffled | p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Neural net: results + timing | 52.8% | 50.2%–56.5% | 0.63 | 0.690 | 0.703 | 0.08 |
| Neural net: last 8 results, no dates | 54.4% | 50.2%–56.7% | 0.44 | 0.696 | 0.700 | 0.35 |
| Logistic regression: results + timing | 54.9% | 52.6%–58.6% | 0.61 | 0.687 | 0.690 | 0.33 |
| Repeat the previous result | 48.7% | 46.1%–56.5% | 0.76 | 0.698 | 0.695 | 0.83 |

## 3. The 28/10 rule, case by case

Every SEA game in 1999–2025 with a game exactly 28 and 10 days earlier. The endpoints (28 days apart) match in 10 of 11; the rule fires when the first two agree, and the third matched 8 of 8.

| Game | 28 days before | 10 days before | Result | Rule |
| --- | --- | --- | --- | --- |
| 2008-12-07 vs NE | 2008-11-09 L | 2008-11-27 Thu L | L | hit |
| 2012-10-28 @ DET | 2012-09-30 L | 2012-10-18 Thu L | L | hit |
| 2014-12-07 @ PHI | 2014-11-09 W | 2014-11-27 Thu W | W | hit |
| 2018-11-25 @ CAR | 2018-10-28 W | 2018-11-15 Thu W | W | hit |
| 2019-10-13 @ CLE | 2019-09-15 W | 2019-10-03 Thu W | W | hit |
| 2021-10-17 @ PIT | 2021-09-19 L | 2021-10-07 Thu L | L | hit |
| 2023-12-10 @ SF | 2023-11-12 W | 2023-11-30 Thu L | L | no call |
| 2024-10-20 @ ATL | 2024-09-22 W | 2024-10-10 Thu L | W | no call |
| 2025-01-05 @ LA | 2024-12-08 W | 2024-12-26 Thu W | W | hit |
| 2025-10-05 vs TB | 2025-09-07 L | 2025-09-25 Thu W | L | no call |
| 2025-12-28 @ CAR | 2025-11-30 W | 2025-12-18 Thu W | W | hit |

Every "10 days before" game is a Thursday, so the rule really says "after a Thursday game, compare with four weeks earlier". SEA played 21 Thursday games in 1999–2025, the first on 2006-12-14, so the rule gets about one chance a season at most. On its own, 8/8 would be rare (binomial p = 0.008; shuffle p = 0.004). But it is one of 116 rules with at least 8 cases. The real history has 3 rules this strong; shuffled histories average 1.0, and 10% of them have 3 or more. Requiring at least 8 cases is the cutoff most favorable to 28/10; a broader search makes the correction bigger.

| Strongest rules found | Cases | Repeated | Rate | p alone | p after search |
| --- | ---: | ---: | ---: | ---: | ---: |
| 49 & 28 days | 67 | 45 | 67% | 0.007 | 0.43 |
| 28 & 10 days | 8 | 8 | 100% | 0.008 | 0.57 |
| 35 & 10 days | 8 | 8 | 100% | 0.008 | 0.57 |
| 35 & 28 days | 84 | 54 | 64% | 0.01 | 0.62 |
| 42 & 13 days | 10 | 9 | 90% | 0.02 | 0.81 |
| 55 & 34 days | 10 | 9 | 90% | 0.02 | 0.81 |
| 39 & 18 days | 9 | 8 | 89% | 0.04 | 0.96 |
| 62 & 27 days | 11 | 9 | 82% | 0.07 | 0.99 |

## 4. Repeats and reversals by interval

Back-to-back games grouped by the days between them. "Same" means the second game repeated the first result. The shuffled column is what reshuffled seasons produce for that gap.

| Gap | Weekdays | Pairs | Same | Rate | Shuffled | p | q |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 days | Sun→Thu | 19 | 10 | 53% | 55% | 0.98 | 1.00 |
| 6 days | Mon→Sun, Sun→Sat | 38 | 18 | 47% | 52% | 0.63 | 0.88 |
| 7 days | Sun→Sun, Sat→Sat | 294 | 142 | 48% | 52% | 0.16 | 0.37 |
| 8 days | Sun→Mon, Sat→Sun | 31 | 18 | 58% | 53% | 0.60 | 0.88 |
| 10 days | Thu→Sun | 14 | 11 | 79% | 55% | 0.10 | 0.34 |
| 13 days | Sun→Sat, Mon→Sun | 6 | 4 | 67% | 62% | 1.00 | 1.00 |
| 14 days | Sun→Sun, Sat→Sat | 27 | 9 | 33% | 54% | 0.05 | 0.34 |

Every pair of games 400 or fewer days apart (not only back-to-back), the most extreme intervals. q is the false-discovery-rate adjusted p-value; with this many intervals, some raw p-values under 0.05 are expected by chance.

| Interval | Pairs | Same | Rate | Shuffled | p | q |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 14 days | 276 | 124 | 45% | 52% | 0.006 | 0.41 |
| 55 days | 31 | 24 | 77% | 54% | 0.009 | 0.41 |
| 351 days | 43 | 30 | 70% | 51% | 0.02 | 0.51 |
| 105 days | 60 | 24 | 40% | 53% | 0.05 | 0.83 |
| 302 days | 27 | 9 | 33% | 52% | 0.05 | 0.83 |
| 288 days | 24 | 8 | 33% | 52% | 0.06 | 0.83 |
| 18 days | 20 | 15 | 75% | 54% | 0.07 | 0.83 |
| 266 days | 73 | 46 | 63% | 53% | 0.08 | 0.83 |

## 5. Where 3, 4, 7, 10, 11 and 14 come from

Nearly every NFL game is on a Sunday, Monday, Thursday or Saturday, so the gap between two games is a week plus or minus a weekday shift. SEA's back-to-back gaps, 1999–2025:

| Gap | Times | How it happens |
| --- | ---: | --- |
| 4 days | 19 | Sun→Thu (19) |
| 5 days | 1 | Tue→Sun (1) |
| 6 days | 38 | Mon→Sun (25), Sun→Sat (13) |
| 7 days | 296 | Sun→Sun (292), Sat→Sat (3), Thu→Thu (1) |
| 8 days | 31 | Sun→Mon (20), Sat→Sun (11) |
| 9 days | 3 | Thu→Sat (2), Sun→Tue (1) |
| 10 days | 14 | Thu→Sun (14) |
| 11 days | 4 | Thu→Mon (4) |
| 13 days | 6 | Sun→Sat (3), Mon→Sun (3) |
| 14 days | 27 | Sun→Sun (26), Sat→Sat (1) |
| 15 days | 3 | Sun→Mon (3) |

So 14 = 7 + 7 = 8 + 6 = 4 + 10 = 3 + 11 are the same two-week span with the middle game moved to a Monday or Thursday, and 21/7 is three weeks.

## 6. All 32 teams

The same search for every franchise, 1999–2025. "Best rule" is the strongest two-lookback rule found for that team (at least 8 cases); "after search" corrects for all the rules tried (1000 shuffles each). The last column is the results-and-timing network (walk-forward) against always predicting the team's more common result.

| Team | 28/10 rule | Best rule | Repeated | p after search | Network vs base rate |
| --- | ---: | --- | ---: | ---: | ---: |
| NE | 6/6 | 35 & 21 days | 75/99 | 0.44 | 69.0% vs 68.5% |
| CLE | 4/6 | 35 & 14 days | 82/111 | 0.28 | 64.9% vs 66.3% |
| SF | 4/6 | 42 & 28 days | 62/83 | 0.02 | 56.3% vs 50.8% |
| JAX | 6/7 | 28 & 14 days | 81/114 | 0.15 | 60.4% vs 57.9% |
| PHI | 4/6 | 35 & 21 days | 56/74 | 0.01 | 57.1% vs 58.1% |
| TEN | 6/10 | 56 & 28 days | 60/84 | 0.22 | 53.8% vs 44.3% |
| DET | 11/16 | 35 & 7 days | 62/88 | 0.80 | 61.6% vs 58.6% |
| CAR | 3/5 | 42 & 14 days | 72/105 | 0.41 | 53.3% vs 47.8% |
| KC | 3/6 | 28 & 7 days | 70/102 | 0.61 | 62.9% vs 54.5% |
| LAC | 4/5 | 28 & 7 days | 71/104 | 0.15 | 53.0% vs 43.0% |
| NYG | 2/5 | 35 & 7 days | 53/74 | 0.09 | 52.4% vs 53.2% |
| HOU | 4/6 | 28 & 21 days | 59/84 | 0.20 | 51.6% vs 53.8% |
| IND | 4/6 | 28 & 14 days | 74/111 | 0.44 | 59.3% vs 57.9% |
| LA | 3/4 | 28 & 7 days | 74/111 | 0.97 | 50.3% vs 43.6% |
| LV | 3/4 | 49 & 14 days | 54/78 | 0.56 | 57.1% vs 60.7% |
| CIN | 1/4 | 63 & 7 days | 51/73 | 0.29 | 52.2% vs 50.8% |
| DEN | 5/9 | 49 & 21 days | 48/69 | 0.23 | 53.9% vs 53.9% |
| NYJ | 5/6 | 62 & 56 days | 0/10 | 0.27 | 54.9% vs 53.3% |
| ARI | 2/4 | 28 & 21 days | 71/109 | 0.50 | 54.2% vs 55.9% |
| MIN | 4/8 | 48 & 42 days | 9/9 | 0.21 | 53.5% vs 48.9% |
| BUF | 0/1 | 35 & 21 days | 63/97 | 0.15 | 51.3% vs 48.1% |
| GB | 6/8 | 63 & 49 days | 39/56 | 0.59 | 59.2% vs 60.2% |
| CHI | 4/8 | 49 & 35 days | 49/73 | 0.53 | 49.0% vs 51.5% |
| **SEA** | 8/8 | 49 & 28 days | 45/67 | 0.41 | 52.8% vs 59.1% |
| PIT | 4/8 | 56 & 14 days | 39/57 | 0.69 | 60.9% vs 63.0% |
| ATL | 2/6 | 60 & 4 days | 8/8 | 0.37 | 50.7% vs 45.5% |
| NO | 2/6 | 50 & 22 days | 8/8 | 0.63 | 51.3% vs 52.4% |
| TB | 3/4 | 42 & 7 days | 48/73 | 0.84 | 51.8% vs 49.9% |
| BAL | 3/5 | 49 & 35 days | 51/79 | 0.75 | 55.0% vs 59.2% |
| DAL | 6/13 | 53 & 4 days | 12/14 | 0.61 | 51.8% vs 46.1% |
| WAS | 3/4 | 41 & 14 days | 10/12 | 0.88 | 54.4% vs 58.8% |
| MIA | 1/6 | 48 & 7 days | 8/9 | 0.81 | 48.2% vs 47.9% |

The results-and-timing network beat its team's base rate on accuracy for 18 of 32 teams and on log-loss for 9 of 32 (averaged over teams: 55.3% vs 53.9%). If each team had its own hidden lattice, a network trained on that team alone should find it and beat the base rate consistently. It does the opposite: its probabilities are worse than the base rate for most teams (sign test p = 0.02), which is what fitting noise looks like.

## 7. Next game

**2026-10-04 Sun vs LAC** (SEA favored by 6.5). Models retrained on all 471 finished games through 2026-09-27.

| Model | P(SEA wins) |
| --- | ---: |
| Always pick this team | 58% |
| Vegas point spread | 76% |
| Neural net: spread + home + form | 72% |
| Neural net: everything | 80% |
| Neural net: results + timing | 66% |
| Neural net: last 8 results, no dates | 71% |

Only the models that use the point spread beat the base rate out of sample (section 1). Treat the results-and-timing numbers as noise.

## Method

- **Data:** nflverse `games.csv` (Lee Sharpe), every NFL game since 1999 with dates, scores and closing spreads. Ties count as neither result.
- **Network:** 84 inputs for the results + timing model: the last 8 results in game order, the last 4 day gaps, the result exactly d days earlier for every d from 1 to 63 (0 if no game), and the weekday. The full model adds home/away, playoff, week, division game, season-to-date record, last season's record, point differential and the spread (93 inputs). One hidden layer of 16 tanh units, sigmoid output, Adam (lr 0.01), L2 0.01, early stopping on a random 20% of the training games, ensemble of 5 seeds. Logistic regression is the same network with no hidden layer.
- **Validation:** expanding-window walk-forward by season; train 1999..Y-1, test Y, for Y = 2004..2025. Hyperparameters were fixed before any test season was scored.
- **Null model:** within-season shuffles keep schedules and season records and destroy only the order of results. Interval scan: 2000 shuffles; rules use lookbacks up to 63 days with at least 8 cases; "after search" p-values compare each rule with the best rule of every shuffled history (min-p family-wise correction); interval tables use Benjamini–Hochberg q-values.
- **Files:** `results/results.json` has every number in this report; `results/predictions.csv` has every walk-forward prediction.
