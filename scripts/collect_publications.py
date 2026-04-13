"""
collect_publications.py
-----------------------
Fetches dated publications for the top 30 US recipients by grant volume.

PRIMARY:  Semantic Scholar API (free, no key, 100 req/5 min)
FALLBACK: Google News RSS (if Semantic Scholar returns <5 results for an org)

Outputs data/publications.json.
Cache: data/raw/publications_cache/{slug}.json — re-runs are fast.
"""

import hashlib
import json
import logging
import re
import time
import unicodedata
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus

import requests

# ---------------------------------------------------------------------------
# Paths & config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent / "data"
CACHE_DIR = DATA_DIR / "raw" / "publications_cache"
OUTPUT_FILE = DATA_DIR / "publications.json"

CACHE_DIR.mkdir(parents=True, exist_ok=True)

SEMANTIC_SCHOLAR_BASE = "https://api.semanticscholar.org/graph/v1/paper/search"
GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"

SS_FIELDS = "title,year,publicationDate,venue,openAccessPdf,externalIds,citationCount,authors"
YEAR_RANGE = "2019-2025"
PER_ORG_LIMIT = 50
SS_THRESHOLD = 5          # fall back to Google News if fewer results
SS_RATE_SEC = 1.1         # seconds between Semantic Scholar requests
GN_RATE_SEC = 2.5         # seconds between Google News RSS requests

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slug(name: str) -> str:
    """URL-safe ASCII slug for cache filenames."""
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_str = nfkd.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", ascii_str.lower()).strip("_")[:80]


def _cache_path(key: str) -> Path:
    short = _slug(key)
    digest = hashlib.md5(key.encode()).hexdigest()[:8]
    return CACHE_DIR / f"{short}_{digest}.json"


def _load_cache(key: str):
    p = _cache_path(key)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return None


def _save_cache(key: str, data) -> None:
    _cache_path(key).write_text(json.dumps(data, ensure_ascii=False))


def _strip_american_friends(name: str) -> Optional[str]:
    """Return the underlying org name for 'American Friends of X' orgs."""
    patterns = [
        r"^american friends of the\s+",
        r"^american friends of\s+",
        r"^us friends of the\s+",
        r"^us friends of\s+",
        r"^friends of\s+",
    ]
    lower = name.lower()
    for pat in patterns:
        m = re.match(pat, lower)
        if m:
            return name[m.end():].strip()
    return None


def _normalize_recipient(name: str) -> str:
    """Title-case, strip trailing INC/LLC/CORP."""
    n = re.sub(r"[,.]?\s*(INC|LLC|LTD|CORP|INCORPORATED|LIMITED)\.?\s*$", "", name, flags=re.IGNORECASE).strip()
    # Convert ALL-CAPS to title case
    if n == n.upper():
        n = n.title()
    return n


# ---------------------------------------------------------------------------
# Semantic Scholar
# ---------------------------------------------------------------------------

def _ss_search(session: requests.Session, query: str, cache_key: str) -> list[dict]:
    """Search Semantic Scholar. Returns list of raw paper dicts."""
    cached = _load_cache(f"ss:{cache_key}")
    if cached is not None:
        return cached

    params = {
        "query": query,
        "year": YEAR_RANGE,
        "limit": str(PER_ORG_LIMIT),
        "fields": SS_FIELDS,
    }
    try:
        resp = session.get(SEMANTIC_SCHOLAR_BASE, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json().get("data", [])
        _save_cache(f"ss:{cache_key}", data)
        time.sleep(SS_RATE_SEC)
        return data
    except Exception as exc:
        log.warning("Semantic Scholar error for %r: %s", query, exc)
        time.sleep(SS_RATE_SEC)
        return []


def _ss_paper_to_pub(paper: dict, recipient_name: str) -> Optional[dict]:
    title = (paper.get("title") or "").strip()
    if not title:
        return None

    year = paper.get("year")
    if not year:
        return None

    pub_date = paper.get("publicationDate") or f"{year}-01-01"
    venue = paper.get("venue") or ""

    # Best URL: openAccessPdf → DOI redirect → SS page
    url = ""
    if paper.get("openAccessPdf"):
        url = paper["openAccessPdf"].get("url", "")
    if not url:
        ext = paper.get("externalIds") or {}
        doi = ext.get("DOI")
        if doi:
            url = f"https://doi.org/{doi}"
    if not url:
        pid = paper.get("paperId", "")
        if pid:
            url = f"https://www.semanticscholar.org/paper/{pid}"

    citation_count = paper.get("citationCount")

    pub_id = "pub-" + hashlib.md5(f"{recipient_name}:{title}".encode()).hexdigest()[:12]

    return {
        "id": pub_id,
        "recipient_name": recipient_name,
        "title": title,
        "date": pub_date,
        "year": int(year),
        "venue": venue,
        "url": url,
        "source_api": "semantic_scholar",
        "citation_count": citation_count if isinstance(citation_count, int) else None,
    }


# ---------------------------------------------------------------------------
# Google News RSS
# ---------------------------------------------------------------------------

def _gn_search(session: requests.Session, query: str, cache_key: str) -> "list[dict]":
    """Fetch Google News RSS items. Returns raw parsed items."""
    cached = _load_cache(f"gn:{cache_key}")
    if cached is not None:
        return cached

    params = {
        "q": f'"{query}"',
        "hl": "en-US",
        "gl": "US",
        "ceid": "US:en",
    }
    try:
        resp = session.get(GOOGLE_NEWS_RSS, params=params, timeout=15)
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
        items = []
        for item in root.findall(".//item"):
            title_el = item.find("title")
            link_el = item.find("link")
            pub_date_el = item.find("pubDate")
            source_el = item.find("source")
            if title_el is None or link_el is None:
                continue
            items.append({
                "title": (title_el.text or "").strip(),
                "link": (link_el.text or "").strip(),
                "pubDate": (pub_date_el.text or "").strip() if pub_date_el is not None else "",
                "source": (source_el.text or "").strip() if source_el is not None else "",
            })
        _save_cache(f"gn:{cache_key}", items)
        time.sleep(GN_RATE_SEC)
        return items
    except Exception as exc:
        log.warning("Google News RSS error for %r: %s", query, exc)
        time.sleep(GN_RATE_SEC)
        return []


def _parse_rss_date(date_str: str) -> tuple[str, int]:
    """Parse RFC 2822 pubDate → (ISO date string, year int)."""
    from email.utils import parsedate
    try:
        parts = parsedate(date_str)
        if parts:
            year = parts[0]
            month = parts[1]
            day = parts[2]
            return f"{year:04d}-{month:02d}-{day:02d}", year
    except Exception:
        pass
    # Fallback: extract 4-digit year
    m = re.search(r"\b(20\d{2})\b", date_str)
    if m:
        year = int(m.group(1))
        return f"{year}-01-01", year
    return "2020-01-01", 2020


def _gn_item_to_pub(item: dict, recipient_name: str) -> Optional[dict]:
    title = item.get("title", "").strip()
    if not title:
        return None

    # Strip " - Source Name" suffix that Google News appends
    title = re.sub(r"\s+-\s+[^-]{3,60}$", "", title).strip()

    url = item.get("link", "").strip()
    pub_date, year = _parse_rss_date(item.get("pubDate", ""))

    # Only keep results within our range
    if year < 2019 or year > 2025:
        return None

    venue = item.get("source", "")
    pub_id = "pub-" + hashlib.md5(f"{recipient_name}:{title}".encode()).hexdigest()[:12]

    return {
        "id": pub_id,
        "recipient_name": recipient_name,
        "title": title,
        "date": pub_date,
        "year": year,
        "venue": venue,
        "url": url,
        "source_api": "google_news",
        "citation_count": None,
    }


# ---------------------------------------------------------------------------
# Per-org fetch orchestration
# ---------------------------------------------------------------------------

def _fetch_org(session: requests.Session, canonical_name: str, grant_name: str) -> list[dict]:
    """
    Try Semantic Scholar first. Fall back to Google News if < SS_THRESHOLD results.
    For 'American Friends of X', also try the underlying org name.
    Returns deduplicated list of publication dicts.
    """
    search_names = [canonical_name]
    underlying = _strip_american_friends(canonical_name)
    if underlying:
        search_names.append(underlying)

    pubs: list[dict] = []
    seen_titles: set[str] = set()

    def _dedup(new_pubs: list[dict]) -> list[dict]:
        result = []
        for p in new_pubs:
            key = p["title"].lower()[:80]
            if key not in seen_titles:
                seen_titles.add(key)
                result.append(p)
        return result

    for search_name in search_names:
        slug = _slug(search_name)

        # --- Semantic Scholar ---
        ss_raw = _ss_search(session, search_name, slug)
        ss_pubs = [p for paper in ss_raw if (p := _ss_paper_to_pub(paper, grant_name)) is not None]
        pubs.extend(_dedup(ss_pubs))

        if len(pubs) >= SS_THRESHOLD:
            break  # got enough from SS; skip GN

        # --- Google News RSS fallback ---
        log.info("  SS thin (%d results) → Google News for %r", len(pubs), search_name)
        gn_raw = _gn_search(session, search_name, slug)
        gn_pubs = [p for item in gn_raw if (p := _gn_item_to_pub(item, grant_name)) is not None]
        pubs.extend(_dedup(gn_pubs))

        if pubs:
            break  # found something from GN; no need to try underlying org via GN again

    return pubs


# ---------------------------------------------------------------------------
# Top-30 recipient selection
# ---------------------------------------------------------------------------

def _get_top30_recipients() -> list[tuple[str, str]]:
    """
    Returns list of (canonical_name, grant_name) for top 30 US recipients
    by total grant volume, after deduplication by normalized name.
    """
    grants = json.loads((DATA_DIR / "grants.json").read_text())

    def _normalize_key(name: str) -> str:
        n = re.sub(r"[^a-z0-9 ]+", " ", name.lower())
        n = re.sub(r"\b(inc|llc|ltd|corp|incorporated|limited)\b", "", n)
        return re.sub(r"\s+", " ", n).strip()

    totals: dict[str, float] = defaultdict(float)
    first_seen: dict[str, str] = {}

    for g in grants:
        if g.get("recipient_country") != "US":
            continue
        key = _normalize_key(g["recipient_name"])
        totals[key] += g["amount"]
        if key not in first_seen:
            first_seen[key] = g["recipient_name"]

    top30 = sorted(totals.items(), key=lambda x: -x[1])[:30]
    return [(first_seen[k], _normalize_recipient(first_seen[k])) for k, _ in top30]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    recipients = _get_top30_recipients()
    log.info("Processing top %d recipients", len(recipients))

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    all_pubs: list[dict] = []
    ss_total = 0
    gn_total = 0
    per_org: dict[str, int] = {}

    for i, (grant_name, canonical_name) in enumerate(recipients, 1):
        log.info("[%d/%d] %s", i, len(recipients), canonical_name)
        pubs = _fetch_org(session, canonical_name, grant_name)

        ss_count = sum(1 for p in pubs if p["source_api"] == "semantic_scholar")
        gn_count = sum(1 for p in pubs if p["source_api"] == "google_news")
        ss_total += ss_count
        gn_total += gn_count

        per_org[canonical_name] = len(pubs)
        log.info("  → %d pubs (SS=%d, GN=%d)", len(pubs), ss_count, gn_count)

        all_pubs.extend(pubs)

    # Global title dedup across orgs
    seen: set[str] = set()
    deduped: list[dict] = []
    for p in all_pubs:
        key = p["title"].lower()[:80]
        if key not in seen:
            seen.add(key)
            deduped.append(p)

    OUTPUT_FILE.write_text(json.dumps(deduped, indent=2, ensure_ascii=False))

    log.info("=" * 60)
    log.info("SUMMARY")
    log.info("  Total publications : %d", len(deduped))
    log.info("  Semantic Scholar   : %d", ss_total)
    log.info("  Google News RSS    : %d", gn_total)
    log.info("")
    log.info("  Top orgs by publication count:")
    for org, count in sorted(per_org.items(), key=lambda x: -x[1])[:15]:
        log.info("    %-52s %d", org, count)
    log.info("=" * 60)
    log.info("Wrote %s (%d records)", OUTPUT_FILE, len(deduped))


if __name__ == "__main__":
    main()
