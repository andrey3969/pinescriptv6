# Reusing ChronoForgeMath

## Status

The library source is available for review and reuse under the MIT License.
**The public TradingView library publication is blocked by the account plan.** TradingView displayed a paid-plan requirement when Public was selected on
2026-10-07. The `Andreyt4/ChronoForgeMath/1` import below will work only after
public publication; it is not available yet.
A private QA copy with identical exported function bodies passed 325 native Pine
assertions. It is maintainer-owned validation, not external adoption.

## Purpose

Use these functions when you need a weighted trend/momentum score inside your
own indicator or strategy. Callers choose data sources, timeframes, session
logic, smoothing and alerts. The library adds no data requests, alerts, broker
connections, or order execution. Its chart demo uses local EMA/ATR/RSI values;
it is not the full higher-timeframe ChronoForge indicator.

## API

| Function | Inputs | Result |
| --- | --- | --- |
| `normalizedSpread(fastEma, slowEma, atrValue)` | Precomputed EMA values and ATR in price units | Unclamped EMA spread in ATR units; zero if ATR is not positive |
| `score(spreadInAtr, rsiValue, activeSession, trendWeight=1.5, momentumWeight=1.0, sessionWeight=0.5)` | Spread, RSI, session flag and weights | Unsmooth normalized score; `na` for invalid weights |
| `bias(normalizedScore, threshold=20.0)` | Raw or smoothed score, positive threshold at most 100 | `1` LONG, `-1` SHORT, `0` FLAT; `na` if inputs are unavailable or threshold invalid |

The score clamps trend spread to −1…+1 and RSI's `(RSI - 50) / 50` to the same
range, weights both, adds one directional session boost, divides by configured
weights and multiplies by 100. Weights are rescaled by their largest value before
arithmetic to preserve relative weights without overflowing their sum.

The session weight stays in the denominator when the flag is false. Set
`sessionWeight=0.0` to remove it completely. At exactly zero combined directional
pressure, an active session's boost is positive, matching the indicator.

All three weights must be available and nonnegative. Invalid weights return
`na`; all-zero weights return zero even during data warmup. Missing spread or RSI
otherwise propagates. Normalization returns zero for zero, negative or missing
ATR; missing EMAs propagate when ATR is positive.

The classifier intentionally requires `0 < threshold <= 100`, avoiding the
original indicator's overlapping LONG/SHORT conditions at a zero threshold.
Treat `na` as unavailable data or a configuration problem rather than a trade.

## Consumer example

After the public library is published, this minimal script imports its functions:

```pine
//@version=6
indicator("ChronoForgeMath consumer", overlay=false)
import Andreyt4/ChronoForgeMath/1 as cf

spread = cf.normalizedSpread(ta.ema(close, 21), ta.ema(close, 55), ta.atr(14))
raw = cf.score(spread, ta.rsi(close, 14), false, sessionWeight=0.0)
smoothed = ta.ema(raw, 5)
state = cf.bias(smoothed, 20.0)
plot(smoothed, color=na(state) ? color.gray : state == 1 ? color.teal : state == -1 ? color.red : color.gray)
```

[ChronoForgeMath-example.pine](ChronoForgeMath-example.pine) provides a separate
higher-timeframe consumer. Its `lookahead_off` request can still use a changing
higher-timeframe candle. The library does not make caller-provided data
non-repainting. The example removes session weighting and is not a drop-in
replacement for the original indicator.

Imports explicitly pin a TradingView library version. Inspect a new version's
source and release notes before changing that number.

## Validation and reuse evidence

[The validation record](REUSE_VALIDATION.md) separates native library imports,
contract checks and display checks from trading performance and external use.
After public publication, the [contract harness](ChronoForgeMath-contract-checks.pine)
can be loaded in a separate personal chart to repeat the assertions.

If your independent public project actually uses this library, you may report
that use in a GitHub issue with a permalink to its import and call sites,
publication/repository URL, and purpose. A maintainer can then inspect and record
it in [ADOPTION.md](ADOPTION.md). Maintainer-owned examples and tests are excluded.
There is no reward or benefit for creating artificial dependencies.

Preserve the MIT notice when copying source. For a public TradingView derivative,
follow its separate code-reuse and attribution rules and credit Andreyt4.
Security reports should use [private reporting](SECURITY.md).

## References

- [TradingView: libraries and versioned imports](https://www.tradingview.com/pine-script-docs/concepts/libraries/)
- [TradingView: script publishing rules](https://www.tradingview.com/support/solutions/43000590599-script-publishing-rules/)
