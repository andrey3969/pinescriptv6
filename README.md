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

## Maintenance

**Project and security maintainer:** [Andrey (@andrey3969)](https://github.com/andrey3969).

The maintainer is responsible for reviewing changes to this repository,
receiving and assessing security reports, and coordinating fixes and disclosures
when a security issue is confirmed. This responsibility covers this repository's
Pine Script source and documentation.

## Reporting issues

Use [GitHub Issues](https://github.com/andrey3969/pinescriptv6/issues) for ordinary
bugs, questions, and feature requests. For a potential security vulnerability,
follow the [security policy](SECURITY.md) and use private reporting.
