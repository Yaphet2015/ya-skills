---
name: a-share-data
description: Use when the user needs to fetch Chinese A-share market data, K-lines, financial indicators, cash flow, announcements, or news evidence from public data sources for stock/investment research.
---

# A-share Data Skill

Use this skill when the user asks for A 股数据, Chinese stock quotes, K-line/history, 东方财富 F10 financials, public announcements, news evidence, valuation inputs, or a data pack for later investment analysis.

This skill is **data acquisition only**. It does not issue investment advice by itself. It prepares timestamped, provenance-rich data that other research or portfolio workflows can analyze.

## Core Policy

1. **Real data only.** Never fabricate prices, financials, valuation ratios, charts, holdings, or news. If an endpoint fails or a field is absent, record it as unavailable.
2. **Record provenance.** Keep URL/vendor, fetch timestamp, stock code, market, adjustment mode, date range, and any errors for every source.
3. **Treat vendor fields cautiously.** Public quote fields can be undocumented or change over time. Preserve raw fields when useful and label derived calculations clearly.
4. **Do not blindly quote PE fields as static PE.** For A-shares, vendor PE fields may be TTM, dynamic, negative because of loss-making bases, or otherwise vendor-specific. If prior-year attributable net profit and total market cap are both available, compute a rough static PE yourself as `market_cap / prior_year_parent_net_profit` and label it as an estimate.
5. **Distinguish intraday from close.** Mark intraday quotes with the vendor timestamp. Do not present an intraday quote as a closing price.
6. **Respect data gaps.** A missing or blocked source is a fact to report, not a reason to invent a substitute.

## One-command workflow

After installing the skill with `yk install a-share-data`, run from the installed skill directory:

```sh
python3 scripts/a_share_data.py 301236 --market SZ --output /absolute/path/301236-data.json
```

Common variants:

```sh
# Infer market from code prefix and fetch the default data pack
python3 scripts/a_share_data.py 600519

# Fetch only quote and daily K-line data for a date range
python3 scripts/a_share_data.py 300750 --items quote,kline --start 2025-01-01 --end 2026-06-30

# Fetch financial/announcement evidence only
python3 scripts/a_share_data.py 301236 --items financials,cashflow,announcements --limit 10
```

Default output is JSON printed to stdout. Use `--output` to save the data pack for downstream reports.

## Data sources covered

| Data need | Primary public source | What to capture | Notes |
| --- | --- | --- | --- |
| Real-time quote | Sina `hq.sinajs.cn` | name, open, previous close, current price, high, low, volume, amount, date, time | Requires browser-like headers; usually GB18030. |
| Quote / valuation fields | Tencent `qt.gtimg.cn` | raw quote fields plus selected price/change/turnover/market-cap/PE/PB-style fields when present | Preserve raw fields; field positions are vendor-specific. |
| Daily K-line | Tencent `web.ifzq.gtimg.cn/appstock/app/fqkline/get` | date, open, close, high, low, volume, amount when available | Use `qfq` by default unless a different adjustment is requested. |
| Main financial indicators | Eastmoney F10 datacenter | revenue, parent net profit,扣非净利, margins, ROE, leverage, BPS when present | Query by `SECUCODE="000000.SZ/SH/BJ"`; keep raw records. |
| Cash flow | Eastmoney F10 datacenter | operating cash flow and related fields when present | Useful for checking profit/cash-flow divergence. |
| Announcements | Eastmoney announcement API | recent official announcement titles, dates, URLs/IDs when present | Prefer official announcement evidence over rumor/news. |
| News/search | Eastmoney search or other public search endpoints | headline, time, source, URL when body is unavailable | Treat headlines as weak signals unless the body is fetched and verified. |

## Code and market normalization

Accept any of these forms and normalize internally:

- `301236`, `300750`, `600519`, `430047`
- `sz301236`, `sh600519`, `bj430047`
- `301236.SZ`, `600519.SH`, `430047.BJ`

Market inference default:

- `6` / `9` prefix → Shanghai (`SH`)
- `0` / `2` / `3` prefix → Shenzhen (`SZ`)
- `4` / `8` prefix → Beijing (`BJ`)

If inference is ambiguous or wrong for a specific instrument, pass `--market SH|SZ|BJ` explicitly.

## Recommended data-pack shape

When saving data for a report, keep this shape:

```json
{
  "subject": { "code": "301236", "market": "SZ", "secucode": "301236.SZ" },
  "fetched_at": "2026-06-30T...Z",
  "sources": {
    "sina_quote": { "url": "...", "data": {}, "error": null },
    "tencent_quote": { "url": "...", "data": {}, "error": null },
    "tencent_kline": { "url": "...", "data": [], "error": null },
    "eastmoney_financials": { "url": "...", "data": [], "error": null },
    "eastmoney_cashflow": { "url": "...", "data": [], "error": null },
    "eastmoney_announcements": { "url": "...", "data": [], "error": null }
  },
  "derived": [],
  "limitations": []
}
```

## Derivation rules

Only compute derived fields when inputs are present and units are clear enough:

- Rough static PE: `total_market_cap / prior_year_parent_net_profit`.
- Return / drawdown / moving averages: compute from K-line closes and state adjustment mode (`qfq`, `hfq`, or raw/bfq).
- Turnover/volume interpretation: preserve vendor units; do not silently convert if units are unclear.

Every derived field must include:

- formula
- input fields and source names
- timestamp/as-of date
- limitations

## Verification Checklist

After fetching data:

1. Confirm the command exits with status 0.
2. Confirm each requested source has either non-empty `data` or an explicit `error`.
3. Confirm quotes include a vendor date/time or are labeled as missing/stale.
4. Confirm K-line data range and adjustment mode match the request.
5. Confirm financial records include report dates; do not mix annual and quarterly values without labels.
6. Confirm all unavailable sources are listed in `limitations` or source-level `error` fields.
7. Before using valuation ratios in analysis, check whether the ratio is vendor-supplied or self-computed and label it accordingly.

## Common Pitfalls

- Sina/Tencent endpoints may require `Referer` and `User-Agent`; retry with browser-like headers before declaring unavailable.
- Chinese endpoints often use GBK/GB18030 encoding.
- JSONP endpoints need wrapper stripping before JSON parsing.
- Eastmoney field names differ by report type and can change. Preserve raw records and map only fields you verify.
- Recent news headline search is not the same as verified announcement evidence.
- ETF/fund data uses different endpoint families; do not assume single-stock fields apply unchanged.
