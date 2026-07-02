# pinescriptv6

TradingView Pine Script v6 indicators.

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

## MNQ Research Lab

`MNQ_Research.pine` — a research instrument (not a signal generator) for the
Micro E-mini Nasdaq-100 (MNQ). For every regular session it builds the opening
range, records the first breakout, and measures how far price actually travels
afterwards, rolling the results into a running statistics dashboard shown in
both index points and MNQ dollars ($2 / point / contract).

Per session it tracks:

1. **Opening range** — high/low of the first *N* minutes, then locked.
2. **First breakout** — direction and level of the first break of that range.
3. **Excursions** — post-break max favourable / adverse excursion (MFE / MAE)
   and whether a configurable target was reached before the close.
4. **Aggregates** — breakout rate, up/down split, target hit-rate, average
   MFE/MAE, average RTH range, and a net edge (MFE − MAE) estimate.

### Inputs
- **Session (RTH)** — session window and timezone.
- **Opening Range** — opening-range length in minutes.
- **Research** — target in points and the dollar value per point (MNQ = $2).
- **Display** — draw the opening range, mark breakouts, show the stats table.
