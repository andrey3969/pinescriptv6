# btc-ledger

A forward ledger for Bitcoin up/down rules. Each rule is written down on a date in
[`ledger.json`](ledger.json) and scored only on days after that date, so its record cannot have
been fitted to the days it is judged on.

## The rule

**fade-yesterday** (written down 2026-09-28): call each day the opposite of the day before. After
an up day call down; after a down day call up.

- A day's close is the BTC-USD price at 00:00 UTC at the end of that day. A day is up when its
  close is above the previous day's close and down when it is below; flat days are not scored.
- The first scored day is 2026-09-29. Its call comes from the 2026-09-28 close (00:00 UTC on
  Sept 29) and it settles at 00:00 UTC on Sept 30.
- Before it was written down it won 49.5% of days in 2011-2018 (1,439 of 2,909) and 53.0% in
  2019-2026 (1,431 of 2,700). It was picked because of the second number, so only the forward
  record counts.

## Commands

```sh
node btc.js update    # append new daily closes (Coinbase BTC-USD, else Kraken XBT/USD)
node btc.js           # forward record of every rule, with a coin-flip p-value
node btc.js today     # the next call of every rule
node btc.js history   # how each rule did before it was written down
npm test              # unit tests
```

Zero dependencies; Node 18+. `update` needs internet access to `api.exchange.coinbase.com` or
`api.kraken.com`. It adds only complete UTC days, and the `source` column records where each close
came from.

## Judging it

- On Kalshi, buying a 50-cent contract with the standard fee (about 1.75 cents per contract at
  50 cents; check the current fee schedule) needs a 51.75% win rate just to break even.
- If the true rate were 53%, it would take about 1,716 days (4.7 years) to show it beats a coin
  flip, and about 9,900 days (27 years) to show it beats 51.75% (80% power, one-sided 5% test).
- Kalshi's own daily up/down markets may settle at another time of day and on another price index
  than these 00:00 UTC closes, so a record on this definition does not automatically carry over.

## Adding a rule

Append an entry to `ledger.json` with today's date as `registered`, and never edit a rule after its
date. A `"type": "lag"` rule calls day D from the direction of day D - `lag`: the same direction,
or the opposite with `"reverse": true`.

## Data

`data/btc-daily.csv` holds daily closes from 2010-07-18 to 2026-05-23: the `PriceUSD` column of
Coin Metrics' community data ([coinmetrics/data](https://github.com/coinmetrics/data)), by
Coin Metrics, Inc., licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)
(non-commercial use, with attribution). Only that column was kept and reformatted. Later closes
come from the exchange named in the `source` column.
