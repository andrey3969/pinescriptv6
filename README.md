# pinescriptv6

TradingView Pine Script v6 indicators.

Also here: [`seahawks-nn/`](seahawks-nn/), a dependency-free Node.js neural network and
pattern scanner for Seattle Seahawks results since 1999 (see the
[PDF analysis](seahawks-nn/results/analysis.pdf) or the [report](seahawks-nn/results/REPORT.md)),
and a lattice lab that tests ~300,000 calendar lattices on all 32 NFL teams
([lattice-lab.pdf](seahawks-nn/results/lattice-lab.pdf)).

And [`btc-ledger/`](btc-ledger/): a forward ledger for Bitcoin up/down rules, starting with
"fade yesterday" (call each day the opposite of the day before), scored only on days after
2026-09-28.

## ChronoForge

`ChronoForge.pine` — a multi-timeframe trend & momentum "forge" that blends
three time perspectives into one normalized score (−100…+100):

1. **Trend** — fast/slow EMA spread measured on a higher timeframe, ATR-normalized.
2. **Momentum** — RSI re-centered around zero.
3. **Chrono** — trading-session context (Asia / London / New York) that amplifies
   the prevailing directional pressure.

The blended, smoothed score drives a colored oscillator, threshold lines, bias
flip labels, a status table, and `LONG`/`SHORT` alerts.

### Inputs
- **Trend Forge** — higher timeframe, fast/slow EMA lengths, trend weight.
- **Momentum** — RSI length and weight.
- **Chrono / Sessions** — toggle session weighting, session windows, session boost.
- **Output** — score smoothing and signal threshold.
