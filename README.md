# pinescriptv6

TradingView Pine Script v6 indicators and reusable scoring functions.

## ChronoForge

[ChronoForge.pine](ChronoForge.pine) blends three components into a smoothed
directional score (−100…+100 once sufficient data is available):

1. **Trend** — fast/slow EMA spread measured on a higher timeframe, ATR-normalized.
2. **Momentum** — RSI re-centered around zero.
3. **Session context** — a directional boost during configurable session windows.
   The session names are labels; their times use the symbol's exchange timezone.

The blended, smoothed score drives a colored oscillator, threshold lines, bias
flip labels, a status table, and `LONG`/`SHORT` alert conditions. It is an indicator
for evaluation, with no established trading performance.

![ChronoForge in a separate TradingView QA layout](ChronoForge-preview.jpg)

## Install and evaluate

The [public open-source TradingView publication](https://www.tradingview.com/script/BMW6dSsX-ChronoForge-Multi-Timeframe-Trend-and-Momentum/)
is available under **Andreyt4**. Open it and use **Add to favorites** to find it
from TradingView, or evaluate it with **Use on chart** in a separate layout.
The publication includes the approved MIT notice in its source.

For a local working copy, follow these steps:

1. Open [ChronoForge.pine](ChronoForge.pine), select **Raw**, and copy the source.
2. Create a separate TradingView chart layout and a new Pine Editor indicator.
3. Replace the template with this source, save it, and select **Add to chart**.
4. Start with default inputs on a standard 5-minute candle chart. The default
   requested timeframe is 60 minutes. This is a demonstration setup, not a
   performance recommendation.

Read the [quick start and calculation details](QUICKSTART.md) before interpreting
signals. The current bar and requested higher-timeframe values can change before
their candles close; this script is **not non-repainting**.

The [validation record](VALIDATION.md) reports the native compile and display
checks. [Adoption evidence](ADOPTION.md) records verified public reuse separately
from publication and popularity.

### Inputs
- **Trend Forge** — higher timeframe, fast/slow EMA lengths, trend weight.
- **Momentum** — RSI length and weight.
- **Chrono / Sessions** — toggle session weighting, session windows, session boost.
- **Output** — score smoothing and signal threshold.

## Reusable scoring library

[ChronoForgeMath.pine](ChronoForgeMath.pine) extracts the score calculation into
three documented exports for other developers: ATR-normalized EMA spread,
weighted trend/momentum score, and LONG/SHORT/FLAT classification. Callers control
market data requests, timeframes, sessions, smoothing and alerts.

**Public TradingView library publication is blocked by the account plan.** TradingView
currently requires a paid plan to publish it. Its private QA copy passed 325 imported-library assertions and the higher-timeframe consumer
compiled and ran in Pine v6. The planned public import cannot be used until the
library is published. Read the [API and integration guide](REUSE.md) and
[validation record](REUSE_VALIDATION.md) for exact behavior and limitations.

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

## License

This project is licensed under the [MIT License](LICENSE).
