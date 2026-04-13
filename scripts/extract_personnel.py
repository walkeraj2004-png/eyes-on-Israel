"""
extract_personnel.py — Part VII officer/director/trustee extraction.

Phase 1 (fast, all cached):  Foundation XMLs already on disk.
Phase 2 (slow first run):    ProPublica search for recipient EINs,
                              download 990 XMLs, extract Part VII.

Outputs:
  data/personnel.json    — every parsed personnel record
  data/connections.json  — people appearing in 2+ distinct organisations
"""

from __future__ import annotations

import json
import logging
import pathlib
import re
import sys
import time
from collections import defaultdict
from typing import Any

import requests
from lxml import etree
from thefuzz import fuzz

# ---------------------------------------------------------------------------
# Import TEOS utilities from main ingest script
# ---------------------------------------------------------------------------
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from ingest_990s import (  # noqa: E402
    RateLimitedSession,
    USER_AGENT,
    TEOS_BASE,
    TEOS_YEARS,
    TEOS_BATCH_FALLBACKS,
    extract_xml_from_zip,
    fetch_xml_from_teos,
    format_ein,
)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = pathlib.Path(__file__).parent.parent
DATA_DIR = ROOT / "data"
RAW_XML_DIR = DATA_DIR / "raw" / "irs_990pf_xml"
FOUNDATIONS_PATH = DATA_DIR / "foundations.json"
PERSONNEL_PATH = DATA_DIR / "personnel.json"
CONNECTIONS_PATH = DATA_DIR / "connections.json"

PROPUBLICA_CACHE_DIR = DATA_DIR / "raw" / "propublica_recipient_cache"
RECIPIENT_XML_DIR = DATA_DIR / "raw" / "recipient_xml"
TEOS_RECIPIENT_CACHE = DATA_DIR / "raw" / "teos_recipient_cache.json"

API_BASE = "https://projects.propublica.org/nonprofits/api/v2"
IRS_NS = {"irs": "http://www.irs.gov/efile"}

PHASE1_FUZZY_THRESHOLD = 93   # cross-org person matching (both phases)
PHASE2_SEARCH_THRESHOLD = 85  # ProPublica org name match

# ---------------------------------------------------------------------------
# Name normalisation
# ---------------------------------------------------------------------------
_SUFFIX_RE = re.compile(
    r"\b(jr\.?|sr\.?|ii|iii|iv|v|md\.?|ph\.?d\.?|esq\.?|cpa\.?|jd\.?|llm\.?)\b",
    re.IGNORECASE,
)
_WS_RE = re.compile(r"\s+")


def strip_suffixes(name: str) -> str:
    return _WS_RE.sub(" ", _SUFFIX_RE.sub(" ", name)).strip()


def make_match_key(name: str) -> str:
    cleaned = strip_suffixes(name).lower()
    tokens = cleaned.split()
    if len(tokens) > 2:
        tokens = [tokens[0]] + [t for t in tokens[1:-1] if len(t) > 1] + [tokens[-1]]
    return " ".join(tokens)


def normalise_name(raw: str) -> str:
    return " ".join(raw.strip().title().split())


def normalise_for_dedup(name: str) -> str:
    return _WS_RE.sub(" ", name.strip().lower())


# ---------------------------------------------------------------------------
# XML helpers
# ---------------------------------------------------------------------------
def _find(el: etree._Element, *tags: str) -> str:
    for tag in tags:
        for candidate in (f"irs:{tag}", tag, f".//irs:{tag}", f".//{tag}"):
            try:
                found = el.find(candidate, IRS_NS)
            except Exception:
                found = None
            if found is not None and found.text and found.text.strip():
                return found.text.strip()
    return ""


def _find_all(root: etree._Element, tag: str) -> list[etree._Element]:
    for candidate in (f".//irs:{tag}", f".//{tag}"):
        try:
            results = root.findall(candidate, IRS_NS)
        except Exception:
            results = []
        if results:
            return results
    return []


# ---------------------------------------------------------------------------
# Core XML extraction  (shared by both phases)
# ---------------------------------------------------------------------------
def extract_personnel_from_xml_bytes(
    xml_bytes: bytes,
    organization_name: str,
    organization_ein: str,
    filing_url: str,
    org_type: str,
    tax_year: int,
) -> list[dict[str, Any]]:
    try:
        parser = etree.XMLParser(recover=True, huge_tree=True)
        root = etree.fromstring(xml_bytes, parser)
    except Exception as exc:
        logging.warning("XML parse error for %s: %s", organization_name, exc)
        return []

    records: list[dict[str, Any]] = []

    # 990-PF: OfficerDirTrstKeyEmplGrp
    for entry in _find_all(root, "OfficerDirTrstKeyEmplGrp"):
        person_nm = _find(entry, "PersonNm") or _find(entry, "BusinessNameLine1Txt")
        if not person_nm:
            continue
        title = _find(entry, "TitleTxt", "Title")
        comp_raw = _find(entry, "CompensationAmt", "Compensation")
        hours_raw = _find(entry, "AverageHrsPerWkDevotedToPosRt", "AverageHoursPerWeek")
        records.append(_make_record(person_nm, title, comp_raw, hours_raw,
                                    organization_name, organization_ein, org_type,
                                    tax_year, filing_url))

    # 990 (regular): Form990PartVIISectionAGrp
    for entry in _find_all(root, "Form990PartVIISectionAGrp"):
        person_nm = _find(entry, "PersonNm")
        if not person_nm:
            continue
        title = _find(entry, "TitleTxt", "Title")
        # 990 uses ReportableCompFromOrgAmt for W-2 wages
        comp_raw = (
            _find(entry, "ReportableCompFromOrgAmt")
            or _find(entry, "CompensationAmt", "Compensation")
        )
        hours_raw = _find(entry, "AverageHoursPerWeekRt", "AverageHrsPerWkDevotedToPosRt",
                          "AverageHoursPerWeek")
        records.append(_make_record(person_nm, title, comp_raw, hours_raw,
                                    organization_name, organization_ein, org_type,
                                    tax_year, filing_url))

    return records


def _make_record(
    person_nm: str, title: str, comp_raw: str, hours_raw: str,
    org_name: str, org_ein: str, org_type: str, tax_year: int, filing_url: str,
) -> dict[str, Any]:
    try:
        compensation: float | None = float(comp_raw) if comp_raw else None
    except ValueError:
        compensation = None
    try:
        avg_hours: float | None = float(hours_raw) if hours_raw else None
    except ValueError:
        avg_hours = None
    display_name = normalise_name(person_nm)
    return {
        "person_name": display_name,
        "match_key": make_match_key(person_nm),
        "title": title,
        "organization_name": org_name,
        "organization_ein": org_ein,
        "organization_type": org_type,
        "tax_year": tax_year,
        "compensation": compensation,
        "average_hours_per_week": avg_hours,
        "filing_url": filing_url,
    }


# ---------------------------------------------------------------------------
# Phase 1 — foundation XMLs
# ---------------------------------------------------------------------------
def run_phase1(foundations: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, dict[str, int]]]:
    ein_to_foundation = {
        f["ein"].replace("-", ""): (f["name"], f["ein"]) for f in foundations
    }
    all_personnel: list[dict[str, Any]] = []
    org_stats: dict[str, dict[str, int]] = {}

    for ein_dir in sorted(RAW_XML_DIR.iterdir()):
        if not ein_dir.is_dir():
            continue
        ein_digits = ein_dir.name
        info = ein_to_foundation.get(ein_digits)
        if not info:
            logging.warning("No foundation record for EIN dir %s — skipping", ein_digits)
            continue
        org_name, org_ein = info
        files_parsed = records_found = 0

        for xml_path in sorted(ein_dir.glob("*.xml")):
            url_path = xml_path.with_suffix(".url")
            filing_url = url_path.read_text(encoding="utf-8").strip() if url_path.exists() else ""
            try:
                tax_year = int(xml_path.stem[:4])
            except ValueError:
                tax_year = 0

            recs = extract_personnel_from_xml_bytes(
                xml_path.read_bytes(), org_name, org_ein, filing_url, "foundation", tax_year
            )
            files_parsed += 1
            records_found += len(recs)
            all_personnel.extend(recs)
            logging.info("  %s / %s  →  %d personnel", org_name, xml_path.name, len(recs))

        org_stats[org_ein] = {"files": files_parsed, "records": records_found}

    return all_personnel, org_stats


# ---------------------------------------------------------------------------
# Phase 2 — recipient ProPublica lookup
# ---------------------------------------------------------------------------
def _pp_search(session: RateLimitedSession, query: str) -> dict[str, Any] | None:
    """Search ProPublica for one org name. Returns {"ein", "name", "score"} or None. Cached."""
    slug = re.sub(r"[^a-z0-9]+", "_", query.lower())[:90]
    cache = PROPUBLICA_CACHE_DIR / f"search_{slug}.json"
    if cache.exists():
        raw = cache.read_text(encoding="utf-8")
        return None if raw.strip() == "null" else json.loads(raw)

    url = f"{API_BASE}/search.json?q={requests.utils.quote(query)}"
    try:
        resp = session.get(url)
        data = resp.json()
    except Exception as exc:
        logging.debug("PP search error %r: %s", query, exc)
        cache.write_text("null", encoding="utf-8")
        return None

    orgs = data.get("organizations") or []
    best: dict[str, Any] | None = None
    best_score = 0
    for org in orgs[:10]:
        score = fuzz.token_sort_ratio(query.lower(), (org.get("name") or "").lower())
        if score > best_score:
            best_score = score
            best = org

    if best and best_score >= PHASE2_SEARCH_THRESHOLD:
        result: dict[str, Any] = {
            "ein": str(best.get("ein", "")).zfill(9),
            "name": best.get("name", ""),
            "score": best_score,
        }
        cache.write_text(json.dumps(result), encoding="utf-8")
        return result

    cache.write_text("null", encoding="utf-8")
    return None


def _pp_filings(session: RateLimitedSession, ein_digits: str) -> list[dict[str, Any]]:
    """Get filings_with_data for an EIN from ProPublica. Cached."""
    cache = PROPUBLICA_CACHE_DIR / f"org_{ein_digits}.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8")) or []

    url = f"{API_BASE}/organizations/{ein_digits}.json"
    try:
        resp = session.get(url)
        data = resp.json()
    except Exception as exc:
        logging.debug("PP org error EIN %s: %s", ein_digits, exc)
        cache.write_text("[]", encoding="utf-8")
        return []

    filings = data.get("filings_with_data") or []
    cache.write_text(json.dumps(filings), encoding="utf-8")
    return filings


def _pick_filing(filings: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Most recent filing that has an xml_url."""
    with_xml = [f for f in filings if f.get("xml_url")]
    if not with_xml:
        return None
    return max(with_xml, key=lambda f: int(str(f.get("tax_prd") or f.get("tax_period") or 0)))


def _fetch_and_cache_xml(
    http_session: requests.Session,
    xml_url: str,
    ein_digits: str,
    tax_prd: str,
) -> bytes | None:
    cache_dir = RECIPIENT_XML_DIR / ein_digits
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{tax_prd}.xml"
    if cache_file.exists():
        return cache_file.read_bytes()
    try:
        r = http_session.get(xml_url, timeout=60)
        r.raise_for_status()
        cache_file.write_bytes(r.content)
        return r.content
    except Exception as exc:
        logging.debug("XML download failed %s: %s", xml_url, exc)
        return None


def _teos_filing_map_for_eins(
    http_session: requests.Session,
    ein_set: set[str],
) -> dict[str, list[dict[str, Any]]]:
    """
    Scan TEOS index CSVs for the given EINs, accepting any return type.
    Caches to TEOS_RECIPIENT_CACHE. Only returns the most recent filing per EIN.
    """
    # Load existing cache
    cached: dict[str, list[dict[str, Any]]] = {}
    if TEOS_RECIPIENT_CACHE.exists():
        cached = json.loads(TEOS_RECIPIENT_CACHE.read_text(encoding="utf-8"))

    uncached = {e for e in ein_set if e not in cached}
    if not uncached:
        return {e: cached[e] for e in ein_set if e in cached and cached[e]}

    logging.info("TEOS scan: searching for %d uncached recipient EINs", len(uncached))
    new_results: dict[str, list[dict[str, Any]]] = {}

    for year in TEOS_YEARS:
        url = f"{TEOS_BASE}/{year}/index_{year}.csv"
        logging.info("  Scanning TEOS %d index (%d EINs remaining)...", year, len(uncached))
        try:
            r = http_session.get(url, timeout=180, stream=True)
            r.raise_for_status()
        except Exception as exc:
            logging.warning("  TEOS %d index unavailable: %s", year, exc)
            continue

        headers: list[str] | None = None
        found = 0
        for raw_line in r.iter_lines():
            line = raw_line.decode("utf-8", errors="replace")
            if headers is None:
                headers = [h.strip() for h in line.split(",")]
                continue
            parts = line.split(",")
            if len(parts) < len(headers):
                continue
            row = dict(zip(headers, parts))
            return_type = row.get("RETURN_TYPE", "").strip()
            if return_type not in ("990", "990EZ", "990PF", "990EO"):
                continue
            ein = row.get("EIN", "").strip().zfill(9)
            if ein not in uncached:
                continue
            new_results.setdefault(ein, []).append({
                "index_year": year,
                "tax_period": row.get("TAX_PERIOD", "").strip(),
                "object_id": row.get("OBJECT_ID", "").strip(),
                "xml_batch_id": row.get("XML_BATCH_ID", "").strip(),
            })
            found += 1
        r.close()
        logging.info("  → %d filings found in %d index", found, year)

    # Keep only the most recent filing per EIN
    for ein, entries in new_results.items():
        new_results[ein] = sorted(entries, key=lambda e: e.get("tax_period", ""), reverse=True)[:1]

    # Persist cache
    all_cached = {**cached, **new_results}
    TEOS_RECIPIENT_CACHE.write_text(json.dumps(all_cached, indent=2), encoding="utf-8")

    return {e: all_cached.get(e, []) for e in ein_set if all_cached.get(e)}


def run_phase2(api_session: RateLimitedSession) -> list[dict[str, Any]]:
    """
    Phase 2: find EINs for US-based grantees via ProPublica,
    download their 990 XMLs, extract Part VII personnel.
    """
    PROPUBLICA_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    RECIPIENT_XML_DIR.mkdir(parents=True, exist_ok=True)

    grants = json.loads((DATA_DIR / "grants.json").read_text(encoding="utf-8"))

    # Deduplicate by normalised name; keep longest canonical version
    name_map: dict[str, str] = {}
    for g in grants:
        if g.get("recipient_country") != "US":
            continue
        raw = (g.get("recipient_name") or "").strip()
        if not raw:
            continue
        norm = normalise_for_dedup(raw)
        if norm not in name_map or len(raw) > len(name_map[norm]):
            name_map[norm] = raw

    unique_names = sorted(name_map.values())
    logging.info("Phase 2 start: %d unique US recipient names", len(unique_names))

    # -------------------------
    # Step A: ProPublica search
    # -------------------------
    found_eins: dict[str, tuple[str, str]] = {}   # ein_digits → (canonical_name, org_name_from_pp)
    pp_found = 0
    for idx, org_name in enumerate(unique_names, 1):
        if idx % 50 == 0 or idx == len(unique_names):
            logging.info("  ProPublica search %d / %d  (found so far: %d)", idx, len(unique_names), pp_found)
        match = _pp_search(api_session, org_name)
        if match:
            ein_d = match["ein"].replace("-", "").zfill(9)
            found_eins[ein_d] = (org_name, match["name"])
            pp_found += 1

    logging.info("ProPublica search complete: %d / %d orgs matched", pp_found, len(unique_names))

    # -------------------------
    # Step B: Get filings (ProPublica org endpoint)
    # -------------------------
    http_session = requests.Session()
    http_session.headers.update({"User-Agent": USER_AGENT})

    filing_map: dict[str, dict[str, Any]] = {}  # ein_digits → filing dict
    pp_with_xml = 0
    for idx, (ein_d, (canonical_name, pp_name)) in enumerate(found_eins.items(), 1):
        if idx % 50 == 0 or idx == len(found_eins):
            logging.info("  Org filings lookup %d / %d  (with XML: %d)", idx, len(found_eins), pp_with_xml)
        filings = _pp_filings(api_session, ein_d)
        best = _pick_filing(filings)
        if best:
            filing_map[ein_d] = best
            pp_with_xml += 1

    logging.info("Org filings complete: %d / %d have ProPublica XML URLs", pp_with_xml, len(found_eins))

    # -------------------------
    # Step C: TEOS fallback for EINs without ProPublica XML
    # -------------------------
    no_pp_xml = {e for e in found_eins if e not in filing_map}
    teos_map: dict[str, list[dict[str, Any]]] = {}
    if no_pp_xml:
        logging.info("TEOS fallback for %d EINs without ProPublica XML", len(no_pp_xml))
        teos_map = _teos_filing_map_for_eins(http_session, no_pp_xml)
        logging.info("TEOS found filings for %d / %d orgs", len(teos_map), len(no_pp_xml))

    # -------------------------
    # Step D: Download XMLs and extract Part VII
    # -------------------------
    all_phase2: list[dict[str, Any]] = []
    xml_downloaded = 0
    part7_parsed = 0
    teos_cd_cache: dict[str, bytes] = {}

    for ein_d, (canonical_name, pp_name) in found_eins.items():
        org_display = pp_name or canonical_name

        # Determine XML source
        if ein_d in filing_map:
            filing = filing_map[ein_d]
            xml_url = filing.get("xml_url", "")
            tax_prd = str(filing.get("tax_prd") or filing.get("tax_period") or "unknown")
            filing_url = filing.get("pdf_url") or xml_url or ""
            try:
                tax_year = int(tax_prd[:4])
            except (ValueError, TypeError):
                tax_year = 0

            xml_bytes = _fetch_and_cache_xml(http_session, xml_url, ein_d, tax_prd)

        elif ein_d in teos_map and teos_map[ein_d]:
            irs_entry = teos_map[ein_d][0]
            cache_dir = RECIPIENT_XML_DIR / ein_d
            cache_dir.mkdir(parents=True, exist_ok=True)
            tp = irs_entry.get("tax_period", "unknown")
            oid = irs_entry.get("object_id", "")
            cache_file = cache_dir / f"{tp}-{oid}.xml"
            url_sidecar = cache_file.with_suffix(".url")

            if cache_file.exists():
                xml_bytes = cache_file.read_bytes()
                filing_url = url_sidecar.read_text().strip() if url_sidecar.exists() else ""
            else:
                xml_bytes = fetch_xml_from_teos(http_session, irs_entry, teos_cd_cache)
                if xml_bytes:
                    cache_file.write_bytes(xml_bytes)
                    if "_resolved_zip_url" in irs_entry:
                        url_sidecar.write_text(irs_entry["_resolved_zip_url"])
                        filing_url = irs_entry["_resolved_zip_url"]
                    else:
                        filing_url = ""
                else:
                    filing_url = ""

            try:
                tax_year = int(tp[:4])
            except (ValueError, TypeError):
                tax_year = 0
        else:
            continue

        if not xml_bytes:
            continue

        xml_downloaded += 1
        recs = extract_personnel_from_xml_bytes(
            xml_bytes, org_display, format_ein(ein_d), filing_url, "recipient", tax_year
        )
        if recs:
            part7_parsed += 1
            all_phase2.extend(recs)

    logging.info(
        "Phase 2 XML: downloaded=%d  Part VII found=%d  personnel records=%d",
        xml_downloaded, part7_parsed, len(all_phase2),
    )
    return all_phase2


# ---------------------------------------------------------------------------
# Cross-org connection matching
# ---------------------------------------------------------------------------
def build_connections(personnel: list[dict[str, Any]]) -> list[dict[str, Any]]:
    all_keys = list({r["match_key"] for r in personnel if r["match_key"]})
    canonical: dict[str, str] = {}
    for key in all_keys:
        matched = False
        for canon in list(canonical):
            if fuzz.ratio(key, canon) >= PHASE1_FUZZY_THRESHOLD:
                canonical[key] = canonical[canon]
                matched = True
                break
        if not matched:
            canonical[key] = key

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for rec in personnel:
        mk = rec.get("match_key", "")
        if mk:
            groups[canonical.get(mk, mk)].append(rec)

    connections: list[dict[str, Any]] = []
    for canon_key, records in groups.items():
        distinct_eins = {r["organization_ein"] for r in records}
        if len(distinct_eins) < 2:
            continue

        best_name = max((r["person_name"] for r in records), key=len)
        seen_roles: set[tuple[str, int, str]] = set()
        roles: list[dict[str, Any]] = []
        for r in sorted(records, key=lambda x: (x["organization_name"], x["tax_year"])):
            role_key = (r["organization_ein"], r["tax_year"], r["title"])
            if role_key in seen_roles:
                continue
            seen_roles.add(role_key)
            roles.append({
                "organization_name": r["organization_name"],
                "organization_ein": r["organization_ein"],
                "organization_type": r["organization_type"],
                "title": r["title"],
                "tax_year": r["tax_year"],
                "compensation": r["compensation"],
                "filing_url": r["filing_url"],
            })

        connections.append({
            "person_name": best_name,
            "match_key": canon_key,
            "organization_count": len(distinct_eins),
            "roles": roles,
        })

    return sorted(connections, key=lambda c: (-c["organization_count"], c["person_name"]))


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    configure_logging()

    foundations = json.loads(FOUNDATIONS_PATH.read_text(encoding="utf-8"))
    ein_to_foundation = {f["ein"].replace("-", ""): (f["name"], f["ein"]) for f in foundations}

    # ── Phase 1: foundation XMLs ──────────────────────────────────────────
    logging.info("=== Phase 1: foundation XML extraction ===")
    phase1_personnel, org_stats = run_phase1(foundations)

    # ── Phase 2: recipient ProPublica lookup ─────────────────────────────
    logging.info("=== Phase 2: recipient lookup ===")
    api_session = RateLimitedSession(rate_limit_seconds=1.0, timeout=30)
    phase2_personnel = run_phase2(api_session)

    # ── Combine and dedup ────────────────────────────────────────────────
    all_personnel = phase1_personnel + phase2_personnel
    seen: set[tuple[str, str, int, str]] = set()
    deduped: list[dict[str, Any]] = []
    for r in all_personnel:
        key = (r["match_key"], r["organization_ein"], r["tax_year"], r["title"])
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    all_personnel = deduped

    connections = build_connections(all_personnel)

    # ── Write outputs ────────────────────────────────────────────────────
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PERSONNEL_PATH.write_text(
        json.dumps(all_personnel, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    CONNECTIONS_PATH.write_text(
        json.dumps(connections, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )

    # ── Summary ───────────────────────────────────────────────────────────
    unique_people = len({r["match_key"] for r in all_personnel})
    p1_people = len({r["match_key"] for r in phase1_personnel})
    p2_people = len({r["match_key"] for r in phase2_personnel})

    logging.info("=" * 65)
    logging.info("FINAL SUMMARY")
    logging.info("  Phase 1 records  : %d  (%d unique people, 8 foundations)",
                 len(phase1_personnel), p1_people)
    logging.info("  Phase 2 records  : %d  (%d unique people, recipient orgs)",
                 len(phase2_personnel), p2_people)
    logging.info("  Combined (deduped): %d records, %d unique people",
                 len(all_personnel), unique_people)
    logging.info("  Cross-org matches: %d", len(connections))
    logging.info("")

    if connections:
        logging.info("  HIGH-SIGNAL: people bridging foundation ↔ recipient")
        for conn in connections:
            orgs = sorted({r["organization_name"] for r in conn["roles"]})
            org_types = {r["organization_type"] for r in conn["roles"]}
            bridge = "★ FOUNDATION↔RECIPIENT" if "foundation" in org_types and "recipient" in org_types else ""
            logging.info("  %s %-42s  (%d orgs: %s) %s",
                         "→" if bridge else " ",
                         conn["person_name"],
                         conn["organization_count"],
                         ", ".join(orgs[:3]) + ("…" if len(orgs) > 3 else ""),
                         bridge)
    else:
        logging.info("  No cross-org connections found.")

    logging.info("")
    logging.info("  Per-foundation stats:")
    for ein, stats in sorted(org_stats.items()):
        name = ein_to_foundation.get(ein.replace("-", ""), (ein, ""))[0]
        logging.info("    %-50s  files=%d  records=%d", name, stats["files"], stats["records"])
    logging.info("=" * 65)
    logging.info("Wrote %s  (%d records)", PERSONNEL_PATH, len(all_personnel))
    logging.info("Wrote %s  (%d connections)", CONNECTIONS_PATH, len(connections))


if __name__ == "__main__":
    main()
