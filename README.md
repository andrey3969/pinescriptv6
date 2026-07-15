# pinescriptv6

TradingView Pine Script v6 indicators.

## APCE

`APCE.pine` — **A**daptive **P**rice **C**ycle **E**ngine. It estimates the
market's dominant cycle on the fly and reads price through that lens, adapting
every smoothing length to the measured cycle instead of a fixed period.

1. **Cycle length** — the bar-distance between zero crossings of a detrended
   price series gives an adaptive cycle estimate (clamped to a chosen range).
2. **Cycle phase** — detrended price, adaptively smoothed and self-scaled,
   becomes a normalized −100…+100 oscillator.
3. **Superiority** — how much of price movement the clean cycle explains versus
   residual noise (0…100). High superiority = the cycle is worth trading; low =
   choppy tape, so the oscillator fades and signals are gated off.

Signals fire on cycle turns (exiting overbought / oversold) but only while the
cycle superiority clears its threshold. Output includes a colored oscillator,
overbought/oversold + zero lines, confirmed-turn labels, a status table
(phase, score, superiority, cycle length, trust), and `Long`/`Short` alerts.

### Inputs
- **Cycle Engine** — source, detrend baseline, min/max cycle bounds, adaptive
  smoothing fraction, sensitivity.
- **Signals** — overbought level, minimum cycle superiority, output smoothing.
- **Display** — toggle signal labels and the status table.

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
