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
