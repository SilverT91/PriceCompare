#!/usr/bin/env python3
"""Measure what a real browser engine adds for a product page (a measurement tool, not part of the app).

The app reads prices from schema.org JSON-LD `Product` data in a shop's plain HTML. Some shops put
that data into the page only after JavaScript runs, so the app only links to them. This tool loads
a given page in headless Chromium (through Playwright) and reports what the browser sees, next to
what one plain HTTP GET sees, so the question "does a browser engine add anything for this page?"
can be answered with a measurement. It is not imported by the app and the app does not depend on it.

Run (system Python with `playwright` and its Chromium installed; this tool never downloads a browser):
  python tools/render_probe.py URL [URL ...]
  python tools/render_probe.py --json URL [URL ...]
  python tools/render_probe.py --allow-host cdn.example.com --allow-host api.example.com URL

A page whose data comes from another host shows nothing until that host is allowed with
`--allow-host` (exact host names, repeatable, no wildcard): the first run lists the hosts that were
aborted, with a count each, and a second run can allow the ones that belong to the shop's own
platform. An allowed host's robots.txt is read before the page load (same 3 s gate) and any request
to it that robots.txt disallows is aborted (counted as `robots_disallowed`).

For each URL, in this order:
  1. robots.txt of the host is read for the agent token `price-compare`; if the path is disallowed,
     nothing else is loaded for that URL (`robots: disallowed`).
  2. One plain GET with the User-Agent `price-compare/0.1`; its JSON-LD is read.
  3. The page is loaded in headless Chromium and the tool waits until a JSON-LD `Product` appears
     in the DOM, at most 15 seconds. Skipped if step 2 got 403 or 429 (the site's answer is final).
  4. Report: final URL, status, request counts, bytes, the Product's name, price, currency,
     availability and GTIN (nothing else from the page), and whether the plain HTML had it too.

Request rules followed:
  * robots.txt is checked before any load (RFC 9309 matching, agent token `price-compare`); an
    unreachable robots.txt (network error or 5xx) counts as disallow-all, a 4xx as no rules.
  * At least 3 seconds between two top-level requests to one host (robots.txt, plain GET, page load).
  * No retries; a 403 or 429 is reported as `blocked` and left alone.
  * Honest identity: the browser's own default user agent plus " price-compare/0.1". No stealth:
    no patched flags, plugins, proxy, header tricks, cookie acceptance, clicks, or challenge handling.
  * Small traffic: images, fonts, media and stylesheets are aborted, as is every request to a host
    outside the page's registered domain unless allowed with --allow-host (third-party scripts,
    analytics, ads). Requests to the page's own host that robots.txt disallows are aborted too.

What cannot hold inside a browser engine: the 3-second gap applies to page loads. The page's own
scripts and data calls go out when the page makes them, so the output lists how many requests went to
each host and how close together they were. Other first-party hosts are not checked against their own
robots.txt (that would add requests). The wait for the Product stops at 15 seconds, and the browser
context is closed then, which cancels what is still in flight.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

TOOL_TOKEN = "price-compare"
TOOL_VERSION = "0.1"
PLAIN_UA = f"{TOOL_TOKEN}/{TOOL_VERSION}"
ACCEPT_LANGUAGE = "sk-SK,sk;q=0.9,en;q=0.5"
MIN_INTERVAL_S = 3.0
WAIT_PRODUCT_S = 15.0
GOTO_TIMEOUT_MS = 30_000
HTTP_TIMEOUT_S = 20
MAX_BYTES = 4_000_000
MAX_REDIRECTS = 3
BLOCK_STATUSES = (403, 429, 503)
ABORT_TYPES = {"image", "font", "media", "stylesheet"}
PRODUCT_TYPES = {"Product", "ProductGroup", "IndividualProduct"}
GTIN_KEYS = ["gtin", "gtin8", "gtin12", "gtin13", "gtin14"]
SECOND_LEVEL = {"co.uk", "org.uk", "com.au", "co.jp", "co.nz", "com.br", "com.pl", "com.tr"}


# ----------------------------------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------------------------------


def registered_domain(host: str) -> str:
    host = host.lower().split(":")[0]
    parts = host.split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in SECOND_LEVEL:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


class HostGate:
    """Keeps at least MIN_INTERVAL_S between two top-level requests to one host."""

    def __init__(self) -> None:
        self._last: dict[str, float] = {}

    def wait(self, host: str) -> None:
        gap = time.monotonic() - self._last.get(host, -1e9)
        if gap < MIN_INTERVAL_S:
            time.sleep(MIN_INTERVAL_S - gap)
        self._last[host] = time.monotonic()

    def touch(self, host: str) -> None:
        self._last[host] = time.monotonic()


GATE = HostGate()


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # type: ignore[override]
        return None


_OPENER = build_opener(_NoRedirect)


def decode_body(raw: bytes, content_type: str) -> str:
    m = re.search(r"charset=([\w-]+)", content_type or "", re.I)
    enc = m.group(1) if m else "utf-8"
    try:
        return raw.decode(enc, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def plain_get(url: str) -> dict:
    """One GET with the tool's own User-Agent. Follows at most MAX_REDIRECTS redirects on the same
    registered domain. Never retries. Returns a dict; never raises on HTTP or network errors."""
    base = registered_domain(urlsplit(url).netloc)
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        GATE.wait(urlsplit(current).netloc.lower())
        req = Request(current, headers={"User-Agent": PLAIN_UA, "Accept-Language": ACCEPT_LANGUAGE,
                                        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"})
        try:
            resp = _OPENER.open(req, timeout=HTTP_TIMEOUT_S)
            status, headers, raw = resp.status, resp.headers, resp.read(MAX_BYTES)
            resp.close()
        except HTTPError as exc:
            status, headers = exc.code, exc.headers
            try:
                raw = exc.read(MAX_BYTES)
            except Exception:
                raw = b""
        except (URLError, TimeoutError, OSError) as exc:
            return {"ok": False, "status": None, "url": current, "error": f"{type(exc).__name__}"}
        if status in (301, 302, 303, 307, 308) and headers.get("Location"):
            nxt = urljoin(current, headers["Location"])
            if registered_domain(urlsplit(nxt).netloc) != base:
                return {"ok": True, "status": status, "url": current, "redirect_offsite": nxt, "text": "", "bytes": 0}
            current = nxt
            continue
        return {"ok": True, "status": status, "url": current, "bytes": len(raw),
                "text": decode_body(raw, headers.get("Content-Type", ""))}
    return {"ok": False, "status": None, "url": current, "error": "too_many_redirects"}


# ----------------------------------------------------------------------------------------------
# robots.txt (RFC 9309: longest match wins, allow wins ties, * and $ supported)
# ----------------------------------------------------------------------------------------------


class Robots:
    def __init__(self, text: str | None, status: int | None) -> None:
        self.mode = "rules"
        self.status = status
        self.rules: list[tuple[bool, str]] = []
        if status is None or 500 <= status < 600:
            self.mode = "disallow_all_unreachable"
        elif status >= 400:
            self.mode = "allow_all"
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
                if value:
                    rules.append((key == "allow", value))
        if agents:
            groups.append((agents, rules))
        specific = [g for g in groups if any(a == TOOL_TOKEN for a in g[0])]
        for _, r in specific or [g for g in groups if "*" in g[0]]:
            self.rules.extend(r)

    @staticmethod
    def _match_len(pattern: str, path: str) -> int:
        anchored = pattern.endswith("$")
        if anchored:
            pattern = pattern[:-1]
        regex = "^" + "".join(".*" if c == "*" else re.escape(c) for c in pattern) + ("$" if anchored else "")
        return len(pattern) if re.match(regex, path) else -1

    def allowed(self, url: str) -> bool:
        if self.mode == "allow_all":
            return True
        if self.mode == "disallow_all_unreachable":
            return False
        parts = urlsplit(url)
        path = (parts.path or "/") + (("?" + parts.query) if parts.query else "")
        best_len, best_allow = -1, True
        for allow, pattern in self.rules:
            n = self._match_len(pattern, path)
            if n > best_len or (n == best_len and allow and not best_allow):
                best_len, best_allow = n, allow
        return best_allow


_ROBOTS: dict[str, Robots] = {}


def robots_for(url: str) -> Robots:
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc.lower()}"
    if origin not in _ROBOTS:
        r = plain_get(origin + "/robots.txt")
        text = r.get("text", "")
        status = r.get("status")
        if r.get("redirect_offsite") or not r.get("ok"):
            status = None
        elif status == 200 and text.lstrip().lower().startswith(("<!doctype", "<html")):
            status = 404  # an HTML page in place of a robots.txt: treated as absent
        _ROBOTS[origin] = Robots(text, status)
    return _ROBOTS[origin]


# ----------------------------------------------------------------------------------------------
# JSON-LD Product reading (only name, price, currency, availability, GTIN are kept)
# ----------------------------------------------------------------------------------------------

LD_RE = re.compile(r"<script\b[^>]*type\s*=\s*[\"']?application/ld\+json[\"']?[^>]*>(.*?)</script>", re.S | re.I)


def ld_texts_from_html(html: str) -> list[str]:
    return [m.group(1) for m in LD_RE.finditer(html or "")]


def iter_nodes(obj, depth: int = 0):
    if depth > 12:
        return
    if isinstance(obj, list):
        for x in obj:
            yield from iter_nodes(x, depth + 1)
    elif isinstance(obj, dict):
        yield obj
        for k, v in obj.items():
            if k != "@context" and isinstance(v, (dict, list)):
                yield from iter_nodes(v, depth + 1)


def type_names(node: dict) -> set[str]:
    t = node.get("@type")
    ts = t if isinstance(t, list) else [t]
    return {str(x).rsplit("/", 1)[-1].rsplit("#", 1)[-1] for x in ts if x}


def first_str(v) -> str | None:
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
    out: list[dict] = []
    raw = node.get("offers")
    for o in raw if isinstance(raw, list) else [raw] if raw else []:
        if isinstance(o, dict):
            out.append(o)
            sub = o.get("offers")
            out.extend(s for s in (sub if isinstance(sub, list) else [sub] if sub else []) if isinstance(s, dict))
    return out


def summarize_product(node: dict) -> dict:
    offers = offers_of(node)
    variants = node.get("hasVariant")
    var_list = variants if isinstance(variants, list) else [variants] if variants else []
    if not offers and var_list and isinstance(var_list[0], dict):
        offers = offers_of(var_list[0])
    price = currency = availability = gtin = None
    for k in GTIN_KEYS:
        if node.get(k):
            gtin = first_str(node[k])
            break
    for o in offers:
        spec = o.get("priceSpecification")
        spec = spec[0] if isinstance(spec, list) and spec else spec
        spec = spec if isinstance(spec, dict) else {}
        raw = o.get("price")
        if raw in (None, ""):
            raw = spec.get("price")
        if raw in (None, ""):
            raw = o.get("lowPrice")
        if price is None and raw not in (None, ""):
            price = str(raw)
        currency = currency or first_str(o.get("priceCurrency")) or first_str(spec.get("priceCurrency"))
        if not availability and o.get("availability"):
            availability = str(first_str(o["availability"])).rsplit("/", 1)[-1]
        if not gtin:
            for k in GTIN_KEYS:
                if o.get(k):
                    gtin = first_str(o[k])
                    break
    return {"name": first_str(node.get("name")), "price": price, "currency": currency,
            "availability": availability, "gtin": gtin}


def ld_types(ld_texts: list[str]) -> list[list[str]]:
    """Per JSON-LD block, the `@type` names of its top-level nodes (and of the nodes in an `@graph`)."""
    out: list[list[str]] = []
    for text in ld_texts:
        try:
            data = json.loads(text.strip(), strict=False)
        except ValueError:
            out.append(["(not valid JSON)"])
            continue
        roots = data if isinstance(data, list) else [data]
        nodes: list = []
        for root in roots:
            if isinstance(root, dict) and isinstance(root.get("@graph"), list):
                nodes.extend(root["@graph"])
            else:
                nodes.append(root)
        names: list[str] = []
        for node in nodes:
            if isinstance(node, dict):
                names.extend(n for n in sorted(type_names(node)) if n not in names)
        out.append(names or ["(no @type)"])
    return out


def find_product(ld_texts: list[str]) -> dict | None:
    """The first Product node that has a price, else the first Product node."""
    products: list[dict] = []
    for text in ld_texts:
        try:
            data = json.loads(text.strip(), strict=False)
        except ValueError:
            continue
        for node in iter_nodes(data):
            if type_names(node) & PRODUCT_TYPES:
                products.append(summarize_product(node))
    return next((p for p in products if p["price"] is not None), products[0] if products else None)


def norm_price(p: str | None) -> str | None:
    if p is None:
        return None
    try:
        return f"{float(str(p).replace(',', '.').replace(' ', '')):.2f}"
    except ValueError:
        return str(p)


def same_product(a: dict | None, b: dict | None) -> bool:
    if not a or not b:
        return False
    na = re.sub(r"\s+", " ", (a["name"] or "")).strip().casefold()
    nb = re.sub(r"\s+", " ", (b["name"] or "")).strip().casefold()
    return na == nb and norm_price(a["price"]) == norm_price(b["price"])


# ----------------------------------------------------------------------------------------------
# the browser load
# ----------------------------------------------------------------------------------------------

WAIT_JS = """() => {
  const want = new Set(['Product', 'ProductGroup', 'IndividualProduct']);
  const walk = (o, d) => {
    if (!o || d > 12 || typeof o !== 'object') return false;
    if (Array.isArray(o)) return o.some(x => walk(x, d + 1));
    const t = o['@type'];
    const ts = Array.isArray(t) ? t : [t];
    if (ts.some(x => typeof x === 'string' && want.has(x.split('/').pop().split('#').pop()))) return true;
    return Object.values(o).some(v => walk(v, d + 1));
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { if (walk(JSON.parse(s.textContent), 0)) return true; } catch (e) {}
  }
  return false;
}"""

READ_JS = """() => ({
  ld: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => s.textContent),
  text_chars: (document.body ? document.body.innerText : '').trim().length,
})"""


def browser_load(browser, url: str, robots: Robots, allowed: dict[str, Robots]) -> dict:
    """Load `url` in headless Chromium. Returns the measured facts (no page content besides JSON-LD).
    `allowed` maps each --allow-host host name to its robots.txt rules."""
    page_host = (urlsplit(url).hostname or "").lower()
    page_domain = registered_domain(page_host)
    res: dict = {"launched": True}
    ctx = None
    try:
        res["browser"] = f"Chromium {browser.version}"
        probe_page = browser.new_page()  # about:blank, no network: only to read the default user agent
        default_ua = probe_page.evaluate("navigator.userAgent")
        probe_page.close()
        ua = f"{default_ua} {PLAIN_UA}"
        res["user_agent"] = ua
        ctx = browser.new_context(user_agent=ua, locale="sk-SK")
        page = ctx.new_page()

        stats = {"requested": 0, "continued": 0, "aborted": 0}
        aborted_by: dict[str, int] = {}
        aborted_hosts: dict[str, int] = {}
        host_times: dict[str, list[float]] = {}
        finished: list = []
        t0 = time.monotonic()

        def bump(reason: str) -> None:
            stats["aborted"] += 1
            aborted_by[reason] = aborted_by.get(reason, 0) + 1

        def handle(route, request):
            stats["requested"] += 1
            host = (urlsplit(request.url).hostname or "").lower()
            if request.resource_type in ABORT_TYPES:
                bump(request.resource_type)
                return route.abort()
            if host in allowed:
                if not allowed[host].allowed(request.url):
                    bump("robots_disallowed")
                    return route.abort()
            elif registered_domain(host) != page_domain:
                bump("third_party")
                aborted_hosts[host] = aborted_hosts.get(host, 0) + 1  # host name only, no path or query
                return route.abort()
            elif host == page_host and not robots.allowed(request.url):
                bump("robots_disallowed")
                return route.abort()
            stats["continued"] += 1
            host_times.setdefault(host, []).append(time.monotonic() - t0)
            return route.continue_()

        ctx.route("**/*", handle)
        page.on("requestfinished", lambda r: finished.append(r))

        GATE.wait(page_host)
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=GOTO_TIMEOUT_MS)
        except Exception as exc:  # navigation failure (DNS, timeout, aborted main document)
            res["error"] = f"{type(exc).__name__}"
            res["final_url"] = page.url
            resp = None
        if resp is not None:
            res["http_status"] = resp.status
            res["final_url"] = page.url
            t_loaded = time.monotonic()
            try:
                page.wait_for_function(WAIT_JS, timeout=WAIT_PRODUCT_S * 1000, polling=250)
                res["product_appeared"] = True
                res["seconds_until_product"] = round(time.monotonic() - t0, 2)
            except Exception:
                res["product_appeared"] = False
                res["seconds_waited"] = round(time.monotonic() - t_loaded, 1)
            read = page.evaluate(READ_JS)
            res["ld_blocks"] = len(read["ld"])
            res["ld_types"] = ld_types(read["ld"])
            res["body_text_chars"] = read["text_chars"]
            res["product"] = find_product(read["ld"])
        res["seconds_total"] = round(time.monotonic() - t0, 2)

        total_bytes = counted = 0
        for r in finished:
            try:
                s = r.sizes()
                total_bytes += (s.get("responseBodySize") or 0) + (s.get("responseHeadersSize") or 0)
                counted += 1
            except Exception:
                pass
        res["requests"] = {"made": stats["continued"], "aborted": stats["aborted"], "total_seen": stats["requested"],
                           "aborted_by": aborted_by,
                           "aborted_third_party_hosts": dict(sorted(aborted_hosts.items(), key=lambda kv: -kv[1])),
                           "bytes_received": total_bytes, "finished_counted": counted}
        res["hosts"] = summarize_hosts(host_times)
        for h in res["hosts"]:
            h["allowed_by_option"] = h["host"] in allowed
    finally:
        if ctx is not None:
            ctx.close()
        GATE.touch(page_host)
    return res


def summarize_hosts(host_times: dict[str, list[float]]) -> list[dict]:
    out = []
    for host, times in sorted(host_times.items(), key=lambda kv: -len(kv[1])):
        times = sorted(times)
        gaps = [b - a for a, b in zip(times, times[1:])]
        out.append({"host": host, "requests": len(times),
                    "min_gap_s": round(min(gaps), 3) if gaps else None,
                    "gaps_under_3s": sum(1 for g in gaps if g < MIN_INTERVAL_S)})
    return out


# ----------------------------------------------------------------------------------------------
# one URL
# ----------------------------------------------------------------------------------------------


def probe_url(browser, url: str, allow_hosts: list[str]) -> dict:
    out: dict = {"url": url}
    robots = robots_for(url)
    out["robots"] = "allowed" if robots.allowed(url) else "disallowed"
    if robots.mode == "disallow_all_unreachable":
        out["robots_note"] = "robots.txt unreachable: treated as disallow-all"
    if out["robots"] == "disallowed":
        return out

    plain = plain_get(url)
    plain_ld = ld_texts_from_html(plain.get("text", "")) if plain.get("ok") else []
    plain_product = find_product(plain_ld)
    out["plain"] = {"status": plain.get("status"), "bytes": plain.get("bytes"), "error": plain.get("error"),
                    "ld_blocks": len(plain_ld), "ld_types": ld_types(plain_ld),
                    "redirect_offsite": plain.get("redirect_offsite"), "final_url": plain.get("url"),
                    "blocked": plain.get("status") in BLOCK_STATUSES, "product": plain_product}
    if plain.get("status") in (403, 429):
        out["browser"] = {"skipped": "plain request answered %s; not retried" % plain["status"]}
        out["browser_adds_product_data"] = None
        return out

    # robots.txt of every allowed host is read before the page load (3 s gate per host, as for the page host)
    allowed: dict[str, Robots] = {}
    out["allowed_hosts"] = []
    for host in allow_hosts:
        rb = robots_for(f"https://{host}/")
        allowed[host] = rb
        out["allowed_hosts"].append({"host": host, "robots_mode": rb.mode, "robots_http_status": rb.status,
                                     "rules_for_agent": len(rb.rules)})
    b = browser_load(browser, url, robots, allowed)
    if b.get("http_status") in BLOCK_STATUSES:
        b["blocked"] = True
    elif not b.get("product") and (b.get("body_text_chars") or 0) < 300 and b.get("http_status"):
        b["note"] = "no product data and a very short body (%s characters of text)" % b.get("body_text_chars")
    out["browser"] = b
    in_browser = bool(b.get("product"))
    in_plain = bool(plain_product)
    out["product_in_plain_html"] = in_plain
    out["product_in_browser"] = in_browser
    out["same_product_and_price"] = same_product(plain_product, b.get("product")) if in_plain and in_browser else None
    out["browser_adds_product_data"] = in_browser and not in_plain
    return out


# ----------------------------------------------------------------------------------------------
# output
# ----------------------------------------------------------------------------------------------


def fmt_product(p: dict | None) -> str:
    if not p:
        return "none"
    return (f"name={p['name']!r} price={p['price']} {p['currency']} availability={p['availability']} "
            f"gtin={p['gtin']}")


def print_report(r: dict) -> None:
    print(f"URL: {r['url']}")
    print(f"  robots: {r['robots']}" + (f" ({r['robots_note']})" if r.get("robots_note") else ""))
    if "plain" not in r:
        print()
        return
    p = r["plain"]
    print(f"  plain GET: status={p['status']} bytes={p['bytes']} blocked={p['blocked']}"
          + (f" error={p['error']}" if p.get("error") else "")
          + (f" redirected off-site to {p['redirect_offsite']}" if p.get("redirect_offsite") else ""))
    print(f"    plain HTML JSON-LD blocks: {p['ld_blocks']} types {p['ld_types']}")
    print(f"    plain HTML JSON-LD Product: {fmt_product(p['product'])}")
    b = r["browser"]
    if b.get("skipped"):
        print(f"  browser: skipped ({b['skipped']})\n")
        return
    print(f"  browser: {b.get('browser')} launched={b['launched']}")
    print(f"    final URL: {b.get('final_url')}  status={b.get('http_status')}"
          + ("  blocked" if b.get("blocked") else "") + (f"  error={b['error']}" if b.get("error") else ""))
    if b.get("note"):
        print(f"    note: {b['note']}")
    q = b.get("requests", {})
    print(f"    requests: made={q.get('made')} aborted={q.get('aborted')} (by reason {q.get('aborted_by')}) "
          f"bytes received={q.get('bytes_received')} (for {q.get('finished_counted')} finished requests)")
    for a in r.get("allowed_hosts", []):
        print(f"      allowed host {a['host']}: robots.txt mode={a['robots_mode']} (HTTP {a['robots_http_status']}, "
              f"{a['rules_for_agent']} rules for this agent)")
    for h in b.get("hosts", []):
        print(f"      host {h['host']}{' (allowed by option)' if h.get('allowed_by_option') else ''}: "
              f"{h['requests']} requests, smallest gap {h['min_gap_s']} s, {h['gaps_under_3s']} gaps under 3 s")
    hosts = q.get("aborted_third_party_hosts") or {}
    if hosts:
        print("      aborted third-party hosts: " + ", ".join(f"{h} x{n}" for h, n in hosts.items()))
    print(f"    JSON-LD blocks in DOM: {b.get('ld_blocks')} types {b.get('ld_types')}  "
          f"body text chars: {b.get('body_text_chars')}  "
          f"time: {b.get('seconds_total')} s")
    if b.get("product_appeared"):
        print(f"    Product appeared after {b.get('seconds_until_product')} s")
    else:
        print(f"    no Product within {WAIT_PRODUCT_S:.0f} s of waiting")
    print(f"    browser JSON-LD Product: {fmt_product(b.get('product'))}")
    print(f"  in plain HTML: {r['product_in_plain_html']}  in browser: {r['product_in_browser']}  "
          f"same name and price: {r['same_product_and_price']}  browser adds product data: {r['browser_adds_product_data']}")
    print()


def clean_message(text: str) -> str:
    """Error text without file system paths (they can contain a user name)."""
    return re.sub(r"(?:[A-Za-z]:[\\/]|/)[^\s]*", "<path>", text)[:200]


def main() -> int:
    ap = argparse.ArgumentParser(description="Measure what a headless browser sees on a product page, "
                                             "next to one plain GET (measurement tool, not part of the app).")
    ap.add_argument("urls", nargs="+", metavar="URL")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--allow-host", action="append", default=[], metavar="HOST",
                    help="let requests to this exact host name through although it is outside the page's "
                         "registered domain (repeatable; its robots.txt is read first and obeyed)")
    args = ap.parse_args()
    allow_hosts: list[str] = []
    for h in args.allow_host:
        h = h.strip().lower()
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", h) or "." not in h:
            ap.error(f"--allow-host takes one exact host name such as cdn.example.com, got {h!r}")
        if h not in allow_hosts:
            allow_hosts.append(h)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright is not installed for this Python (this tool never installs anything)", file=sys.stderr)
        return 2

    results = []
    with sync_playwright() as pw:
        # Launch first, before any request to a shop: if Chromium is not installed, stop here.
        try:
            browser = pw.chromium.launch(headless=True)
        except Exception as exc:
            first = str(exc).splitlines()[0] if str(exc) else ""
            print(f"Chromium could not be launched ({type(exc).__name__}: {clean_message(first)}). "
                  "This tool never downloads a browser; install one yourself if you want to measure.",
                  file=sys.stderr)
            return 3
        try:
            for url in args.urls:
                if urlsplit(url).scheme not in ("http", "https"):
                    results.append({"url": url, "error": "only http and https URLs"})
                    continue
                try:
                    results.append(probe_url(browser, url, allow_hosts))
                except Exception as exc:
                    first = str(exc).splitlines()[0] if str(exc) else ""
                    results.append({"url": url, "error": f"{type(exc).__name__}: {clean_message(first)}"})
        finally:
            browser.close()
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=1))
    else:
        for r in results:
            if r.get("error") and "robots" not in r:
                print(f"URL: {r['url']}\n  error: {r['error']}\n")
            else:
                print_report(r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
