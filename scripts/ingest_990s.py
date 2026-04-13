#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import struct
import sys
import time
import zlib
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

import requests
from lxml import etree
from thefuzz import fuzz


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
RAW_XML_DIR = DATA_DIR / "raw" / "irs_990pf_xml"
FOUNDATIONS_PATH = DATA_DIR / "foundations.json"
GRANTS_PATH = DATA_DIR / "grants.json"
LOG_PATH = DATA_DIR / "ingest_990s.log"

API_BASE = "https://projects.propublica.org/nonprofits/api/v2/organizations"
TEOS_BASE = "https://apps.irs.gov/pub/epostcard/990/xml"
# Years to scan, newest first. 2024/2025 index has XML_BATCH_ID; 2021-2023 does not.
TEOS_YEARS = [2025, 2024, 2023, 2022, 2021]
# For years without XML_BATCH_ID in the index, fall back to these ZIP names (tried in order).
TEOS_BATCH_FALLBACKS: dict[int, list[str]] = {
    2023: [f"2023_TEOS_XML_{n:02d}A" for n in range(12, 0, -1)],
    2022: ["2022_TEOS_XML_01A", "2022_TEOS_XML_02A"],  # 02A exists but isn't on the IRS downloads page
    2021: ["2021_TEOS_XML_01A"],
}
IRS_NS = {"irs": "http://www.irs.gov/efile"}
USER_AGENT = "cross-node-capital-flow-dashboard/0.1 (+https://projects.propublica.org/nonprofits/)"
FUZZY_THRESHOLD = 82

NAME_TARGETS = [
    "Kohelet",
    "INSS",
    "Institute for National Security Studies",
    "BESA Center",
    "JISS",
    "Jerusalem Institute for Strategy",
    "Reut Institute",
    "Jerusalem Center for Public Affairs",
    "JCPA",
]

PURPOSE_KEYWORDS = [
    "Israel",
    "Jerusalem",
    "Tel Aviv",
    "Israeli",
    "Zion",
    "Middle East security",
    "Jewish state",
]

ISRAEL_ADDRESS_TERMS = [
    "ISRAEL",
    "JERUSALEM",
    "TEL AVIV",
    "TEL-AVIV",
    "TELAVIV",
]

FORM_990PF_KEYS = ("formtype", "form_type", "form", "form_name")
TAX_PERIOD_KEYS = ("tax_prd", "tax_period", "tax_period_end", "tax_period_date")
YEAR_KEYS = ("tax_prd_yr", "tax_year", "year")
PDF_URL_KEYS = ("pdf_url", "pdf")
XML_URL_KEYS = ("xml_url", "xml")


@dataclass(frozen=True)
class FoundationSeed:
    name: str
    ein: str

    @property
    def ein_digits(self) -> str:
        return normalize_ein(self.ein)

    @property
    def foundation_id(self) -> str:
        return slugify(self.name)


SEED_FOUNDATIONS = [
    FoundationSeed("Adelson Family Foundation", "04-7024330"),
    FoundationSeed("Marcus Foundation Inc", "58-1815651"),
    FoundationSeed("Koret Foundation", "94-1624987"),
    FoundationSeed("The Tikvah Fund", "13-3676152"),
    FoundationSeed("Charles and Lynn Schusterman Family Foundation", "73-1312965"),
    FoundationSeed("Rockefeller Brothers Fund Inc", "13-1760106"),
    FoundationSeed("Ford Foundation", "13-1684331"),
    FoundationSeed("Open Society Institute", "13-7029285"),
]


class RateLimitedSession:
    def __init__(self, rate_limit_seconds: float, timeout: int) -> None:
        self.rate_limit_seconds = rate_limit_seconds
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json, application/xml;q=0.9"})
        self._last_request_started = 0.0

    def get(self, url: str, *, stream: bool = False) -> requests.Response:
        now = time.monotonic()
        wait_seconds = self.rate_limit_seconds - (now - self._last_request_started)
        if wait_seconds > 0:
            time.sleep(wait_seconds)

        self._last_request_started = time.monotonic()
        response = self.session.get(url, timeout=self.timeout, stream=stream)
        response.raise_for_status()
        return response


def normalize_ein(ein: str) -> str:
    digits = re.sub(r"\D", "", ein)
    if len(digits) != 9:
        raise ValueError(f"Expected 9-digit EIN, got {ein!r}")
    return digits


def format_ein(ein_digits: str) -> str:
    return f"{ein_digits[:2]}-{ein_digits[2:]}"


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return cleaned or "item"


def stable_grant_id(*parts: str) -> str:
    joined = "||".join(parts)
    digest = hashlib.sha1(joined.encode("utf-8")).hexdigest()[:12]
    return f"grant-{digest}"


def configure_logging() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_PATH, mode="w", encoding="utf-8"),
    ]
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=handlers,
    )


def first_present(mapping: dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value not in (None, ""):
            return value
    return None


def load_json(session: RateLimitedSession, url: str) -> dict[str, Any]:
    logging.info("GET %s", url)
    response = session.get(url)
    return response.json()


def extract_org_name(org_payload: dict[str, Any], fallback_name: str) -> str:
    organization = org_payload.get("organization")
    if isinstance(organization, dict):
        for key in ("name", "organization_name", "org_name"):
            value = organization.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

    for key in ("name", "organization_name", "org_name"):
        value = org_payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    return fallback_name


def collect_filing_candidates(org_payload: dict[str, Any], filings_payload: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen_keys: set[str] = set()

    def consume(value: Any) -> None:
        if not isinstance(value, list):
            return
        for item in value:
            if not isinstance(item, dict):
                continue
            dedupe_key = json.dumps(item, sort_keys=True, default=str)
            if dedupe_key in seen_keys:
                continue
            seen_keys.add(dedupe_key)
            candidates.append(item)

    for payload in (filings_payload, org_payload):
        consume(payload.get("filings"))
        consume(payload.get("filings_with_data"))
        consume(payload.get("filings_with_xml"))
        organization = payload.get("organization")
        if isinstance(organization, dict):
            consume(organization.get("filings"))
            consume(organization.get("filings_with_data"))
            consume(organization.get("filings_with_xml"))

    return candidates


def normalize_form_type(filing: dict[str, Any]) -> str:
    raw = first_present(filing, FORM_990PF_KEYS)
    if raw is None:
        return ""
    return re.sub(r"[^A-Z0-9]", "", str(raw).upper())


def is_990pf_filing(filing: dict[str, Any]) -> bool:
    # ProPublica encodes form type as integer: 1=990, 2=990PF, 3=990EZ
    if filing.get("formtype") == 2:
        return True
    form_type = normalize_form_type(filing)
    if not form_type:
        return True
    return form_type == "990PF"


def extract_tax_period(filing: dict[str, Any]) -> str:
    raw = first_present(filing, TAX_PERIOD_KEYS)
    if raw is None:
        return ""
    return str(raw).strip()


def extract_year(filing: dict[str, Any]) -> int | None:
    year_value = first_present(filing, YEAR_KEYS)
    if year_value is not None:
        try:
            return int(str(year_value)[:4])
        except ValueError:
            pass

    tax_period = extract_tax_period(filing)
    if len(tax_period) >= 4 and tax_period[:4].isdigit():
        return int(tax_period[:4])

    return None


def build_irs_filing_map(ein_set: set[str]) -> dict[str, list[dict[str, Any]]]:
    """
    Scan IRS TEOS index CSVs for the given EINs.
    Returns { ein_digits: [{"index_year", "tax_period", "object_id", "xml_batch_id"}, ...] }
    """
    result: dict[str, list[dict[str, Any]]] = {}
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    for year in TEOS_YEARS:
        url = f"{TEOS_BASE}/{year}/index_{year}.csv"
        logging.info("Scanning TEOS index %s", url)
        try:
            r = session.get(url, timeout=120, stream=True)
            r.raise_for_status()
        except requests.RequestException as exc:
            logging.warning("Could not fetch TEOS index %s: %s", year, exc)
            continue
        headers: list[str] | None = None
        found = 0
        for raw in r.iter_lines():
            line = raw.decode("utf-8", errors="replace")
            if headers is None:
                headers = [h.strip() for h in line.split(",")]
                continue
            parts = line.split(",")
            if len(parts) < len(headers):
                continue
            row = dict(zip(headers, parts))
            if row.get("RETURN_TYPE", "").strip() != "990PF":
                continue
            ein = row.get("EIN", "").strip().zfill(9)
            if ein not in ein_set:
                continue
            result.setdefault(ein, []).append({
                "index_year": year,
                "tax_period": row.get("TAX_PERIOD", "").strip(),
                "object_id": row.get("OBJECT_ID", "").strip(),
                "xml_batch_id": row.get("XML_BATCH_ID", "").strip(),
            })
            found += 1
        r.close()
        logging.info("TEOS index %s: %s 990PF match(es) for target EINs", year, found)
    return result


def _http_range(session: requests.Session, url: str, start: int, end: int) -> bytes:
    r = session.get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=120)
    r.raise_for_status()
    return r.content


def _fetch_zip_cd(session: requests.Session, zip_url: str) -> tuple[bytes, int] | None:
    """
    Fetch just the ZIP central directory via HTTP Range requests.
    Returns (cd_data, cd_file_offset) or None on failure.
    Handles ZIP64.
    """
    try:
        rh = session.head(zip_url, timeout=30)
        rh.raise_for_status()
        total_size = int(rh.headers["content-length"])
    except (requests.RequestException, KeyError, ValueError) as exc:
        logging.debug("HEAD failed for %s: %s", zip_url, exc)
        return None

    # Read tail to find EOCD (last 65 KB is more than enough)
    tail_size = min(65558, total_size)
    try:
        tail = _http_range(session, zip_url, total_size - tail_size, total_size - 1)
    except requests.RequestException as exc:
        logging.debug("Range read tail failed for %s: %s", zip_url, exc)
        return None

    # Find EOCD signature (search from end)
    eocd_pos = tail.rfind(b"\x50\x4b\x05\x06")
    if eocd_pos == -1:
        return None
    eocd = tail[eocd_pos:]
    if len(eocd) < 22:
        return None

    _, _, _, _, _, cd_size, cd_offset, _ = struct.unpack_from("<4sHHHHIIH", eocd)

    # Handle ZIP64 (cd_offset == 0xFFFFFFFF signals ZIP64)
    if cd_offset == 0xFFFFFFFF:
        loc_pos = tail.rfind(b"\x50\x4b\x06\x07")
        if loc_pos == -1:
            return None
        eocd64_file_offset = struct.unpack_from("<Q", tail, loc_pos + 8)[0]
        try:
            eocd64 = _http_range(session, zip_url, eocd64_file_offset, eocd64_file_offset + 55)
        except requests.RequestException:
            return None
        cd_size, cd_offset = struct.unpack_from("<QQ", eocd64, 40)

    try:
        cd_data = _http_range(session, zip_url, cd_offset, cd_offset + cd_size - 1)
    except requests.RequestException as exc:
        logging.debug("CD range read failed for %s: %s", zip_url, exc)
        return None

    return cd_data, cd_offset


def extract_xml_from_zip(session: requests.Session, zip_url: str, object_id: str,
                         _cd_cache: dict[str, bytes]) -> bytes | None:
    """
    Extract {batch_id}/{object_id}_public.xml from a remote ZIP using HTTP Range requests.
    _cd_cache maps zip_url -> cd_data to avoid re-fetching central directories.
    Returns raw XML bytes, or None if not found.
    """
    # Path inside ZIP varies by year: no prefix (2025), {batch}/ prefix (2024),
    # or arbitrary subdirectory (2022/2021). Match by object_id suffix.
    target_suffix = f"{object_id}_public.xml"

    if zip_url not in _cd_cache:
        result = _fetch_zip_cd(session, zip_url)
        if result is None:
            return None
        _cd_cache[zip_url] = result[0]

    cd_data = _cd_cache[zip_url]

    # Walk central directory entries looking for target filename
    pos = 0
    while pos + 46 <= len(cd_data):
        if cd_data[pos:pos + 4] != b"\x50\x4b\x01\x02":
            break
        (_, _, _, _, compress_method, _, _, _, compressed_size, _,
         fname_len, extra_len, comment_len_cd, _, _, _, local_hdr_offset) = struct.unpack_from(
            "<4sHHHHHHIIIHHHHHII", cd_data, pos)
        fname = cd_data[pos + 46: pos + 46 + fname_len].decode("utf-8", errors="replace")
        if fname == target_suffix or fname.endswith(f"/{target_suffix}"):
            # Read local file header to find data start offset
            try:
                lf = _http_range(session, zip_url, local_hdr_offset, local_hdr_offset + 29)
            except requests.RequestException:
                return None
            lf_fname_len, lf_extra_len = struct.unpack_from("<HH", lf, 26)
            data_offset = local_hdr_offset + 30 + lf_fname_len + lf_extra_len
            try:
                compressed = _http_range(session, zip_url, data_offset, data_offset + compressed_size - 1)
            except requests.RequestException:
                return None
            if compress_method == 0:
                return compressed
            if compress_method == 8:
                return zlib.decompress(compressed, -15)
            logging.warning("Unsupported compression %s in %s", compress_method, zip_url)
            return None
        pos += 46 + fname_len + extra_len + comment_len_cd

    return None  # not in this ZIP


def fetch_xml_from_teos(
    session: requests.Session,
    irs_entry: dict[str, Any],
    _cd_cache: dict[str, bytes],
) -> bytes | None:
    """
    Download a 990-PF XML from IRS TEOS given an entry from the filing map.
    Tries the known batch ZIP first; falls back to year-level candidates.
    """
    year = irs_entry["index_year"]
    object_id = irs_entry["object_id"]
    batch_id = irs_entry.get("xml_batch_id", "").strip()

    candidates: list[str] = []
    if batch_id:
        candidates.append(f"{TEOS_BASE}/{year}/{batch_id}.zip")
    for fallback_batch in TEOS_BATCH_FALLBACKS.get(year, []):
        url = f"{TEOS_BASE}/{year}/{fallback_batch}.zip"
        if url not in candidates:
            candidates.append(url)

    for zip_url in candidates:
        logging.info("Looking for %s_public.xml in %s", object_id, zip_url)
        xml_bytes = extract_xml_from_zip(session, zip_url, object_id, _cd_cache)
        if xml_bytes is not None:
            logging.info("Found XML for object_id=%s in %s", object_id, zip_url)
            irs_entry["_resolved_zip_url"] = zip_url  # record for filing_url
            return xml_bytes
        if batch_id and zip_url == candidates[0]:
            logging.warning("object_id=%s not found in expected batch %s", object_id, zip_url)

    logging.warning("Could not find XML for object_id=%s in any TEOS ZIP", object_id)
    return None


def parse_xml_document(xml_bytes: bytes) -> etree._Element:
    parser = etree.XMLParser(recover=True, huge_tree=True)
    return etree.fromstring(xml_bytes, parser=parser)


def find_groups(root: etree._Element) -> list[etree._Element]:
    groups = root.findall(".//irs:GrantOrContributionPdDurYrGrp", namespaces=IRS_NS)
    if groups:
        return groups

    groups = root.findall(".//GrantOrContributionPdDurYrGrp")
    if groups:
        return groups

    groups = root.findall(".//irs:GrantOrContriPaidDuringYear", namespaces=IRS_NS)
    if groups:
        return groups

    groups = root.findall(".//GrantOrContriPaidDuringYear")
    if groups:
        return groups

    return root.xpath(
        ".//*[local-name()='GrantOrContributionPdDurYrGrp' or local-name()='GrantOrContriPaidDuringYear']"
    )


def find_child(element: etree._Element, namespaced_path: str, plain_path: str) -> etree._Element | None:
    found = element.find(namespaced_path, namespaces=IRS_NS)
    if found is not None:
        return found
    found = element.find(plain_path)
    if found is not None:
        return found
    plain_leaf = plain_path.split("/")[-1]
    matches = element.xpath(f"./*[local-name()='{plain_leaf}']")
    return matches[0] if matches else None


def find_text(element: etree._Element, path_pairs: Iterable[tuple[str, str]]) -> str:
    for namespaced_path, plain_path in path_pairs:
        found = find_child(element, namespaced_path, plain_path)
        if found is not None:
            text = " ".join(part.strip() for part in found.itertext() if part and part.strip())
            if text:
                return text
    return ""


def parse_amount(raw_value: str) -> int | float | None:
    if not raw_value:
        return None

    cleaned = raw_value.replace(",", "").replace("$", "").strip()
    if not cleaned:
        return None

    try:
        amount = Decimal(cleaned)
    except InvalidOperation:
        return None

    if amount == amount.to_integral_value():
        return int(amount)
    return float(amount)


def join_nonempty(parts: Iterable[str]) -> str:
    return ", ".join(part.strip() for part in parts if part and part.strip())


def extract_recipient_name(group: etree._Element) -> str:
    person_name = find_text(
        group,
        [
            ("irs:RecipientPersonNm", "RecipientPersonNm"),
        ],
    )
    if person_name:
        return person_name

    business_line_1 = find_text(
        group,
        [
            ("irs:RecipientBusinessName/irs:BusinessNameLine1Txt", "RecipientBusinessName/BusinessNameLine1Txt"),
            ("irs:RecipientBusinessName/irs:BusinessNameLine1", "RecipientBusinessName/BusinessNameLine1"),
        ],
    )
    business_line_2 = find_text(
        group,
        [
            ("irs:RecipientBusinessName/irs:BusinessNameLine2Txt", "RecipientBusinessName/BusinessNameLine2Txt"),
            ("irs:RecipientBusinessName/irs:BusinessNameLine2", "RecipientBusinessName/BusinessNameLine2"),
        ],
    )
    return join_nonempty([business_line_1, business_line_2])


def extract_recipient_address(group: etree._Element) -> tuple[str, str]:
    us_address = find_child(group, "irs:RecipientUSAddress", "RecipientUSAddress")
    if us_address is not None:
        address = join_nonempty(
            [
                find_text(us_address, [("irs:AddressLine1Txt", "AddressLine1Txt")]),
                find_text(us_address, [("irs:AddressLine2Txt", "AddressLine2Txt")]),
                find_text(us_address, [("irs:CityNm", "CityNm")]),
                find_text(
                    us_address,
                    [
                        ("irs:StateAbbreviationCd", "StateAbbreviationCd"),
                        ("irs:StateAbbreviationCd", "StateAbbreviation"),
                    ],
                ),
                find_text(us_address, [("irs:ZIPCd", "ZIPCd")]),
            ]
        )
        return address, "US"

    foreign_address = find_child(group, "irs:RecipientForeignAddress", "RecipientForeignAddress")
    if foreign_address is not None:
        country = find_text(
            foreign_address,
            [
                ("irs:CountryCd", "CountryCd"),
                ("irs:CountryNm", "CountryNm"),
            ],
        )
        address = join_nonempty(
            [
                find_text(foreign_address, [("irs:AddressLine1Txt", "AddressLine1Txt")]),
                find_text(foreign_address, [("irs:AddressLine2Txt", "AddressLine2Txt")]),
                find_text(foreign_address, [("irs:CityNm", "CityNm")]),
                find_text(foreign_address, [("irs:ProvinceOrStateNm", "ProvinceOrStateNm")]),
                find_text(foreign_address, [("irs:ForeignPostalCd", "ForeignPostalCd")]),
                country,
            ]
        )
        return address, country or "FOREIGN"

    return "", ""


def extract_purpose(group: etree._Element) -> str:
    return find_text(
        group,
        [
            ("irs:PurposeOfGrantOrContriTxt", "PurposeOfGrantOrContriTxt"),
            ("irs:GrantOrContributionPurposeTxt", "GrantOrContributionPurposeTxt"),
        ],
    )


def extract_amount(group: etree._Element) -> int | float | None:
    raw = find_text(
        group,
        [
            ("irs:CashGrantAmt", "CashGrantAmt"),
            ("irs:Amt", "Amt"),
        ],
    )
    return parse_amount(raw)


_GENERAL_PATTERNS = re.compile(
    r"general support|for general support|to support the exempt purpose"
    r"|core support|operating support|organizational strengthening"
    r"|unrestricted support|annual support"
    r"|charitable purposes?|general char\w*"  # catches "charitable" and common typos
    r"|program support|annual fund"
    r"|operating expenses?|operating purposes?|general operations?"
    r"|general purposes?|general use"
    r"|public welfare|exempt purposes?"
    r"|community benefit|charitable contribution",
    re.IGNORECASE,
)

# Keywords that indicate a specific, directed grant regardless of purpose string length
_DIRECTED_KEYWORDS = re.compile(
    r"\b(programs?|programm\w+|projects?|initiatives?|research|stud(?:y|ies)"
    r"|fellowships?|conferences?|publications?|campaigns?"
    r"|reports?|training|curriculum|exhibits?|exhibitions?"
    r"|scholarships?|scholars|forums?|summits?|workshops?"
    r"|symposia|symposium|institutes?|centers?|grants?)\b",
    re.IGNORECASE,
)


def classify_mechanism(purpose: str) -> str:
    p = purpose.strip()
    if not p:
        return "general"
    pl = p.lower()
    if "matching gift" in pl:
        return "matching"
    if _GENERAL_PATTERNS.search(pl):
        return "general"
    if _DIRECTED_KEYWORDS.search(p):
        return "directed"
    if len(p) > 50:
        return "directed"
    return "unclear"


def normalize_match_text(value: str) -> str:
    return re.sub(r"[^A-Z0-9]+", " ", value.upper()).strip()


def recipient_name_matches(name: str) -> tuple[bool, list[str]]:
    if not name:
        return False, []

    normalized = normalize_match_text(name)
    reasons: list[str] = []
    candidates = list(NAME_TARGETS)
    candidates.extend([f"American Friends of {target}" for target in NAME_TARGETS])

    for target in candidates:
        target_normalized = normalize_match_text(target)
        if target_normalized in normalized:
            reasons.append(f"name contains '{target}'")
            return True, reasons

    best_target = ""
    best_score = 0
    for target in candidates:
        target_normalized = normalize_match_text(target)
        score = max(
            fuzz.partial_ratio(normalized, target_normalized),
            fuzz.token_set_ratio(normalized, target_normalized),
        )
        if score > best_score:
            best_score = score
            best_target = target

    if best_score >= FUZZY_THRESHOLD:
        reasons.append(f"name fuzzy-matched '{best_target}' ({best_score})")
        return True, reasons

    if normalized.startswith("AMERICAN FRIENDS OF "):
        suffix = normalized.removeprefix("AMERICAN FRIENDS OF ").strip()
        for target in NAME_TARGETS:
            target_normalized = normalize_match_text(target)
            score = max(
                fuzz.partial_ratio(suffix, target_normalized),
                fuzz.token_set_ratio(suffix, target_normalized),
            )
            if score >= FUZZY_THRESHOLD:
                reasons.append(f"name fuzzy-matched 'American Friends of {target}' ({score})")
                return True, reasons

    return False, []


def recipient_address_matches(country: str, address: str) -> tuple[bool, list[str]]:
    country_normalized = normalize_match_text(country)
    combined = normalize_match_text(" ".join([country, address]))
    reasons: list[str] = []
    if not combined:
        return False, reasons

    if country_normalized in {"IL", "ISR", "ISRAEL"}:
        reasons.append("recipient country references Israel")
        return True, reasons

    if " ISRAEL " in f" {combined} " or combined.endswith(" ISRAEL") or combined == "ISRAEL":
        reasons.append("recipient address references Israel")
        return True, reasons

    if any(term in combined for term in ISRAEL_ADDRESS_TERMS):
        reasons.append("recipient address includes Israel-related location")
        return True, reasons

    return False, reasons


def purpose_matches(purpose: str) -> tuple[bool, list[str]]:
    normalized = normalize_match_text(purpose)
    reasons: list[str] = []
    if not normalized:
        return False, reasons

    for keyword in PURPOSE_KEYWORDS:
        if normalize_match_text(keyword) in normalized:
            reasons.append(f"purpose contains '{keyword}'")
            return True, reasons

    return False, reasons


def is_matching_grant(recipient_name: str, recipient_country: str, recipient_address: str, purpose: str) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    for matcher in (
        recipient_name_matches(recipient_name),
        recipient_address_matches(recipient_country, recipient_address),
        purpose_matches(purpose),
    ):
        matched, match_reasons = matcher
        if matched:
            reasons.extend(match_reasons)

    return bool(reasons), reasons


def download_xml(session: RateLimitedSession, xml_url: str, destination: Path) -> bytes:
    logging.info("Downloading XML %s", xml_url)
    response = session.get(xml_url)
    xml_bytes = response.content
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(xml_bytes)
    logging.info("Saved XML to %s", destination)
    return xml_bytes


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def build_foundation_output(
    seeds: list[FoundationSeed],
    organization_names: dict[str, str],
    totals_by_ein: dict[str, Decimal],
    years_by_ein: dict[str, set[int]],
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for seed in seeds:
        ein_digits = seed.ein_digits
        total = totals_by_ein.get(ein_digits, Decimal("0"))
        output.append(
            {
                "id": seed.foundation_id,
                "name": organization_names.get(ein_digits, seed.name),
                "ein": format_ein(ein_digits),
                "total_granted": int(total) if total == total.to_integral_value() else float(total),
                "grant_years": sorted(years_by_ein.get(ein_digits, set())),
            }
        )
    return output


def run_ingest(rate_limit_seconds: float, timeout: int, max_foundations: int | None) -> None:
    session = RateLimitedSession(rate_limit_seconds=rate_limit_seconds, timeout=timeout)
    seeds = SEED_FOUNDATIONS[:max_foundations] if max_foundations else SEED_FOUNDATIONS

    grants_output: list[dict[str, Any]] = []
    totals_by_ein: dict[str, Decimal] = {}
    years_by_ein: dict[str, set[int]] = {}
    organization_names: dict[str, str] = {}
    filings_seen = 0
    filings_with_xml = 0
    filings_without_xml = 0

    # Build IRS TEOS filing map once before processing foundations
    ein_set = {seed.ein_digits for seed in seeds}
    irs_filing_map = build_irs_filing_map(ein_set)
    # Shared cache for ZIP central directories (avoid re-fetching the same CD)
    zip_cd_cache: dict[str, bytes] = {}

    for seed in seeds:
        ein_digits = seed.ein_digits
        org_url = f"{API_BASE}/{ein_digits}.json"

        org_payload = load_json(session, org_url)
        organization_name = extract_org_name(org_payload, seed.name)
        organization_names[ein_digits] = organization_name

        irs_entries = irs_filing_map.get(ein_digits, [])
        logging.info("%s (%s): %s TEOS filing entries", organization_name, format_ein(ein_digits), len(irs_entries))

        matched_for_foundation = 0
        totals_by_ein.setdefault(ein_digits, Decimal("0"))
        years_by_ein.setdefault(ein_digits, set())

        for irs_entry in irs_entries:
            filings_seen += 1
            tax_period = irs_entry["tax_period"]
            object_id = irs_entry["object_id"]
            year: int | None = int(tax_period[:4]) if len(tax_period) >= 4 and tax_period[:4].isdigit() else None

            # Cache XML locally so re-runs don't re-download
            xml_filename = f"{tax_period}-{object_id}.xml"
            xml_path = RAW_XML_DIR / ein_digits / xml_filename

            url_sidecar = xml_path.with_suffix(".url")
            if xml_path.exists():
                logging.info("Using cached XML %s", xml_path)
                xml_bytes: bytes | None = xml_path.read_bytes()
                if url_sidecar.exists():
                    irs_entry["_resolved_zip_url"] = url_sidecar.read_text(encoding="utf-8").strip()
            else:
                xml_bytes = fetch_xml_from_teos(session.session, irs_entry, zip_cd_cache)
                if xml_bytes is None:
                    filings_without_xml += 1
                    logging.warning(
                        "No XML found for %s %s tax_period=%s object_id=%s",
                        organization_name, format_ein(ein_digits), tax_period, object_id,
                    )
                    continue
                xml_path.parent.mkdir(parents=True, exist_ok=True)
                xml_path.write_bytes(xml_bytes)
                if "_resolved_zip_url" in irs_entry:
                    url_sidecar.write_text(irs_entry["_resolved_zip_url"], encoding="utf-8")
                logging.info("Saved XML to %s", xml_path)

            filings_with_xml += 1

            try:
                root = parse_xml_document(xml_bytes)
            except Exception as exc:  # noqa: BLE001
                logging.exception(
                    "Failed to parse XML for %s %s tax_period=%s object_id=%s error=%s",
                    organization_name, format_ein(ein_digits), tax_period, object_id, exc,
                )
                continue

            groups = find_groups(root)
            logging.info(
                "Parsed %s grant groups for %s tax_period=%s",
                len(groups), organization_name, tax_period,
            )

            filing_url = irs_entry.get("_resolved_zip_url") or (
                f"https://apps.irs.gov/pub/epostcard/990/xml/"
                f"{irs_entry['index_year']}/{irs_entry.get('xml_batch_id') or 'unknown'}.zip"
            )

            for index, group in enumerate(groups, start=1):
                recipient_name = extract_recipient_name(group)
                recipient_address, recipient_country = extract_recipient_address(group)
                purpose = extract_purpose(group)
                amount = extract_amount(group)

                if not recipient_name or amount is None:
                    logging.debug(
                        "Skipping incomplete grant group index=%s foundation=%s tax_period=%s recipient=%r amount=%r",
                        index, organization_name, tax_period, recipient_name, amount,
                    )
                    continue

                matched, reasons = is_matching_grant(
                    recipient_name=recipient_name,
                    recipient_country=recipient_country,
                    recipient_address=recipient_address,
                    purpose=purpose,
                )
                if not matched:
                    continue

                amount_decimal = Decimal(str(amount))
                totals_by_ein[ein_digits] += amount_decimal
                if year is not None:
                    years_by_ein[ein_digits].add(year)
                matched_for_foundation += 1

                grant_id = stable_grant_id(
                    ein_digits, tax_period, recipient_name, str(amount), purpose, str(index),
                )
                grants_output.append(
                    {
                        "id": grant_id,
                        "funder_ein": format_ein(ein_digits),
                        "funder_name": organization_name,
                        "recipient_name": recipient_name,
                        "recipient_country": recipient_country or "UNKNOWN",
                        "amount": amount,
                        "year": year,
                        "purpose": purpose,
                        "mechanism": classify_mechanism(purpose),
                        "filing_url": filing_url,
                        "tax_period": tax_period,
                    }
                )
                logging.info(
                    "Matched grant %s | %s -> %s | amount=%s | year=%s | reasons=%s",
                    grant_id, organization_name, recipient_name, amount, year, "; ".join(reasons),
                )

        logging.info(
            "Completed %s (%s): matched %s grant(s), total=%s",
            organization_name,
            format_ein(ein_digits),
            matched_for_foundation,
            int(totals_by_ein[ein_digits]) if totals_by_ein[ein_digits] == totals_by_ein[ein_digits].to_integral_value() else float(totals_by_ein[ein_digits]),
        )

    foundations_output = build_foundation_output(
        seeds=seeds,
        organization_names=organization_names,
        totals_by_ein=totals_by_ein,
        years_by_ein=years_by_ein,
    )

    grants_output.sort(
        key=lambda grant: (
            str(grant["funder_name"]),
            str(grant["tax_period"]),
            str(grant["recipient_name"]).lower(),
            str(grant["id"]),
        )
    )
    foundations_output.sort(key=lambda foundation: foundation["name"].lower())

    write_json(FOUNDATIONS_PATH, foundations_output)
    write_json(GRANTS_PATH, grants_output)

    logging.info("Wrote %s foundation records to %s", len(foundations_output), FOUNDATIONS_PATH)
    logging.info("Wrote %s matched grants to %s", len(grants_output), GRANTS_PATH)
    logging.info(
        "Ingest summary: filings_seen=%s filings_with_xml=%s filings_without_xml=%s matched_grants=%s",
        filings_seen,
        filings_with_xml,
        filings_without_xml,
        len(grants_output),
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingest 990-PF filings from ProPublica Nonprofit Explorer and extract Israel-related grants."
    )
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout in seconds for API and XML requests.")
    parser.add_argument(
        "--rate-limit-seconds",
        type=float,
        default=1.0,
        help="Minimum delay between outbound HTTP requests.",
    )
    parser.add_argument(
        "--max-foundations",
        type=int,
        default=None,
        help="Optional limit for local smoke testing.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    configure_logging()

    try:
        run_ingest(
            rate_limit_seconds=args.rate_limit_seconds,
            timeout=args.timeout,
            max_foundations=args.max_foundations,
        )
    except requests.HTTPError as exc:
        logging.exception("HTTP error during ingest: %s", exc)
        return 1
    except requests.RequestException as exc:
        logging.exception("Network error during ingest: %s", exc)
        return 1
    except Exception as exc:  # noqa: BLE001
        logging.exception("Unhandled ingest error: %s", exc)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
