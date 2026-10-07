# ChronoForge quick start

## Installation

Use a separate chart layout for evaluation. Open `ChronoForge.pine` on GitHub,
select **Raw**, and copy all the source. In TradingView's Pine Editor, create a
new **Indicator**, replace the template, save it under a distinct name, and
select **Add to chart**. The first line must remain `//@version=6`.

For the demonstrated setup, use standard 5-minute candles with the default
60-minute requested timeframe. Choose a requested timeframe greater than the
chart timeframe when evaluating the intended higher-timeframe trend component.
The script does not enforce this relationship.

## Reading the output

- **Teal / LONG:** the score is at or above the positive threshold.
- **Red / SHORT:** the score is at or below the negative threshold.
- **Gray / FLAT:** the score is between those thresholds.
- **Blue background / Session ON:** at least one configured session is active
  and session weighting is enabled. Overlapping sessions add one boost.
- **Flip labels:** the score has newly entered the corresponding threshold region.

LONG and SHORT describe oscillator states. The indicator does not place orders
or produce a strategy backtest. These states do not establish expected returns.

## Calculation

1. Request fast and slow EMAs in the selected timeframe with `lookahead_off`.
2. Divide their spread by the chart timeframe's 14-bar ATR, clamp it to −1…+1,
   and multiply by the trend weight.
3. Center chart-timeframe RSI with `(RSI - 50) / 50`, clamp it to −1…+1, and
   multiply by the momentum weight.
4. Add the session boost in the direction of the combined trend and momentum
   components. At an exactly zero combined value, the boost is positive.
5. Divide by the sum of trend, momentum, and configured session weights,
   multiply by 100, then apply EMA smoothing.

The denominator includes the configured session weight even outside sessions or
when session weighting is disabled. Set **Session Boost** to zero if you want
that weight removed from both the numerator and denominator. With all three
weights zero, the raw score is zero.

## Inputs and defaults

| Input | Default | Purpose |
| --- | --- | --- |
| Higher Timeframe | 60 minutes | EMA calculation timeframe |
| Fast / Slow EMA Length | 21 / 55 | Trend spread |
| Trend / Momentum Weight | 1.5 / 1.0 | Relative component weights |
| RSI Length | 14 | Momentum lookback |
| Weight by Active Session | Enabled | Apply a session boost |
| Asia / London / New York Session | 0000–0800 / 0800–1600 / 1300–2100 | Windows in the symbol's exchange timezone |
| Session Boost | 0.5 | Directional session contribution |
| Score Smoothing | 5 | EMA length on the normalized score |
| Signal Threshold | 20 | Positive / negative state boundaries |

The named session windows are configurable examples, not automatic conversions
to Asia, London, or New York local time. Changing the chart's displayed timezone
does not change this script's session interpretation. Adjust windows for the
symbol and exchange timezone you actually use.

Keep the threshold above zero for distinct LONG and SHORT regions. At a zero
threshold and zero score, both Boolean conditions are true, while the displayed
bias gives LONG precedence. Allow enough historical bars for the EMAs, RSI,
ATR, and smoothing to initialize.

## Alerts and changing values

The script defines **ChronoForge LONG** and **ChronoForge SHORT** alert conditions.
They become true when the corresponding state is newly entered relative to the
previous chart bar. No TradingView alert is created by installing the source.

If you choose to test an alert, use **Once Per Bar Close** to avoid notifications
from transient chart-bar crossings. This does not finalize a still-open
higher-timeframe candle: its EMA values can continue changing, and historical
results can differ after a reload. `lookahead_off` alone does not make a
higher-timeframe request non-repainting.

Alert delivery, webhook handling, and order execution require their own tests.
The validation record does not establish any of those behaviors.

## Reuse and feedback

You may reuse and modify this repository's source under the [MIT License](LICENSE);
retain the license notice. A public derivative should identify its source commit
and explain its actual changes. If you publish on TradingView, follow that
platform's separate attribution and script-publishing rules.

For a reproducible bug report, include the source commit, symbol, chart timeframe,
requested timeframe, relevant input values, and expected versus observed behavior.
Use [Issues](https://github.com/andrey3969/pinescriptv6/issues) for ordinary bugs.
Report security concerns through [private reporting](SECURITY.md).

## References

- [TradingView: repainting](https://www.tradingview.com/pine-script-docs/concepts/repainting/)
- [TradingView: sessions](https://www.tradingview.com/pine-script-docs/concepts/sessions/)
- [TradingView: script publishing rules](https://www.tradingview.com/support/solutions/43000590599-script-publishing-rules/)
