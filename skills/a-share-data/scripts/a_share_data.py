#!/usr/bin/env python3
"""Fetch a timestamped Chinese A-share data pack from public endpoints.

The script intentionally keeps raw vendor fields where schemas are undocumented.
It uses only the Python standard library so the skill remains easy to install.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    "Accept": "*/*",
}

MARKET_PREFIX = {
    "SH": "sh",
    "SZ": "sz",
    "BJ": "bj",
}

SINA_FIELDS = [
    "name",
    "open",
    "previous_close",
    "current_price",
    "high",
    "low",
    "buy_price",
    "sell_price",
    "volume_shares",
    "amount_yuan",
    "bid1_volume",
    "bid1_price",
    "bid2_volume",
    "bid2_price",
    "bid3_volume",
    "bid3_price",
    "bid4_volume",
    "bid4_price",
    "bid5_volume",
    "bid5_price",
    "ask1_volume",
    "ask1_price",
    "ask2_volume",
    "ask2_price",
    "ask3_volume",
    "ask3_price",
    "ask4_volume",
    "ask4_price",
    "ask5_volume",
    "ask5_price",
    "date",
    "time",
    "status",
]

TENCENT_SELECTED_FIELDS = {
    1: "name",
    2: "code",
    3: "current_price",
    4: "previous_close",
    5: "open",
    30: "quote_datetime",
    31: "change_amount_vendor",
    32: "change_percent_vendor",
    37: "turnover_rate_vendor",
    38: "pe_vendor",
    39: "pb_vendor",
    44: "total_market_cap_vendor",
    45: "circulating_market_cap_vendor",
    46: "limit_up_vendor",
    47: "limit_down_vendor",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch a public A-share data pack as JSON")
    parser.add_argument("code", help="Stock code: 301236, sz301236, or 301236.SZ")
    parser.add_argument("--market", choices=["SH", "SZ", "BJ", "sh", "sz", "bj"], help="Override market")
    parser.add_argument(
        "--items",
        default="quote,kline,financials,cashflow,announcements",
        help="Comma-separated: quote,kline,financials,cashflow,announcements",
    )
    parser.add_argument("--start", help="K-line start date YYYY-MM-DD; default about one year ago")
    parser.add_argument("--end", help="K-line end date YYYY-MM-DD; default today")
    parser.add_argument("--adjust", default="qfq", choices=["qfq", "hfq", "bfq"], help="K-line adjustment mode")
    parser.add_argument("--limit", type=int, default=5, help="Financial/announcement records to request")
    parser.add_argument("--output", help="Write JSON to this file path")
    return parser.parse_args()


def infer_market(code: str) -> str:
    first = code[0]
    if first in {"6", "9"}:
        return "SH"
    if first in {"0", "2", "3"}:
        return "SZ"
    if first in {"4", "8"}:
        return "BJ"
    raise ValueError(f"Cannot infer market from code '{code}'; pass --market SH|SZ|BJ")


def normalize_symbol(raw: str, market: str | None = None) -> dict[str, str]:
    value = raw.strip()
    upper = value.upper()

    match = re.fullmatch(r"(\d{6})\.(SH|SZ|BJ)", upper)
    if match:
        code, inferred_market = match.groups()
        market = market.upper() if market else inferred_market
    else:
        match = re.fullmatch(r"(SH|SZ|BJ)(\d{6})", upper)
        if match:
            inferred_market, code = match.groups()
            market = market.upper() if market else inferred_market
        else:
            digits = re.sub(r"\D", "", value)
            if not re.fullmatch(r"\d{6}", digits):
                raise ValueError(f"Stock code must contain exactly six digits: {raw}")
            code = digits
            market = market.upper() if market else infer_market(code)

    if market not in MARKET_PREFIX:
        raise ValueError(f"Unsupported market: {market}")

    prefix = MARKET_PREFIX[market]
    return {
        "code": code,
        "market": market,
        "vendor_symbol": f"{prefix}{code}",
        "secucode": f"{code}.{market}",
    }


def request_text(url: str, *, encoding: str = "utf-8", headers: dict[str, str] | None = None, timeout: int = 20) -> str:
    merged_headers = {**DEFAULT_HEADERS, **(headers or {})}
    req = Request(url, headers=merged_headers)
    with urlopen(req, timeout=timeout) as response:  # nosec: public user-requested URLs only
        body = response.read()
        charset = response.headers.get_content_charset() or encoding
        return body.decode(charset, errors="replace")


def source_result(url: str, fetcher: Callable[[], Any]) -> dict[str, Any]:
    try:
        return {"url": url, "data": fetcher(), "error": None}
    except Exception as exc:  # noqa: BLE001 - source-level failures should be recorded, not fatal
        return {"url": url, "data": None, "error": f"{type(exc).__name__}: {exc}"}


def maybe_number(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    value = value.strip()
    if value == "":
        return value
    try:
        if re.fullmatch(r"[-+]?\d+", value):
            return int(value)
        return float(value)
    except ValueError:
        return value


def strip_jsonp(text: str) -> Any:
    text = text.strip()
    if not text:
        raise ValueError("empty response")
    starts = [idx for idx in (text.find("{"), text.find("[")) if idx != -1]
    if not starts:
        raise ValueError("cannot find JSON payload in response")
    start = min(starts)
    end = max(text.rfind("}"), text.rfind("]"))
    if end < start:
        raise ValueError("cannot find JSON payload end in response")
    return json.loads(text[start : end + 1])


def fetch_sina_quote(symbol: dict[str, str]) -> tuple[str, Callable[[], dict[str, Any]]]:
    url = f"https://hq.sinajs.cn/list={symbol['vendor_symbol']}"

    def fetch() -> dict[str, Any]:
        text = request_text(
            url,
            encoding="gb18030",
            headers={"Referer": "https://finance.sina.com.cn/"},
        )
        if "=\"" not in text:
            raise ValueError(f"unexpected Sina response: {text[:120]}")
        payload = text.split('="', 1)[1].rsplit('"', 1)[0]
        if not payload:
            raise ValueError("Sina returned an empty quote payload")
        parts = payload.split(",")
        mapped = {field: maybe_number(parts[idx]) for idx, field in enumerate(SINA_FIELDS) if idx < len(parts)}
        mapped["raw_fields"] = parts
        return mapped

    return url, fetch


def fetch_tencent_quote(symbol: dict[str, str]) -> tuple[str, Callable[[], dict[str, Any]]]:
    url = f"https://qt.gtimg.cn/q={symbol['vendor_symbol']}"

    def fetch() -> dict[str, Any]:
        text = request_text(url, encoding="gbk", headers={"Referer": "https://gu.qq.com/"})
        match = re.search(r'="(.*)";?\s*$', text.strip())
        if not match:
            raise ValueError(f"unexpected Tencent response: {text[:120]}")
        parts = match.group(1).split("~")
        if len(parts) < 4:
            raise ValueError("Tencent returned too few quote fields")
        selected = {
            name: maybe_number(parts[index])
            for index, name in TENCENT_SELECTED_FIELDS.items()
            if index < len(parts) and parts[index] != ""
        }
        return {
            "selected_fields": selected,
            "raw_fields": parts,
            "note": "Tencent quote field positions are vendor-specific; verify before using PE/market-cap fields as final facts.",
        }

    return url, fetch


def fetch_tencent_kline(symbol: dict[str, str], start: str, end: str, adjust: str) -> tuple[str, Callable[[], list[dict[str, Any]]]]:
    fq = "" if adjust == "bfq" else adjust
    param = f"{symbol['vendor_symbol']},day,{start},{end},640,{fq}"
    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?" + urlencode({"param": param})

    def fetch() -> list[dict[str, Any]]:
        payload = strip_jsonp(request_text(url, headers={"Referer": "https://gu.qq.com/"}))
        stock = payload.get("data", {}).get(symbol["vendor_symbol"], {})
        rows = stock.get(f"{adjust}day") or stock.get("day") or []
        result = []
        for row in rows:
            result.append(
                {
                    "date": row[0] if len(row) > 0 else None,
                    "open": maybe_number(row[1]) if len(row) > 1 else None,
                    "close": maybe_number(row[2]) if len(row) > 2 else None,
                    "high": maybe_number(row[3]) if len(row) > 3 else None,
                    "low": maybe_number(row[4]) if len(row) > 4 else None,
                    "volume": maybe_number(row[5]) if len(row) > 5 else None,
                    "amount": maybe_number(row[6]) if len(row) > 6 else None,
                    "raw": row,
                }
            )
        return result

    return url, fetch


def eastmoney_datacenter_url(report_type: str, style: str, secucode: str, limit: int) -> str:
    params = {
        "type": report_type,
        "sty": style,
        "filter": f'(SECUCODE="{secucode}")',
        "sortColumns": "REPORT_DATE",
        "sortTypes": "-1",
        "pageSize": str(limit),
        "pageNumber": "1",
        "source": "HSF10",
        "client": "PC",
    }
    return "https://datacenter.eastmoney.com/securities/api/data/get?" + urlencode(params)


def fetch_eastmoney_records(url: str) -> list[dict[str, Any]]:
    payload = strip_jsonp(request_text(url, headers={"Referer": "https://emweb.securities.eastmoney.com/"}))
    result = payload.get("result") or {}
    data = result.get("data") or []
    if not isinstance(data, list):
        raise ValueError("Eastmoney response result.data is not a list")
    return data


def fetch_announcements(symbol: dict[str, str], limit: int) -> tuple[str, Callable[[], list[dict[str, Any]]]]:
    params = {
        "sr": "-1",
        "page_size": str(limit),
        "page_index": "1",
        "ann_type": "A",
        "client_source": "web",
        "stock_list": symbol["code"],
        "f_node": "0",
        "s_node": "0",
    }
    url = "https://np-anotice-stock.eastmoney.com/api/security/ann?" + urlencode(params)

    def fetch() -> list[dict[str, Any]]:
        payload = strip_jsonp(request_text(url, headers={"Referer": "https://data.eastmoney.com/"}))
        data = payload.get("data") or {}
        rows = data.get("list") or []
        if not isinstance(rows, list):
            raise ValueError("Eastmoney announcement response data.list is not a list")
        normalized = []
        for item in rows:
            if not isinstance(item, dict):
                continue
            normalized.append(
                {
                    "title": item.get("title") or item.get("notice_title"),
                    "date": item.get("notice_date") or item.get("art_code"),
                    "art_code": item.get("art_code"),
                    "columns": item.get("columns"),
                    "codes": item.get("codes"),
                    "raw": item,
                }
            )
        return normalized

    return url, fetch


def build_pack(args: argparse.Namespace) -> dict[str, Any]:
    today = date.today()
    end = args.end or today.isoformat()
    start = args.start or (today - timedelta(days=370)).isoformat()
    items = {item.strip().lower() for item in args.items.split(",") if item.strip()}
    symbol = normalize_symbol(args.code, args.market)

    pack: dict[str, Any] = {
        "subject": symbol,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "request": {
            "items": sorted(items),
            "start": start,
            "end": end,
            "adjust": args.adjust,
            "limit": args.limit,
        },
        "sources": {},
        "derived": [],
        "limitations": [],
    }

    if "quote" in items:
        url, fetcher = fetch_sina_quote(symbol)
        pack["sources"]["sina_quote"] = source_result(url, fetcher)
        url, fetcher = fetch_tencent_quote(symbol)
        pack["sources"]["tencent_quote"] = source_result(url, fetcher)

    if "kline" in items:
        url, fetcher = fetch_tencent_kline(symbol, start, end, args.adjust)
        pack["sources"]["tencent_kline"] = source_result(url, fetcher)

    if "financials" in items:
        url = eastmoney_datacenter_url(
            "RPT_F10_FINANCE_MAINFINADATA",
            "APP_F10_MAINFINADATA",
            symbol["secucode"],
            args.limit,
        )
        pack["sources"]["eastmoney_financials"] = source_result(url, lambda: fetch_eastmoney_records(url))

    if "cashflow" in items:
        url = eastmoney_datacenter_url(
            "RPT_F10_FINANCE_GCASHFLOW",
            "APP_F10_GCASHFLOW",
            symbol["secucode"],
            args.limit,
        )
        pack["sources"]["eastmoney_cashflow"] = source_result(url, lambda: fetch_eastmoney_records(url))

    if "announcements" in items:
        url, fetcher = fetch_announcements(symbol, args.limit)
        pack["sources"]["eastmoney_announcements"] = source_result(url, fetcher)

    for source_name, result in pack["sources"].items():
        if result.get("error"):
            pack["limitations"].append(f"{source_name} unavailable: {result['error']}")
        elif result.get("data") in (None, [], {}):
            pack["limitations"].append(f"{source_name} returned no data")

    return pack


def main() -> int:
    args = parse_args()
    try:
        pack = build_pack(args)
    except Exception as exc:  # noqa: BLE001 - CLI should report a clear top-level error
        print(f"a_share_data.py: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    text = json.dumps(pack, ensure_ascii=False, indent=2)
    if args.output:
        output_path = Path(args.output).expanduser()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
