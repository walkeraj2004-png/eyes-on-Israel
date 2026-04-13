#!/usr/bin/env python3
"""
Extract grant data from Charles and Lynn Schusterman Family Foundation 990-PF PDFs.

Schusterman files their complete grant schedule as a PDF attachment rather than
itemized XML. This script OCRs the PDFs and merges Israel-related grants into
the main dataset.

USAGE:
    python3 scripts/extract_schusterman.py [--year YEAR] [--all] [--merge]

MANUAL DOWNLOAD REQUIRED (ProPublica protected by Cloudflare):
    1. Go to https://projects.propublica.org/nonprofits/organizations/731312965
    2. For each filing year, click the row → click the PDF download button
       (the actual IRS filing PDF, NOT the "Full Filing" HTML view)
    3. Save to:
       data/cache/schusterman_2020.pdf
       data/cache/schusterman_2021.pdf
       data/cache/schusterman_2022.pdf
       data/cache/schusterman_2023.pdf
       data/cache/schusterman_2024.pdf

MECHANISM TAGS:
    directed        — explicit Israel purpose text in the grant record
    israel_adjacent — general/operating support to multi-program Jewish orgs
                      with significant Israel programming (BBYO, Hillel, etc.)
    general         — general support to explicitly Israel-focused org
    unclear         — purpose text too brief to classify
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import fitz  # pymupdf
import pytesseract
from PIL import Image

try:
    from thefuzz import fuzz
    HAS_FUZZ = True
except ImportError:
    HAS_FUZZ = False

# ── Paths ────────────────────────────────────────────────────────────────────
ROOT          = Path(__file__).resolve().parents[1]
DATA_DIR      = ROOT / "data"
CACHE_DIR     = DATA_DIR / "cache"
OUT_PATH      = DATA_DIR / "schusterman_grants.json"
GRANTS_PATH   = DATA_DIR / "grants.json"
FOUNDATIONS_PATH = DATA_DIR / "foundations.json"

FUNDER_EIN    = "73-1312965"
FUNDER_NAME   = "Charles And Lynn Schusterman Family Foundation"
FOUNDATION_ID = "charles-and-lynn-schusterman-family-foundation"

# Actual filenames as saved (may differ from canonical schusterman_YYYY.pdf)
PDF_FILENAMES: dict[int, str] = {
    2021: "real 2021 990-PF.pdf",
    2022: "schusterman_2022.pdf",
    2023: "schusterman_2023.pdf",
}

# ProPublica PDF URLs (for provenance)
FILING_URLS: dict[int, str] = {
    2020: "https://projects.propublica.org/nonprofits/download-filing?path=download990pdf_02_2022_prefixes_68-74%2F731312965_202012_990PF_2022021617706329.pdf",
    2021: "https://projects.propublica.org/nonprofits/download-filing?path=download990pdf_05_2023_prefixes_68-74%2F731312965_202112_990PF_2023050521159517.pdf",
    2022: "https://projects.propublica.org/nonprofits/download-filing?path=download990pdf_12_2023_prefixes_72-74%2F731312965_202212_990PF_2023121922136330.pdf",
    2023: "https://projects.propublica.org/nonprofits/download-filing?path=download990pdf_11_2024_prefixes_72-74%2F731312965_202312_990PF_2024113379349102483.pdf",
    2024: "https://projects.propublica.org/nonprofits/download-filing?path=download990pdf_05_2025_prefixes_68-74%2F731312965_202412_990PF_2025051879349100141.pdf",
}

# ── Israel-adjacent orgs ─────────────────────────────────────────────────────
# Multi-program Jewish organizations with significant Israel programming.
# General/operating support grants to these orgs are tagged "israel_adjacent"
# rather than "directed" — they fund Jewish community work broadly, not
# exclusively Israel programming.
ISRAEL_ADJACENT_ORGS: list[str] = [
    "BBYO",
    "Hillel",
    "Jewish Federations of North America",
    "Jewish Federation",
    "Moishe House",
    "Birthright Israel Foundation",
    "Jewish Agency for Israel",
    "Tulsa Jewish Community Council",
    "B'nai B'rith",
    "Bnai Brith",
]

def _adjacent_pattern() -> re.Pattern:
    parts = [re.escape(o) for o in ISRAEL_ADJACENT_ORGS]
    return re.compile("|".join(parts), re.IGNORECASE)

_ADJACENT_PAT = _adjacent_pattern()

# ── Mechanism classifier ──────────────────────────────────────────────────────
_GENERAL_PAT = re.compile(
    r"general support|for general support|to support the exempt purpose"
    r"|core support|operating support|organizational strengthening"
    r"|unrestricted support|annual support|charitable purposes?"
    r"|general char\w*|program support|annual fund"
    r"|operating expenses?|operating purposes?|general operations?"
    r"|general purposes?|general use|public welfare|exempt purposes?"
    r"|community benefit|charitable contribution",
    re.IGNORECASE,
)
_DIRECTED_PAT = re.compile(
    r"\b(programs?|programm\w+|projects?|initiatives?|research|stud(?:y|ies)"
    r"|fellowships?|conferences?|publications?|campaigns?"
    r"|reports?|training|curriculum|exhibits?|exhibitions?"
    r"|scholarships?|scholars|forums?|summits?|workshops?"
    r"|symposia|symposium|institutes?|centers?|grants?)\b",
    re.IGNORECASE,
)

def classify_mechanism(name: str, purpose: str) -> str:
    """
    Extended classifier that adds 'israel_adjacent' for multi-program Jewish orgs.
    """
    # Israel-adjacent check first: if org name matches and purpose is general
    if _ADJACENT_PAT.search(name):
        p = purpose.strip().lower()
        if not p or _GENERAL_PAT.search(p):
            return "israel_adjacent"
        # Even directed-looking purposes for adjacent orgs stay israel_adjacent
        # unless purpose explicitly mentions Israel
        if not re.search(r"\bisrael\b|\bisraeli\b|\bjerusalem\b|\btel.?aviv\b", p, re.IGNORECASE):
            return "israel_adjacent"

    # Standard classifier
    p = purpose.strip()
    if not p:
        return "general"
    pl = p.lower()
    if "matching gift" in pl:
        return "matching"
    if _GENERAL_PAT.search(pl):
        return "general"
    if _DIRECTED_PAT.search(p):
        return "directed"
    if len(p) > 50:
        return "directed"
    return "unclear"


# ── Israel filter ─────────────────────────────────────────────────────────────
ISRAEL_TERMS_RE: list[re.Pattern] = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\bisrael\b", r"\bisraeli\b", r"\bjerusalem\b", r"\btel.?aviv\b",
        r"\bhebrew university\b", r"\btechnion\b", r"\bweizmann\b",
        r"\bben.gurion\b", r"\bbar.ilan\b", r"\bhaifa university\b",
        r"\bjewish agency\b", r"\bjewish national fund\b", r"\bjnf\b",
        r"\bisrael bonds\b", r"\bkeren hayesod\b",
        r"\baipac\b", r"\bj street\b", r"\bstand ?with ?us\b",
        r"\banti.defamation league\b", r"\b(?<!\w)adl(?!\w)\b",
        r"\bamerican jewish committee\b", r"\bamerican jewish congress\b",
        r"\bhillel\b", r"\bbbyo\b",
        r"\bbirthright\b", r"\btaglit\b",
        r"\bnefesh b.nefesh\b",
        r"\bisrael on campus\b",
        r"\bshalom hartman\b", r"\bhartman institute\b",
        r"\bim tirtzu\b", r"\bregavim\b",
        r"\bkohelet\b", r"\binss\b", r"\bbesa center\b",
        r"\bjiss\b", r"\breut institute\b", r"\bjcpa\b",
        r"\bjewish federations?\b", r"\bjewish federation\b",
        r"\bamerican friends of\b",
        r"\bmasa israel\b",
        r"\bnegev\b", r"\bbeersheba\b",
        r"\bmoishe house\b",
        r"\bisrael education\b", r"\bisrael policy\b",
        r"\bisrael on campus\b", r"\bhoneymoon israel\b",
        r"\bwashington institute\b",  # WINEP
        r"\bartis\b",
        r"\bboundless israel\b",
        r"\bembassy of israel\b",
    ]
]

def is_israel_related(name: str, address: str, purpose: str) -> tuple[bool, str]:
    combined = f"{name} {address} {purpose}"
    for pat in ISRAEL_TERMS_RE:
        m = pat.search(combined)
        if m:
            return True, m.group(0).strip()
    return False, ""


# ── PDF OCR ───────────────────────────────────────────────────────────────────
EIN_PAT    = re.compile(r'\b(\d{2}-\d{7})\b')
AMOUNT_PAT = re.compile(r'\$\s*([\d,]+(?:\.\d{2})?)')

def ocr_page(doc: fitz.Document, page_idx: int, dpi: int = 300) -> str:
    page = doc[page_idx]
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat, colorspace=fitz.csGRAY)
    img = Image.frombytes("L", [pix.width, pix.height], pix.samples)
    return pytesseract.image_to_string(img, config="--psm 6")


def find_grant_pages(doc: fitz.Document) -> list[int]:
    """
    Scan at 150 DPI to find pages that look like grant schedule pages.
    A page qualifies if it has ≥1 EIN pattern OR ≥3 dollar amounts.
    """
    grant_pages = []
    for i in range(len(doc)):
        # Check native text layer first (fast)
        native = doc[i].get_text()
        if native.strip():
            text = native
        else:
            text = ocr_page(doc, i, dpi=150)
        has_ein = bool(EIN_PAT.search(text))
        has_amounts = len(AMOUNT_PAT.findall(text)) >= 3
        if has_ein or has_amounts:
            grant_pages.append(i)
    return grant_pages


def parse_amount(s: str) -> int | None:
    clean = re.sub(r"[\$,\s]", "", s).rstrip("0").rstrip(".")
    try:
        v = int(clean.split(".")[0])
        return v if v >= 500 else None
    except ValueError:
        return None


def extract_location(text: str) -> tuple[str, str]:
    """Split 'OrgName CityStateZip' into (location, name)."""
    text = text.strip()
    # "Name, City, ST NNNNN" pattern
    m = re.search(r',\s*([A-Z][a-zA-Z .]+),\s*([A-Z]{2})\s*\d{5}', text)
    if m:
        loc = f"{m.group(1)}, {m.group(2)}"
        name = text[:m.start()].strip().rstrip(',')
        return loc, name
    # "Name City ST" (no comma before state)
    m = re.search(r'\b([A-Z][a-zA-Z .]+)\s+([A-Z]{2})\s+\d{5}', text)
    if m:
        loc = f"{m.group(1)}, {m.group(2)}"
        name = text[:m.start()].strip()
        return loc, name
    # Israel / foreign country
    for country in ["Israel", "Canada", "UK", "Germany", "Australia", "Netherlands"]:
        if country.lower() in text.lower():
            idx = text.lower().find(country.lower())
            return country, text[:idx].strip().rstrip(',')
    return "", text


def parse_grants(all_text: str) -> list[dict]:
    """
    Parse grants from OCR text.  Each entry is bounded by EIN patterns.
    Structure (per entry):
        [EIN]
        [address fragment]  [type code]
        [OrgName]  [city/state]  [purpose]  [$amount]  [Public Charity]
    """
    parts = EIN_PAT.split(all_text)
    grants: list[dict] = []

    i = 1
    while i < len(parts) - 1:
        ein = parts[i]
        block = parts[i + 1] if i + 1 < len(parts) else ""
        i += 2

        lines = [l.strip() for l in block.split('\n') if l.strip()]
        if not lines:
            continue

        # Find amount line
        amount = None
        amount_line_idx = -1
        for j, line in enumerate(lines):
            m = AMOUNT_PAT.search(line)
            if m:
                v = parse_amount(m.group(1))
                if v:
                    amount = v
                    amount_line_idx = j
                    break

        if not amount:
            continue

        amount_line = lines[amount_line_idx]

        # Strip amount, type suffix, bracket artifacts from amount line
        clean = AMOUNT_PAT.sub("", amount_line)
        clean = re.sub(r'\bPublic\s+Charity\b|\b5\d+\(c\)\(\d+\).*$|\]|\|', "", clean, flags=re.IGNORECASE)
        clean = re.sub(r'\s{2,}', '|', clean.strip())

        chunks = [c.strip() for c in clean.split('|') if c.strip()]

        name = ""
        location = ""
        purpose = ""

        if chunks:
            # First chunk = org name; skip chunks that look like zip/state
            name = chunks[0]
            purpose_parts = []
            for chunk in chunks[1:]:
                if re.match(r'^\d{5}', chunk) or re.match(r'^[A-Z]{2}\s*\d{5}', chunk):
                    if not location:
                        location = chunk
                elif re.match(r'^[A-Z]{2}$', chunk):
                    pass  # bare state abbreviation
                else:
                    purpose_parts.append(chunk)
            purpose = " ".join(purpose_parts)

        # Fallback: extract location from address lines before amount line
        if not location:
            addr_lines = [l for l in lines[:amount_line_idx] if not EIN_PAT.match(l)]
            if addr_lines:
                loc_candidate, _ = extract_location(" ".join(addr_lines))
                if loc_candidate:
                    location = loc_candidate

        # Name cleanup
        name = re.sub(r'^[^A-Za-z]+|[^A-Za-z0-9)]+$', '', name).strip()
        if len(name) < 3 or name[0].isdigit():
            # Try last pre-amount non-address line
            for l in reversed(lines[:amount_line_idx]):
                if not EIN_PAT.match(l) and len(l) > 4 and not l[0].isdigit():
                    name = l.strip()
                    break

        if name and amount:
            grants.append({
                "ein": ein,
                "name": name[:100],
                "location": location[:80],
                "purpose": purpose[:200],
                "amount": amount,
            })

    # Filter out OCR artifacts that aren't real grant entries
    _artifact = re.compile(
        r'^Amount\s+of\s+Grant|^Grants\s+and\s+Contributions|^Total\s+Grant'
        r'|^See\s+Attached|^Name\s+of\s+Organization|^Organization\s+Name'
        r'|^Form\s+990|^\d{4}\s*$',
        re.IGNORECASE,
    )
    grants = [g for g in grants if not _artifact.search(g['name'])]

    # Deduplicate on (ein, amount) — catches same entry parsed twice from same page
    seen: set[str] = set()
    unique: list[dict] = []
    for g in grants:
        key = f"{g['ein']}|{g['amount']}"
        if key not in seen:
            seen.add(key)
            unique.append(g)

    return unique


# ── Main per-year processing ──────────────────────────────────────────────────
def process_pdf(pdf_path: Path, year: int) -> dict:
    log = logging.getLogger(__name__)
    log.info(f"Processing {pdf_path.name} (TY {year})")

    doc = fitz.open(str(pdf_path))
    total_pages = len(doc)
    log.info(f"  Total pages: {total_pages} — scanning for grant schedule pages...")

    grant_page_indices = find_grant_pages(doc)
    log.info(f"  Grant pages: {len(grant_page_indices)} "
             f"(pp {[p+1 for p in grant_page_indices[:6]]}{'...' if len(grant_page_indices)>6 else ''})")

    if not grant_page_indices:
        log.warning("  No grant schedule pages found.")
        doc.close()
        return {"year": year, "total_pages": total_pages, "schedule_pages": 0,
                "all_grants": [], "israel_grants": []}

    # OCR grant pages at full resolution
    log.info(f"  OCR-ing {len(grant_page_indices)} pages at 300 DPI...")
    all_text = ""
    for idx in grant_page_indices:
        log.info(f"    page {idx+1}...")
        all_text += ocr_page(doc, idx, dpi=300) + "\n\n"
    doc.close()

    grants = parse_grants(all_text)
    log.info(f"  Parsed {len(grants)} grants  (${sum(g['amount'] for g in grants):,.0f} total)")

    # Filter for Israel-related
    israel_grants: list[dict] = []
    for g in grants:
        match, reason = is_israel_related(g["name"], g["location"], g["purpose"])
        if match:
            gid = hashlib.md5(f"schusterman-{year}-{g['name']}-{g['amount']}".encode()).hexdigest()[:12]
            mechanism = classify_mechanism(g["name"], g["purpose"])
            israel_grants.append({
                "id": f"schusterman-{year}-{gid}",
                "funder_ein": FUNDER_EIN,
                "funder_name": FUNDER_NAME,
                "foundation_id": FOUNDATION_ID,
                "recipient_name": g["name"],
                "recipient_location": g["location"],
                "amount_usd": g["amount"],
                "year": year,
                "purpose": g["purpose"],
                "mechanism": mechanism,
                "filing_url": FILING_URLS.get(year, ""),
                "source": "ocr_pdf",
                "match_reason": reason,
            })

    israel_grants.sort(key=lambda x: -x["amount_usd"])
    log.info(f"  Israel-related: {len(israel_grants)} (${sum(g['amount_usd'] for g in israel_grants):,.0f})")

    if israel_grants:
        for g in israel_grants[:8]:
            log.info(f"    ${g['amount_usd']:>10,}  [{g['mechanism']:16s}]  {g['recipient_name'][:48]}")

    return {
        "year": year,
        "total_pages": total_pages,
        "schedule_pages": len(grant_page_indices),
        "all_grants": grants,
        "israel_grants": israel_grants,
    }


# ── Merge ─────────────────────────────────────────────────────────────────────
def merge_into_main(israel_grants: list[dict]) -> None:
    log = logging.getLogger(__name__)
    if not israel_grants:
        log.info("No Israel grants to merge.")
        return

    # Load existing grants
    existing: list[dict] = json.loads(GRANTS_PATH.read_text()) if GRANTS_PATH.exists() else []
    existing_ids = {g["id"] for g in existing}

    # Map mechanism to grants.json schema (Mechanism type only allows directed/general/matching/unclear)
    MECH_MAP = {
        "directed": "directed",
        "general": "general",
        "unclear": "unclear",
        "matching": "matching",
        "israel_adjacent": "general",  # stored as general in main schema; source="ocr_pdf" preserves distinction
    }

    new_grants: list[dict] = []
    for g in israel_grants:
        if g["id"] in existing_ids:
            continue
        new_grants.append({
            "id": g["id"],
            "funder_ein": g.get("funder_ein", FUNDER_EIN),
            "funder_name": g.get("funder_name", FUNDER_NAME),
            "recipient_name": g["recipient_name"],
            "recipient_country": "US",
            "year": g["year"],
            "tax_period": str(g["year"]),
            "amount": g.get("amount_usd", g.get("amount", 0)),
            "purpose": g["purpose"],
            "mechanism": MECH_MAP.get(g["mechanism"], "general"),
            "filing_url": g["filing_url"],
            "source": "ocr_pdf",
        })

    if new_grants:
        existing.extend(new_grants)
        GRANTS_PATH.write_text(json.dumps(existing, indent=2))
        log.info(f"Added {len(new_grants)} Schusterman grants to grants.json")

    # Update foundations.json
    foundations: list[dict] = json.loads(FOUNDATIONS_PATH.read_text())
    for f in foundations:
        if f.get("ein") == FUNDER_EIN or f.get("id") == FOUNDATION_ID:
            ocr_total = sum(g["amount_usd"] for g in israel_grants)
            ocr_years = sorted({g["year"] for g in israel_grants})
            prev_years = f.get("grant_years", [])
            f["total_granted"] = f.get("total_granted", 0) + ocr_total
            f["grant_years"] = sorted(set(prev_years) | set(ocr_years))
            f["data_source"] = "ocr_pdf"
            f["data_source_note"] = (
                "Israel-related grants extracted via OCR from PDF attachment. "
                "Source: ProPublica 990-PF PDFs. Includes directed (explicit Israel purpose), "
                "israel_adjacent (general support to multi-program Jewish orgs), and general."
            )
            break
    FOUNDATIONS_PATH.write_text(json.dumps(foundations, indent=2))
    log.info("Updated foundations.json")


# ── CLI ───────────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2022)
    parser.add_argument("--all", dest="all_years", action="store_true")
    parser.add_argument("--merge", action="store_true")
    parser.add_argument("--merge-only", action="store_true",
                        help="Skip OCR; merge existing schusterman_grants.json into grants.json")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )
    log = logging.getLogger(__name__)

    # --merge-only: load saved extraction and merge without re-OCR
    if args.merge_only:
        if not OUT_PATH.exists():
            log.error(f"No saved extraction found at {OUT_PATH}. Run extraction first.")
            sys.exit(1)
        raw = json.loads(OUT_PATH.read_text())
        saved = raw.get("israel_grants", raw) if isinstance(raw, dict) else raw
        log.info(f"Loaded {len(saved)} saved Israel grants from {OUT_PATH.name}")
        merge_into_main(saved)
        return

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    years = list(PDF_FILENAMES.keys()) if args.all_years else [args.year]

    reports: list[dict] = []
    all_israel: list[dict] = []

    for year in years:
        filename = PDF_FILENAMES.get(year, f"schusterman_{year}.pdf")
        pdf_path = CACHE_DIR / filename
        if not pdf_path.exists():
            log.warning(
                f"\n{'='*68}\n"
                f"MISSING: {pdf_path}\n"
                f"  Download at: https://projects.propublica.org/nonprofits/organizations/731312965\n"
                f"  Find the {year} 990-PF → download the IRS PDF (not the HTML view)\n"
                f"  Save to: {pdf_path}\n"
                f"{'='*68}"
            )
            continue
        report = process_pdf(pdf_path, year)
        reports.append(report)
        all_israel.extend(report["israel_grants"])

    if not reports:
        log.error("No PDFs processed.")
        sys.exit(1)

    # Save combined output
    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "funder_ein": FUNDER_EIN,
        "funder_name": FUNDER_NAME,
        "years_processed": [r["year"] for r in reports],
        "summary": {
            r["year"]: {
                "total_pages": r["total_pages"],
                "schedule_pages": r["schedule_pages"],
                "grants_parsed": len(r["all_grants"]),
                "israel_count": len(r["israel_grants"]),
                "israel_usd": sum(g["amount_usd"] for g in r["israel_grants"]),
                "by_mechanism": {
                    m: sum(1 for g in r["israel_grants"] if g["mechanism"] == m)
                    for m in ["directed", "general", "israel_adjacent", "unclear"]
                },
            }
            for r in reports
        },
        "israel_grants": all_israel,
    }
    OUT_PATH.write_text(json.dumps(output, indent=2))

    # ── Print summary ──────────────────────────────────────────────────────
    print("\n" + "="*70)
    print("SCHUSTERMAN EXTRACTION SUMMARY")
    print("="*70)
    total_count = sum(len(r["israel_grants"]) for r in reports)
    total_usd   = sum(g["amount_usd"] for g in all_israel)
    print(f"\nAll years combined: {total_count} Israel-related grants  ${total_usd:,.0f}")
    print(f"\nYear-by-year breakdown:")
    for r in reports:
        yr_usd = sum(g["amount_usd"] for g in r["israel_grants"])
        yr_cnt = len(r["israel_grants"])
        mechs  = {}
        for g in r["israel_grants"]:
            mechs[g["mechanism"]] = mechs.get(g["mechanism"], 0) + 1
        mstr = "  ".join(f"{m}:{n}" for m, n in sorted(mechs.items()))
        print(f"  {r['year']}:  {yr_cnt:3d} grants  ${yr_usd:>12,.0f}  [{mstr}]")

    print(f"\nMechanism totals across all years:")
    all_mechs: dict[str, dict] = {}
    for g in all_israel:
        m = g["mechanism"]
        if m not in all_mechs:
            all_mechs[m] = {"count": 0, "usd": 0}
        all_mechs[m]["count"] += 1
        all_mechs[m]["usd"] += g["amount_usd"]
    for m, v in sorted(all_mechs.items()):
        print(f"  {m:20s}: {v['count']:3d} grants  ${v['usd']:>12,.0f}")

    print(f"\nTop 10 Israel grants (all years):")
    for g in sorted(all_israel, key=lambda x: -x["amount_usd"])[:10]:
        print(f"  {g['year']}  ${g['amount_usd']:>10,}  [{g['mechanism']:16s}]  {g['recipient_name'][:50]}")

    print(f"\nOutput: {OUT_PATH}")

    if args.merge:
        print(f"\nMerging {len(all_israel)} grants into grants.json and foundations.json...")
        merge_into_main(all_israel)
        # Verify
        grants_updated = json.loads(GRANTS_PATH.read_text())
        schusterman_in_main = [g for g in grants_updated if g.get("source") == "ocr_pdf"]
        print(f"  grants.json: {len(grants_updated)} total grants ({len(schusterman_in_main)} Schusterman OCR)")
        fnd = next((f for f in json.loads(FOUNDATIONS_PATH.read_text()) if f.get("id") == FOUNDATION_ID), None)
        if fnd:
            print(f"  foundations.json: Schusterman total_granted = ${fnd['total_granted']:,.0f}  years={fnd['grant_years']}")
        print("Merge complete.")
    else:
        print(f"\nTo merge: re-run with --merge")


if __name__ == "__main__":
    main()
