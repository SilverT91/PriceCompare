#!/usr/bin/env python3
"""Probe how well product prices can be read from shops with a plain HTTP client.

For every shop in data/shops.yaml and every test product whose categories fit the shop, the probe:
  1. reads robots.txt and checks the search URL and the product URL for a generic user agent,
  2. fetches the shop's search results page,
  3. classifies the response (bot wall, JavaScript shell, no results, usable),
  4. looks for structured data / embedded JSON state on the search page,
  5. follows the first plausible product link and extracts schema.org Product data with extruct,
  6. writes everything to data/probe_results.json and prints a summary table.

Politeness rules (hard-coded, see constants below):
  * at most one request every 3 s per host, at most 10 HTTP requests per shop (robots.txt included),
  * timeouts, no retries on any error (403/429 included),
  * honest generic User-Agent without any personal data,
  * no proxies, no header spoofing, no headless browser; a shop that blocks us is recorded as
    "blocked" and left alone (after the first block we stop sending that shop more requests),
  * a URL disallowed by robots.txt is never fetched (recorded as "disallowed_by_robots").

Fetched pages are cached under .cache/probe/ (git-ignored) so the analysis can be redone offline.

Usage:
  python tools/probe_shops.py                      # whole database (in-scope shops)
  python tools/probe_shops.py --only nay_sk,jysk_sk
  python tools/probe_shops.py --products oralb     # one product only (extra pass), merges into results
  python tools/probe_shops.py --resume             # skip (shop, product) pairs already in the results
  python tools/probe_shops.py --summary-only       # just print the table from the results file
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, quote_plus, unquote, urljoin, urlsplit

import extruct
import requests
import yaml
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
SHOPS_FILE = ROOT / "data" / "shops.yaml"
OUT_FILE = ROOT / "data" / "probe_results.json"
CACHE_DIR = ROOT / ".cache" / "probe"

USER_AGENT = "price-compare-probe/0.1"
ROBOTS_TOKEN = "price-compare-probe"
MIN_INTERVAL_S = 3.0          # per host
MAX_REQUESTS_PER_SHOP = 10    # includes robots.txt and redirect hops
TIMEOUT = (10, 20)            # connect, read
MAX_BYTES = 4_000_000
MAX_REDIRECTS = 3
WORKERS = 6                   # parallel shops; each host is still limited to one request per 3 s

# Test products. "categories" must intersect the shop's categories for the product to be tested.
# (Milka Alpine Milk 100 g was dropped: groceries are out of scope.)
PRODUCTS = [
    {"id": "iphone16", "query": "iPhone 16 128GB", "categories": {"electronics", "general"}},
    {"id": "bosch_gsr", "query": "Bosch GSR 12V-15", "categories": {"tools", "diy_garden", "general"}},
    {"id": "nivea", "query": "Nivea Creme 150 ml", "categories": {"drugstore", "pharmacy", "beauty", "general"}},
    {"id": "oralb", "query": "Oral-B Pro 3 3000", "fallback_query": "Oral-B Pro 3",
     "categories": {"drugstore", "pharmacy", "beauty", "electronics", "appliances", "general"}},
    # Extras (not in the original brief): without them furniture shops and bookshops would get no test at all.
    {"id": "extra_book", "query": "Hobit Tolkien", "categories": {"books"}, "extra": True},
    {"id": "extra_desk", "query": "písací stôl 120 cm", "categories": {"furniture"}, "extra": True},
]

# ----------------------------------------------------------------------------------------------
# polite HTTP
# ----------------------------------------------------------------------------------------------


class HostLimiter:
    """One request at a time per host, at least MIN_INTERVAL_S between request starts."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[str, threading.Lock] = {}
        self._last: dict[str, float] = {}

    def lock_for(self, host: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(host, threading.Lock())

    def wait(self, host: str) -> None:
        gap = time.monotonic() - self._last.get(host, 0.0)
        if gap < MIN_INTERVAL_S:
            time.sleep(MIN_INTERVAL_S - gap)
        self._last[host] = time.monotonic()


LIMITER = HostLimiter()


class BudgetExceeded(Exception):
    pass


def registered_domain(host: str) -> str:
    parts = host.lower().split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host.lower()


def decode_body(content: bytes, content_type: str) -> str:
    m = re.search(r"charset=([\w-]+)", content_type or "", re.I)
    enc = m.group(1) if m else None
    if not enc:
        m2 = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", content[:4096], re.I)
        enc = m2.group(1).decode("ascii", "ignore") if m2 else "utf-8"
    try:
        return content.decode(enc, errors="replace")
    except LookupError:
        return content.decode("utf-8", errors="replace")


class Fetcher:
    """Fetches URLs for one shop, enforcing the request budget and per-host spacing."""

    def __init__(self, shop_id: str, domain: str, accept_language: str | None = None) -> None:
        self.shop_id = shop_id
        self.base_domain = registered_domain(domain)
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
            "Accept-Language": accept_language or "sk,cs;q=0.8,en;q=0.6",
        })
        self.used = 0
        self.log: list[dict] = []

    def remaining(self) -> int:
        return MAX_REQUESTS_PER_SHOP - self.used

    def get(self, url: str, kind: str) -> dict:
        """GET with manual same-domain redirects. Never retries. Returns a dict (never raises on HTTP errors)."""
        hops = 0
        current = url
        while True:
            if self.used >= MAX_REQUESTS_PER_SHOP:
                raise BudgetExceeded()
            host = urlsplit(current).netloc.lower()
            self.used += 1
            entry = {"kind": kind, "url": current, "hop": hops}
            lock = LIMITER.lock_for(host)
            t0 = time.monotonic()
            try:
                with lock:
                    LIMITER.wait(host)
                    resp = self.session.get(current, timeout=TIMEOUT, allow_redirects=False, stream=True)
                    chunks, size = [], 0
                    for chunk in resp.iter_content(65536):
                        chunks.append(chunk)
                        size += len(chunk)
                        if size > MAX_BYTES:
                            break
                    resp.close()
            except requests.RequestException as exc:
                entry.update(status=None, error=f"{type(exc).__name__}: {str(exc)[:160]}",
                             ms=int((time.monotonic() - t0) * 1000))
                self.log.append(entry)
                return {"ok": False, "error": entry["error"], "url": current, "status": None}
            content = b"".join(chunks)
            entry.update(status=resp.status_code, bytes=len(content), ms=int((time.monotonic() - t0) * 1000))
            self.log.append(entry)
            if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("Location"):
                nxt = urljoin(current, resp.headers["Location"])
                nxt_host = urlsplit(nxt).netloc.lower()
                if registered_domain(nxt_host.split(":")[0]) != self.base_domain:
                    return {"ok": False, "status": resp.status_code, "url": current, "redirect_offsite": nxt,
                            "headers": dict(resp.headers), "text": "", "final_url": current}
                hops += 1
                if hops > MAX_REDIRECTS:
                    return {"ok": False, "error": "too_many_redirects", "url": current, "status": resp.status_code}
                current = nxt
                continue
            text = decode_body(content, resp.headers.get("Content-Type", ""))
            return {"ok": True, "status": resp.status_code, "url": url, "final_url": current,
                    "headers": dict(resp.headers), "text": text, "bytes": len(content),
                    "cache_file": cache_page(self.shop_id, current, text)}


def cache_page(shop_id: str, url: str, text: str) -> str:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{shop_id}-{hashlib.sha1(url.encode()).hexdigest()[:10]}.html"
    (CACHE_DIR / name).write_text(text, encoding="utf-8", errors="replace")
    return f".cache/probe/{name}"


# ----------------------------------------------------------------------------------------------
# robots.txt (RFC 9309 semantics: longest match wins, allow wins ties, * and $ supported)
# ----------------------------------------------------------------------------------------------


class Robots:
    def __init__(self, text: str | None, status: int | None, error: str | None = None) -> None:
        self.status = status
        self.error = error
        self.rules: list[tuple[bool, str]] = []
        self.mode = "rules"
        if status is None:
            self.mode = "disallow_all_unreachable"   # be conservative when robots.txt cannot be fetched
        elif 500 <= status < 600:
            self.mode = "disallow_all_unreachable"   # RFC 9309: server error => assume complete disallow
        elif status >= 400:
            self.mode = "allow_all"                  # RFC 9309: 4xx => no robots.txt, everything allowed
        else:
            self._parse(text or "")

    def _parse(self, text: str) -> None:
        groups: list[tuple[list[str], list[tuple[bool, str]]]] = []
        agents: list[str] = []
        rules: list[tuple[bool, str]] = []
        in_rules = False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, value = (p.strip() for p in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                if in_rules:
                    groups.append((agents, rules))
                    agents, rules, in_rules = [], [], False
                agents.append(value.lower())
            elif key in ("allow", "disallow"):
                in_rules = True
                if value:  # empty Disallow means allow everything: no rule needed
                    rules.append((key == "allow", value))
        if agents:
            groups.append((agents, rules))
        specific = [g for g in groups if any(a == ROBOTS_TOKEN for a in g[0])]
        chosen = specific or [g for g in groups if "*" in g[0]]
        for _, r in chosen:
            self.rules.extend(r)

    @staticmethod
    def _match_len(pattern: str, path: str) -> int:
        anchored = pattern.endswith("$")
        if anchored:
            pattern = pattern[:-1]
        regex = "".join(".*" if c == "*" else re.escape(c) for c in pattern)
        regex = "^" + regex + ("$" if anchored else "")
        return len(pattern) if re.match(regex, path) else -1

    def allowed(self, url: str) -> bool:
        if self.mode == "allow_all":
            return True
        if self.mode == "disallow_all_unreachable":
            return False
        parts = urlsplit(url)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        best_len, best_allow = -1, True
        for allow, pattern in self.rules:
            n = self._match_len(pattern, path)
            if n > best_len or (n == best_len and allow and not best_allow):
                best_len, best_allow = n, allow
        return best_allow


# ----------------------------------------------------------------------------------------------
# text helpers
# ----------------------------------------------------------------------------------------------

UNIT_RE = re.compile(r"(\d+)\s*(gb|tb|ml|kg|mm|cm|mah|ks|v|w|g|l)\b", re.I)
STOP = {"the", "a", "and", "s", "of", "na", "pre", "pro_"}


def fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


def norm_text(text: str) -> str:
    t = fold(text).replace("-", "")
    t = UNIT_RE.sub(lambda m: m.group(1) + m.group(2).lower(), t)
    return t


def tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", norm_text(text)) if t not in STOP]


def token_in(tok: str, name_tokens: set[str], name_joined: str) -> bool:
    return tok in name_tokens or (len(tok) >= 4 and tok in name_joined)


def match_info(query: str, name: str) -> dict:
    q = tokens(query)
    n = tokens(name)
    nset, njoin = set(n), "".join(n)
    missing = [t for t in q if not token_in(t, nset, njoin)]
    extra = [t for t in n if t not in set(q) and t in {"pro", "plus", "max", "mini", "se", "ultra", "lite", "air", "case", "kryt", "puzdro", "pouzdro", "folie", "sklo", "hulle"}]
    if not missing:
        level = "exact" if not extra else "exact_tokens_plus_variant_words"
    elif len(missing) <= max(1, len(q) // 4) and not any(t.isdigit() for t in missing):
        level = "partial"
    else:
        level = "none"
    return {"match": level, "missing_tokens": missing, "variant_words": extra}


# ----------------------------------------------------------------------------------------------
# bot wall / JS shell / no results detection
# ----------------------------------------------------------------------------------------------

STRONG_BOT_MARKERS = [
    ("cloudflare", r"just a moment\.\.\.|cf-chl|challenge-platform|_cf_chl|cf-browser-verification|attention required! \| cloudflare"),
    ("datadome", r"captcha-delivery\.com|datadome|geo\.captcha-delivery"),
    ("akamai", r"errors\.edgesuite\.net|reference&#32;&#35;|akamai(?:ghost)?|ak_bmsc"),
    ("perimeterx", r"perimeterx|px-captcha|_pxhd|human verification"),
    ("imperva", r"incapsula|_incap_|imperva"),
    ("cloudfront", r"the request could not be satisfied|generated by cloudfront"),
    ("generic_challenge", r"vyžaduje sa overenie|bot detected|access denied|pardon our interruption|are you a robot|verify you are human|ověřte, že jste člověk|sicherheitsabfrage|robot check|bitte bestätigen sie"),
]
WEAK_BOT_MARKERS = [("captcha", r"captcha|recaptcha|hcaptcha")]


def detect_bot_wall(status: int | None, headers: dict, text: str) -> dict:
    low = (text or "")[:200_000].lower()
    hdr = {k.lower(): str(v).lower() for k, v in (headers or {}).items()}
    vendor = None
    if hdr.get("cf-mitigated") == "challenge":
        vendor = "cloudflare"
    if not vendor and ("x-datadome" in hdr or "datadome" in hdr.get("set-cookie", "")):
        vendor = "datadome"
    small = len(text or "") < 60_000
    if not vendor:
        for name, pat in STRONG_BOT_MARKERS:
            if re.search(pat, low) and (small or name in ("cloudflare", "datadome")):
                vendor = name
                break
    if not vendor and small:
        # weak markers only count in visible text: a page that merely loads a reCAPTCHA script is not a wall
        visible = re.sub(r"<script.*?</script>|<style.*?</style>|<[^>]+>", " ", low, flags=re.S)
        for name, pat in WEAK_BOT_MARKERS:
            if re.search(pat, visible):
                vendor = name
                break
    blocked_status = status in (401, 403, 429, 503)
    detected = bool(vendor) and (blocked_status or small)
    if blocked_status and not vendor:
        vendor = "http_" + str(status)
        detected = True
        if hdr.get("server", "").startswith("cloudflare"):
            vendor = "cloudflare"
    return {"detected": detected, "vendor": vendor if detected else None}


NO_RESULTS_RE = re.compile(
    r"nena[sš]li sme|nenalezeno|nic jsme nena|žiadne výsledky|žádné výsledky|0 výsledk|nebol nájden|nebyl nalezen|"
    r"keine ergebnisse|keine treffer|nichts gefunden|no results|brak wyników|nie znaleziono|nic nie znaleziono|"
    r"vášmu hľadaniu nezodpovedá|neodpovedá žiadn|no products found|did not match any", re.I)
CURRENCY_RE = re.compile(r"\d[\d\s .,]*\s?(?:€|eur\b|kč|czk\b|zł|pln\b)|(?:€|eur)\s?\d", re.I)


def visible_text(soup: BeautifulSoup) -> str:
    for t in soup(["script", "style", "noscript", "template"]):
        t.decompose()
    return re.sub(r"\s+", " ", soup.get_text(" ")).strip()


# ----------------------------------------------------------------------------------------------
# structured data
# ----------------------------------------------------------------------------------------------

PRODUCT_TYPES = {"Product", "ProductGroup", "IndividualProduct", "ProductModel", "SomeProducts", "Vehicle"}
GTIN_KEYS = ["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "gtin_", "ean", "ean13", "isbn", "upc"]


def type_names(node: dict) -> list[str]:
    t = node.get("@type")
    if t is None:
        return []
    ts = t if isinstance(t, list) else [t]
    return [str(x).rsplit("/", 1)[-1].rsplit("#", 1)[-1] for x in ts]


def iter_nodes(obj, depth=0):
    if depth > 12:
        return
    if isinstance(obj, list):
        for x in obj:
            yield from iter_nodes(x, depth + 1)
    elif isinstance(obj, dict):
        yield obj
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and k not in ("@context",):
                yield from iter_nodes(v, depth + 1)


def extract_structured(html: str, url: str) -> dict:
    """Run extruct and return {'json-ld': [...], 'microdata': [...], 'opengraph': [...], 'error': str|None}."""
    try:
        data = extruct.extract(html, base_url=url, syntaxes=["json-ld", "microdata", "opengraph"],
                               uniform=True, errors="ignore")
        data["error"] = None
        return data
    except Exception as exc:  # extruct can choke on huge/odd documents
        return {"json-ld": [], "microdata": [], "opengraph": [], "error": f"{type(exc).__name__}: {str(exc)[:120]}"}


def parse_price(value) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(" ", "").replace(" ", "")
    s = re.sub(r"[^\d,.\-]", "", s)
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def first_str(v):
    if isinstance(v, list):
        for x in v:
            r = first_str(x)
            if r:
                return r
        return None
    if isinstance(v, dict):
        return first_str(v.get("name") or v.get("@value") or v.get("value"))
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def offers_of(node: dict) -> list[dict]:
    raw = node.get("offers")
    out: list[dict] = []
    for o in (raw if isinstance(raw, list) else [raw] if raw else []):
        if not isinstance(o, dict):
            continue
        out.append(o)
        sub = o.get("offers")
        for s in (sub if isinstance(sub, list) else [sub] if sub else []):
            if isinstance(s, dict):
                out.append(s)
    return out


def summarize_shipping(sd) -> dict | None:
    items = sd if isinstance(sd, list) else [sd]
    for it in items:
        if not isinstance(it, dict):
            continue
        rate = it.get("shippingRate") or {}
        dest = it.get("shippingDestination") or {}
        dest = dest[0] if isinstance(dest, list) and dest else dest
        return {"rate": first_str(rate.get("value")) if isinstance(rate, dict) else first_str(rate),
                "currency": rate.get("currency") if isinstance(rate, dict) else None,
                "destination": first_str(dest.get("addressCountry")) if isinstance(dest, dict) else None,
                "delivery_time": bool(it.get("deliveryTime"))}
    return None


def summarize_product(node: dict, source: str) -> dict:
    offers = offers_of(node)
    variants = node.get("hasVariant")
    var_list = variants if isinstance(variants, list) else [variants] if variants else []
    if not offers and var_list and isinstance(var_list[0], dict):
        offers = offers_of(var_list[0])
    prices, price_raw, currency, availability, shipping, ret = [], None, None, None, None, False
    gtin = gtin_key = None
    for k in GTIN_KEYS:
        if node.get(k):
            gtin, gtin_key = first_str(node[k]), k
            break
    for o in offers:
        spec = o.get("priceSpecification")
        spec = spec[0] if isinstance(spec, list) and spec else spec
        raw = o.get("price")
        if raw in (None, "") and isinstance(spec, dict):
            raw = spec.get("price")
        if raw in (None, ""):
            raw = o.get("lowPrice")
        p = parse_price(raw)
        if p is not None:
            prices.append(p)
            price_raw = price_raw if price_raw is not None else raw
        currency = currency or o.get("priceCurrency") or (spec.get("priceCurrency") if isinstance(spec, dict) else None)
        if not availability and o.get("availability"):
            availability = str(first_str(o["availability"])).rsplit("/", 1)[-1]
        if not shipping and o.get("shippingDetails"):
            shipping = summarize_shipping(o["shippingDetails"])
        ret = ret or bool(o.get("hasMerchantReturnPolicy"))
        if not gtin:
            for k in GTIN_KEYS:
                if o.get(k):
                    gtin, gtin_key = first_str(o[k]), k + "(on offer)"
                    break
    if not shipping and node.get("shippingDetails"):
        shipping = summarize_shipping(node["shippingDetails"])
    ret = ret or bool(node.get("hasMerchantReturnPolicy"))
    return {
        "source": source,
        "types": type_names(node),
        "name": first_str(node.get("name")),
        "price": prices[0] if prices else None,
        "price_raw": str(price_raw) if price_raw is not None else None,
        "currency": first_str(currency),
        "availability": availability,
        "gtin": gtin, "gtin_key": gtin_key,
        "brand": first_str(node.get("brand")),
        "sku": first_str(node.get("sku")), "mpn": first_str(node.get("mpn")),
        "url": first_str(node.get("url")),
        "n_offers": len(offers), "n_variants": len(var_list),
        "price_min": min(prices) if prices else None, "price_max": max(prices) if prices else None,
        "shipping_details": shipping, "has_return_policy": ret,
        "available_at_or_from": bool(any(o.get("availableAtOrFrom") for o in offers)),
    }


def find_products(structured: dict) -> list[dict]:
    found = []
    for source in ("json-ld", "microdata"):
        for node in iter_nodes(structured.get(source) or []):
            if set(type_names(node)) & PRODUCT_TYPES:
                found.append(summarize_product(node, source))
    return found


def search_page_structured(structured: dict) -> dict:
    n_lists = n_items = 0
    item_urls: list[str] = []
    for source in ("json-ld", "microdata"):
        for node in iter_nodes(structured.get(source) or []):
            tn = type_names(node)
            if "ItemList" in tn:
                n_lists += 1
                els = node.get("itemListElement") or []
                els = els if isinstance(els, list) else [els]
                n_items += len(els)
                for e in els:
                    if isinstance(e, dict):
                        item = e.get("item") if isinstance(e.get("item"), dict) else e
                        u = item.get("url") or item.get("@id") or e.get("url")
                        if isinstance(u, str):
                            item_urls.append(u)
    prods = find_products(structured)
    return {
        "item_lists": n_lists, "item_list_items": n_items,
        "products": len(prods), "products_with_price": sum(1 for p in prods if p["price"] is not None),
        "sources": sorted({p["source"] for p in prods}),
        "product_list": [{k: p.get(k) for k in ("name", "url", "price", "currency", "gtin", "availability")}
                         for p in prods[:12]],
        "item_urls": item_urls[:12],
        "extruct_error": structured.get("error"),
    }


STATE_VARS = ["__NEXT_DATA__", "__NUXT__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__",
              "__REDUX_STATE__", "__INITIAL_DATA__", "dataLayer", "window.__", "ssrState", "__STATE__"]


def embedded_state(html: str) -> dict:
    """Detect JSON state blobs in <script> tags that contain price-like fields."""
    out = {"found": False, "blobs": []}
    for m in re.finditer(r"<script([^>]*)>(.*?)</script>", html, re.S | re.I):
        attrs, body = m.group(1), m.group(2)
        if len(body) < 200 or "ld+json" in attrs.lower():
            continue
        n_price = len(re.findall(r'"(?:price|priceWithVat|finalPrice|unitPrice|sellingPrice|currentPrice|salePrice|priceAmount|amount)"\s*:\s*"?\d', body))
        if n_price == 0:
            continue
        kind = None
        idm = re.search(r'id="([^"]+)"', attrs)
        if idm and idm.group(1).startswith("__"):
            kind = idm.group(1)
        if not kind:
            for v in STATE_VARS:
                if v in body[:3000]:
                    kind = v
                    break
        if not kind and "application/json" in attrs.lower():
            kind = "application/json"
        if not kind:
            kind = "inline_script"
        key = re.search(r'"(price|priceWithVat|finalPrice|unitPrice|sellingPrice|currentPrice|salePrice|priceAmount)"\s*:\s*"?\d', body)
        out["blobs"].append({"kind": kind, "price_fields": n_price, "key": key.group(1) if key else None,
                             "script_bytes": len(body)})
    out["blobs"] = sorted(out["blobs"], key=lambda b: -b["price_fields"])[:3]
    out["found"] = bool(out["blobs"])
    return out


def html_price_patterns(html: str, soup: BeautifulSoup) -> list[dict]:
    """Where is a price in the HTML when there is no schema.org Product? (evidence for the report)"""
    pats = []
    for prop in ("product:price:amount", "og:price:amount", "product:sale_price:amount"):
        tag = soup.find("meta", attrs={"property": prop})
        if tag and tag.get("content"):
            pats.append({"pattern": f"meta[{prop}]", "example": tag["content"]})
    for tag in soup.select("[itemprop=price]")[:1]:
        pats.append({"pattern": "itemprop=price", "example": tag.get("content") or tag.get_text(strip=True)[:40]})
    if re.search(r"dataLayer\.push\(.{0,2000}?\"price\"\s*:\s*\"?[\d.]+", html, re.S):
        m = re.search(r"\"price\"\s*:\s*\"?([\d.,]+)", html)
        pats.append({"pattern": "dataLayer.push({... price ...})", "example": m.group(1) if m else None})
    st = embedded_state(html)
    for b in st["blobs"][:2]:
        pats.append({"pattern": f"embedded_json:{b['kind']}:{b['key']}", "example": f"{b['price_fields']} price fields"})
    for el in soup.find_all(class_=re.compile(r"price|cena|preis|cenas?\b", re.I), limit=60):
        txt = el.get_text(" ", strip=True)
        if txt and len(txt) < 40 and CURRENCY_RE.search(txt):
            pats.append({"pattern": "visible_text:." + " .".join(el.get("class") or [])[:60], "example": txt})
            break
    return pats


BRANCH_PATTERNS = [
    ("sk_in_store_availability", r"dostupnos[tť]\s+(?:v|na)\s+(?:predaj|obchod|pobo[cč])|skladom\s+(?:v|na)\s+predaj|dostupn[ée]\s+(?:v|na)\s+predaj|vyzdvihnutie\s+na\s+predaj|odber\s+na\s+predaj|moja\s+predaj"),
    ("cz_in_store_availability", r"dostupnost\s+na\s+prodejn|skladem\s+na\s+prodejn|vyzvednut[ií]\s+na\s+prodejn"),
    ("de_in_store_availability", r"verf[uü]gbarkeit\s+im\s+markt|in\s+der\s+filiale|im\s+markt\s+abholen|abholung\s+im\s+markt|marktverf[uü]gbarkeit"),
    ("pl_in_store_availability", r"dost[eę]pno[sś][cć]\s+w\s+sklepach?|odbi[oó]r\s+w\s+sklepie|stan\s+magazynowy\s+w\s+sklep"),
    ("en_in_store_availability", r"availability\s+in\s+store|check\s+(?:in[- ])?store\s+availability|click\s*&\s*collect|pick\s*up\s+in\s+store"),
    ("json_store_fields", r"\"(?:storeAvailability|storeStock|stockByStore|pickupInStore|availableAtOrFrom|inventoryLevel|storeId|branchStock|shopStock)\""),
]


def branch_stock_signals(html: str) -> dict:
    low = html[:1_500_000]
    hits = []
    for name, pat in BRANCH_PATTERNS:
        m = re.search(pat, low, re.I)
        if m:
            s = max(0, m.start() - 80)
            snippet = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", low[s:m.end() + 120]))[:200]
            hits.append({"signal": name, "snippet": snippet})
    endpoints = list(dict.fromkeys(re.findall(
        r"[\"'](/[^\"'\s<>]{0,120}(?:availability|stock|dostupnost|predajn|store-?stock|pickup)[^\"'\s<>]{0,80})[\"']", low, re.I)))[:4]
    mentions_ke = bool(re.search(r"ko[sš]ice", low, re.I))
    return {"signals": hits[:4], "endpoint_candidates": endpoints, "mentions_kosice": mentions_ke}


# ----------------------------------------------------------------------------------------------
# link candidates on the search page
# ----------------------------------------------------------------------------------------------

NON_PRODUCT_RE = re.compile(r"(?:^|/)(?:login|prihlasenie|kosik|cart|basket|warenkorb|wishlist|obchodne-podmienky|kontakt|"
                            r"cookies?|privacy|ochrana|reklamacie|doprava|search|vyhladavanie|hledani|wyszukiwarka)(?:/|$|\?)", re.I)


def slug(path: str) -> str:
    """URL path to words (hyphens are word separators in slugs, unlike in product names)."""
    return re.sub(r"[/_\-]+", " ", unquote(path))


def candidate_links(soup: BeautifulSoup, base_url: str, base_domain: str, query: str,
                    exclude_re: str | None = None) -> list[dict]:
    q = tokens(query)
    exclude = re.compile(exclude_re) if exclude_re else None
    need = max(1, math.ceil(0.6 * len(q)))
    seen, out = set(), []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        if any(p.name in ("nav", "footer", "header") for p in a.parents):
            continue
        url = urljoin(base_url, href).split("#")[0]
        parts = urlsplit(url)
        if registered_domain(parts.netloc.split(":")[0]) != base_domain or url in seen:
            continue
        if NON_PRODUCT_RE.search(parts.path) or (exclude and exclude.search(url)):
            continue
        label = " ".join(filter(None, [a.get_text(" ", strip=True), a.get("title"), a.get("aria-label"),
                                       " ".join(i.get("alt", "") for i in a.find_all("img"))]))
        hay_tokens = set(tokens(label)) | set(tokens(slug(parts.path)))
        joined = "".join(tokens(label)) + "".join(tokens(slug(parts.path)))
        score = sum(1 for t in q if token_in(t, hay_tokens, joined))
        if score >= need:
            seen.add(url)
            out.append({"url": url, "text": re.sub(r"\s+", " ", label)[:140], "score": score, "of": len(q),
                        "all_tokens": score == len(q)})
    return out


# ----------------------------------------------------------------------------------------------
# probing one (shop, product)
# ----------------------------------------------------------------------------------------------


def build_search_url(template: str, query: str) -> str:
    """{query} -> form encoding (spaces as +); {query_path} -> percent encoding (spaces as %20) for path templates."""
    return template.replace("{query_path}", quote(query, safe="")).replace("{query}", quote_plus(query))


def probe_search(fetch: Fetcher, robots: Robots, shop: dict, query: str) -> dict:
    """Fetch one search page and classify it. Returns a dict that always has 'status'."""
    url = build_search_url(shop["search_url_template"], query)
    res: dict = {"query": query, "url": url, "robots_allowed": robots.allowed(url)}
    if not res["robots_allowed"]:
        res["status"] = "disallowed_by_robots"
        return res
    try:
        r = fetch.get(url, "search")
    except BudgetExceeded:
        res["status"] = "budget_exhausted"
        return res
    res["http_status"] = r.get("status")
    res["final_url"] = r.get("final_url")
    if r.get("redirect_offsite"):
        res.update(status="redirected_offsite", redirect_to=r["redirect_offsite"])
        return res
    if not r["ok"]:
        res.update(status="error", error=r.get("error"))
        return res
    html, status = r["text"], r["status"]
    res["bytes"] = r["bytes"]
    res["cache_file"] = r["cache_file"]
    bot = detect_bot_wall(status, r["headers"], html)
    res["bot_wall"] = bot
    if bot["detected"]:
        res["status"] = "blocked"
        return res
    if status >= 400:
        res["status"] = "http_error"
        return res
    soup = BeautifulSoup(html, "lxml")
    structured = extract_structured(html, r["final_url"])
    res["structured"] = search_page_structured(structured)
    res["embedded_state"] = embedded_state(html)
    cands = candidate_links(BeautifulSoup(html, "lxml"), r["final_url"], fetch.base_domain, query,
                            shop.get("link_exclude_regex"))
    # If the page has a schema.org ItemList, its order is the shop's own ranking: put those URLs first.
    by_url = {c["url"]: c for c in cands}
    names = {urljoin(r["final_url"], p["url"]): p["name"] for p in res["structured"]["product_list"] if p.get("url") and p.get("name")}
    ranked = []
    for iu in res["structured"]["item_urls"]:
        full = urljoin(r["final_url"], iu)
        if registered_domain(urlsplit(full).netloc.split(":")[0]) != fetch.base_domain or full in {c["url"] for c in ranked}:
            continue
        c = by_url.get(full)
        if c is None:
            label = names.get(full, "")
            hay = set(tokens(label)) | set(tokens(slug(urlsplit(full).path)))
            joined = "".join(tokens(label)) + "".join(tokens(slug(urlsplit(full).path)))
            q = tokens(query)
            sc = sum(1 for t in q if token_in(t, hay, joined))
            c = {"url": full, "text": label[:140], "score": sc, "of": len(q), "all_tokens": sc == len(q)}
        ranked.append({**c, "from": "ItemList"})
    ranked_urls = {c["url"] for c in ranked}
    cands = ranked + [c for c in cands if c["url"] not in ranked_urls]
    res["n_candidates"] = len(cands)
    res["hits"] = cands[:12]
    res["n_hits_all_tokens"] = sum(1 for c in cands if c.get("all_tokens"))
    res["first_all_tokens_rank"] = next((i + 1 for i, c in enumerate(cands) if c.get("all_tokens")), None)
    text = visible_text(soup)
    res["visible_text_chars"] = len(text)
    res["price_strings_in_html"] = len(CURRENCY_RE.findall(text))
    res["no_results_text"] = bool(NO_RESULTS_RE.search(text))
    root_shell = bool(re.search(r'<div[^>]+id="(?:root|app|__next|__nuxt|q-app)"[^>]*>\s*</div>', html, re.I))
    if cands:
        res["status"] = "ok"
    elif res["no_results_text"]:
        res["status"] = "no_results"
    elif root_shell or res["price_strings_in_html"] == 0 or res["visible_text_chars"] < 1500:
        res["status"] = "needs_js_suspected"   # heuristic: no prices and no matching links in server HTML
        res["js_shell_root_div"] = root_shell
    else:
        res["status"] = "no_relevant_hits"     # prices are in the HTML, but nothing matched the query
    return res


def probe_product_page(fetch: Fetcher, robots: Robots, url: str, query: str) -> dict:
    res: dict = {"url": url, "robots_allowed": robots.allowed(url)}
    if not res["robots_allowed"]:
        res["status"] = "disallowed_by_robots"
        return res
    try:
        r = fetch.get(url, "product")
    except BudgetExceeded:
        res["status"] = "budget_exhausted"
        return res
    res["http_status"] = r.get("status")
    if r.get("redirect_offsite"):
        res.update(status="redirected_offsite", redirect_to=r["redirect_offsite"])
        return res
    if not r["ok"]:
        res.update(status="error", error=r.get("error"))
        return res
    html = r["text"]
    res["cache_file"] = r["cache_file"]
    res["bytes"] = r["bytes"]
    bot = detect_bot_wall(r["status"], r["headers"], html)
    res["bot_wall"] = bot
    if bot["detected"]:
        res["status"] = "blocked"
        return res
    if r["status"] >= 400:
        res["status"] = "http_error"
        return res
    structured = extract_structured(html, r["final_url"])
    prods = find_products(structured)
    best = next((p for p in prods if p["price"] is not None), None) or (prods[0] if prods else None)
    res["extruct_error"] = structured.get("error")
    res["n_product_nodes"] = len(prods)
    soup = BeautifulSoup(html, "lxml")
    if best:
        res["structured"] = best
        res["missing"] = [k for k in ("name", "price", "currency", "availability", "gtin", "brand", "shipping_details")
                          if not best.get(k)]
        res["status"] = "works" if best["price"] is not None else "structured_without_price"
        if best["name"]:
            res["relevance"] = match_info(query, " ".join(filter(None, [best.get("brand"), best["name"]])))
    else:
        res["structured"] = None
        res["status"] = "no_structured_data"
    if res["status"] != "works":
        res["html_price_patterns"] = html_price_patterns(html, soup)
        if not best and not res["html_price_patterns"]:
            res["price_strings_in_html"] = len(CURRENCY_RE.findall(visible_text(BeautifulSoup(html, "lxml"))))
            if res["price_strings_in_html"] == 0:
                res["status"] = "needs_js_suspected"   # heuristic: product page without any price in server HTML
    res["branch_stock"] = branch_stock_signals(html)
    return res


def run_product(fetch: Fetcher, robots: Robots, shop: dict, product: dict) -> dict:
    out: dict = {"product": product["id"], "query": product["query"]}
    search = probe_search(fetch, robots, shop, product["query"])
    queries_tried = [product["query"]]
    fb = product.get("fallback_query")
    if fb and search["status"] in ("no_results", "no_relevant_hits", "needs_js_suspected") and fetch.remaining() >= 3:
        fb_search = probe_search(fetch, robots, shop, fb)
        queries_tried.append(fb)
        search = {**fb_search, "first_query_status": search["status"]}
    out["search"] = search
    out["queries_tried"] = queries_tried
    if search["status"] != "ok":
        out["status"] = search["status"]
        return out
    # first plausible product link; the ItemList entry (if any) was inserted first
    first = search["hits"][0]
    out["first_hit"] = first
    page = probe_product_page(fetch, robots, first["url"], search["query"])
    out["product_page"] = page
    out["status"] = page["status"]
    return out


# ----------------------------------------------------------------------------------------------
# per shop
# ----------------------------------------------------------------------------------------------


def load_robots(fetch: Fetcher, shop: dict) -> tuple[Robots, dict]:
    """Fetch and parse robots.txt (1 request). Unreachable robots.txt means: do not fetch anything."""
    base = f"https://{urlsplit('//' + shop['domain']).netloc}"
    # use the host of the search template (www. vs bare matters), else the domain
    tmpl = shop.get("search_url_template")
    robots_url = (urlsplit(tmpl).scheme + "://" + urlsplit(tmpl).netloc if tmpl else base) + "/robots.txt"
    try:
        r = fetch.get(robots_url, "robots")
    except BudgetExceeded:
        return Robots(None, None, "budget"), {"url": robots_url, "mode": "disallow_all_unreachable", "error": "budget"}
    if r.get("redirect_offsite") or not r["ok"]:
        robots = Robots(None, r.get("status"), r.get("error"))
    else:
        robots = Robots(r["text"], r["status"])
        if r["status"] == 200 and r["text"].lstrip().lower().startswith(("<!doctype", "<html")):
            robots = Robots(None, 404)  # an HTML page instead of a robots.txt: treat as absent
    info = {"url": robots_url, "http_status": r.get("status"), "mode": robots.mode,
            "n_rules": len(robots.rules), "error": r.get("error"),
            "bot_wall": detect_bot_wall(r.get("status"), r.get("headers", {}), r.get("text", ""))["vendor"]
            if r.get("ok") and r.get("status") in (401, 403, 429, 503) else None}
    if robots.mode == "rules" and r.get("ok") and r["status"] == 200:
        info["sitemap_hint"] = bool(re.search(r"(?im)^sitemap:", r["text"]))
    return robots, info


def probe_known_urls(shop: dict, urls: dict[str, dict], existing: dict | None) -> dict:
    """Product-page-only pass: fetch product URLs found by a web search (the planned alternative route
    for shops whose search page may not be fetched). `urls` = {product_id: {"url": ..., "proxy": bool}}."""
    fetch = Fetcher(shop["id"], shop["domain"], shop.get("accept_language"))
    rec = existing or {"shop_id": shop["id"], "domain": shop["domain"], "name": shop["name"], "products": {}}
    robots, info = load_robots(fetch, shop)
    rec.setdefault("robots", info)
    rec["product_only"] = rec.get("product_only") or {}
    for pid, spec in urls.items():
        query = next((p["query"] for p in PRODUCTS if p["id"] == pid), pid)
        res = probe_product_page(fetch, robots, spec["url"], query)
        res["proxy_product"] = bool(spec.get("proxy"))
        res["note"] = spec.get("note")
        rec["product_only"][pid] = res
        if res["status"] == "blocked":
            break
    rec["request_log"] = (rec.get("request_log") or []) + fetch.log
    rec["verdict_product_route"] = route_verdict(rec["product_only"])
    return rec


def route_verdict(product_only: dict) -> str:
    per = [product_verdict(v) for v in product_only.values()]
    for v in VERDICT_RANK:
        if v in per:
            return v
    return "unreachable"


def probe_shop(shop: dict, products: list[dict], existing: dict | None) -> dict:
    fetch = Fetcher(shop["id"], shop["domain"], shop.get("accept_language"))
    rec = existing or {"shop_id": shop["id"], "domain": shop["domain"], "products": {}}
    rec.setdefault("products", {})
    rec["name"] = shop["name"]
    rec["probed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    robots, robots_info = load_robots(fetch, shop)
    rec["robots"] = robots_info
    blocked = False
    for p in products:
        key = p["id"]
        if not shop.get("search_url_template"):
            rec["products"][key] = {"product": key, "query": p["query"], "status": "no_search_template"}
            continue
        if blocked:
            rec["products"][key] = {"product": key, "query": p["query"], "status": "skipped_after_block"}
            continue
        res = run_product(fetch, robots, shop, p)
        rec["products"][key] = res
        if res["status"] == "blocked" or res.get("search", {}).get("status") == "blocked":
            blocked = True   # do not keep hitting a shop that has said no
    rec["requests_used_this_run"] = fetch.used
    rec["request_log"] = (rec.get("request_log") or []) + fetch.log
    rec["verdict"], rec["verdict_reason"] = verdict_for(rec)
    return rec


VERDICT_RANK = ["works", "no_structured_data", "needs_js", "blocked", "robots_disallowed", "no_results", "unreachable", "no_search_template"]


def product_verdict(res: dict) -> str:
    st = res.get("status")
    if st == "works":
        return "works"
    if st in ("structured_without_price", "no_structured_data"):
        return "no_structured_data"
    if st == "needs_js_suspected":
        return "needs_js"
    if st == "blocked":
        return "blocked"
    if st == "disallowed_by_robots":
        return "robots_disallowed"
    if st in ("no_results", "no_relevant_hits", "no_product_link"):
        return "no_results"
    if st == "no_search_template":
        return "no_search_template"
    if st == "skipped_after_block":
        return "blocked"
    if res.get("search", {}).get("status") == "disallowed_by_robots":
        return "robots_disallowed"
    if st == "budget_exhausted":
        return "unreachable"
    return "unreachable"


def verdict_for(rec: dict) -> tuple[str, str]:
    per = {k: product_verdict(v) for k, v in rec["products"].items()}
    if not per:
        return "unreachable", "nothing tested"
    for v in VERDICT_RANK:
        if v in per.values():
            if v == "robots_disallowed":
                return v, "robots.txt disallows the search URL: " + ", ".join(k for k, x in per.items() if x == v)
            return v, ", ".join(f"{k}={x}" for k, x in per.items())
    return "unreachable", str(per)


# ----------------------------------------------------------------------------------------------
# output
# ----------------------------------------------------------------------------------------------


def fields_available(rec: dict) -> str:
    seen = {"price": False, "avail": False, "gtin": False, "ship": False}
    for res in rec["products"].values():
        s = (res.get("product_page") or {}).get("structured") or {}
        seen["price"] |= s.get("price") is not None
        seen["avail"] |= bool(s.get("availability"))
        seen["gtin"] |= bool(s.get("gtin"))
        seen["ship"] |= bool(s.get("shipping_details"))
    return ",".join(k for k, v in seen.items() if v) or "-"


def search_sd(rec: dict) -> str:
    best = "-"
    for res in rec["products"].values():
        s = res.get("search") or {}
        st = s.get("structured") or {}
        if st.get("products_with_price"):
            return "products+price"
        if st.get("item_lists") or st.get("products"):
            best = "itemlist/products"
        elif (s.get("embedded_state") or {}).get("found") and best == "-":
            best = "embedded_json"
    return best


def reach(rec: dict) -> str:
    statuses = [(r.get("search") or {}).get("http_status") for r in rec["products"].values()]
    statuses = [s for s in statuses if s is not None]
    if not statuses:
        return "no"
    return "/".join(sorted({str(s) for s in statuses}))


def product_sd(rec: dict) -> str:
    vals = [(r.get("product_page") or {}).get("status") for r in rec["products"].values()]
    vals = [v for v in vals if v]
    if not vals:
        return "-"
    return "yes" if "works" in vals else ("no_price" if "structured_without_price" in vals else "no" if "no_structured_data" in vals else vals[0])


def print_table(results: dict, shops: list[dict]) -> None:
    rows = []
    for s in shops:
        rec = results["shops"].get(s["id"])
        if not rec or "verdict" not in rec:
            continue
        rows.append((s["id"], reach(rec), search_sd(rec), product_sd(rec), fields_available(rec), rec["verdict"],
                     rec.get("verdict_product_route", "")))
    hdr = ("shop", "search_http", "search_struct", "product_struct", "fields", "verdict", "via_known_url")
    widths = [max(len(str(x[i])) for x in rows + [hdr]) for i in range(len(hdr))]
    line = lambda r: "  ".join(str(c).ljust(w) for c, w in zip(r, widths))
    print(line(hdr))
    print("  ".join("-" * w for w in widths))
    for r in rows:
        print(line(r))
    counts: dict[str, int] = {}
    for r in rows:
        counts[r[5]] = counts.get(r[5], 0) + 1
    print(f"\n{len(rows)} shops: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])))


def load_results() -> dict:
    if OUT_FILE.exists():
        try:
            return json.loads(OUT_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"meta": {}, "shops": {}}


def save_results(results: dict) -> None:
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(OUT_FILE)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma-separated shop ids")
    ap.add_argument("--products", help="comma-separated product ids (default: all)")
    ap.add_argument("--resume", action="store_true", help="skip (shop, product) pairs that already have a non-error result")
    ap.add_argument("--summary-only", action="store_true")
    ap.add_argument("--known-urls", metavar="FILE", help="product-page-only pass: YAML {shop_id: {product_id: {url, proxy?}}}")
    ap.add_argument("--include-out-of-scope", action="store_true", help="also probe shops with in_scope: false")
    ap.add_argument("--shops-file", default=str(SHOPS_FILE))
    args = ap.parse_args()

    db = yaml.safe_load(Path(args.shops_file).read_text(encoding="utf-8"))
    shops = db["shops"]
    only = set(args.only.split(",")) if args.only else None
    pids = set(args.products.split(",")) if args.products else None
    results = load_results()

    if args.known_urls and not args.summary_only:
        known = yaml.safe_load(Path(args.known_urls).read_text(encoding="utf-8")) or {}
        by_id = {s["id"]: s for s in shops}
        jobs = [(by_id[sid], urls) for sid, urls in known.items() if sid in by_id and (not only or sid in only)]
        print(f"product-page-only pass: {len(jobs)} shops", flush=True)
        lock = threading.Lock()

        def work_known(job):
            shop, urls = job
            rec = probe_known_urls(shop, urls, results["shops"].get(shop["id"]))
            with lock:
                results["shops"][shop["id"]] = rec
                save_results(results)
                states = ",".join(f"{k}={v['status']}" for k, v in rec["product_only"].items())
                print(f"  done {shop['id']:<22} {states}", flush=True)

        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            list(ex.map(work_known, jobs))
        return 0

    if not args.summary_only:
        todo = []
        for s in shops:
            if only and s["id"] not in only:
                continue
            if not s.get("in_scope", True) and not args.include_out_of_scope:
                continue
            cats = set(s.get("categories") or [])
            prods = [p for p in PRODUCTS if (not pids or p["id"] in pids) and (p["categories"] & cats)]
            if args.resume:
                done = results["shops"].get(s["id"], {}).get("products", {})
                prods = [p for p in prods if p["id"] not in done or done[p["id"]].get("status") in ("error", "budget_exhausted")]
            if prods:
                todo.append((s, prods))
        print(f"probing {len(todo)} shops with {WORKERS} workers "
              f"(<= {MAX_REQUESTS_PER_SHOP} requests/shop, 1 request/{MIN_INTERVAL_S:.0f}s/host)", flush=True)
        lock = threading.Lock()

        def work(item):
            shop, prods = item
            # a partial pass (--products / --resume) keeps earlier results for the same shop
            existing = results["shops"].get(shop["id"]) if (args.products or args.resume) else None
            try:
                rec = probe_shop(shop, prods, existing)
            except Exception as exc:  # keep going; record the crash instead of losing the whole run
                rec = {"shop_id": shop["id"], "domain": shop["domain"], "name": shop["name"], "products": {},
                       "verdict": "unreachable", "verdict_reason": f"probe crashed: {type(exc).__name__}: {exc}"}
            with lock:
                results["shops"][shop["id"]] = rec
                results["meta"] = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                   "user_agent": USER_AGENT, "min_interval_s_per_host": MIN_INTERVAL_S,
                                   "max_requests_per_shop_per_run": MAX_REQUESTS_PER_SHOP,
                                   "products": [{"id": p["id"], "query": p["query"]} for p in PRODUCTS]}
                save_results(results)
                print(f"  done {shop['id']:<22} {rec['verdict']:<18} requests={rec.get('requests_used_this_run')}", flush=True)

        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            list(ex.map(work, todo))

    print()
    print_table(results, [s for s in shops if (not only or s["id"] in only)])
    return 0


if __name__ == "__main__":
    sys.exit(main())
