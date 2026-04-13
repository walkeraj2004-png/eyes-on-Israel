from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "data" / "money-map.json"


FOUNDATIONS = [
    {
        "id": "foundation-open-society-institute",
        "name": "Open Society Institute",
        "location": "New York, NY",
        "entity_type": "foundation",
    },
    {
        "id": "foundation-naomi-nehemiah-cohen",
        "name": "Naomi and Nehemiah Cohen Foundation",
        "location": "Bethesda, MD",
        "entity_type": "foundation",
    },
    {
        "id": "foundation-schusterman-family",
        "name": "Charles and Lynn Schusterman Family Foundation",
        "location": "Tulsa, OK",
        "entity_type": "foundation",
    },
    {
        "id": "foundation-barer-family",
        "name": "Barer Family Foundation",
        "location": "Mendham, NJ",
        "entity_type": "foundation",
    },
    {
        "id": "foundation-gilder",
        "name": "Gilder Foundation, Inc.",
        "location": "New York, NY",
        "entity_type": "foundation",
    },
    {
        "id": "foundation-diana-davis-spencer",
        "name": "Diana Davis Spencer Foundation",
        "location": "Bethesda, MD",
        "entity_type": "foundation",
    },
]


RECIPIENTS = [
    {
        "id": "recipient-j-street-education-fund",
        "name": "J Street Education Fund",
        "location": "Washington, DC",
        "entity_type": "recipient",
        "category": "Policy organization",
    },
    {
        "id": "recipient-af-idi",
        "name": "American Friends of the Israel Democracy Institute",
        "location": "Atlanta, GA",
        "entity_type": "recipient",
        "category": "Think tank support organization",
    },
    {
        "id": "recipient-winep",
        "name": "Washington Institute for Near East Policy",
        "location": "Washington, DC",
        "entity_type": "recipient",
        "category": "Policy institute",
    },
    {
        "id": "recipient-jinsa",
        "name": "Jewish Institute for National Security of America",
        "location": "Washington, DC",
        "entity_type": "recipient",
        "category": "Policy organization",
    },
]


GRANTS = [
    {
        "id": "grant-osi-jstreet-2022",
        "foundation_id": "foundation-open-society-institute",
        "recipient_id": "recipient-j-street-education-fund",
        "year": 2022,
        "amount_usd": 15000,
        "purpose": "Matching Gift Program",
        "filing_url": "https://apps.irs.gov/pub/epostcard/cor/137029285_202212_990PF_2024011122225306.pdf",
    },
    {
        "id": "grant-cohen-jstreet-2021",
        "foundation_id": "foundation-naomi-nehemiah-cohen",
        "recipient_id": "recipient-j-street-education-fund",
        "year": 2021,
        "amount_usd": 75000,
        "purpose": "Shared Society in Israel",
        "filing_url": "https://apps.irs.gov/pub/epostcard/cor/201135004_202112_990PF_2023020620921987.pdf",
    },
    {
        "id": "grant-schusterman-afidi-2016",
        "foundation_id": "foundation-schusterman-family",
        "recipient_id": "recipient-af-idi",
        "year": 2016,
        "amount_usd": 50000,
        "purpose": "Specific Project",
        "filing_url": "https://apps.irs.gov/pub/epostcard/cor/731312965_201612_990PF_2017111714962772.pdf",
    },
    {
        "id": "grant-barer-afidi-2020",
        "foundation_id": "foundation-barer-family",
        "recipient_id": "recipient-af-idi",
        "year": 2020,
        "amount_usd": 25000,
        "purpose": "Public Welfare",
        "filing_url": "https://apps.irs.gov/pub/epostcard/cor/203972085_202012_990PF_2022042019912649.pdf",
    },
    {
        "id": "grant-gilder-winep-2017",
        "foundation_id": "foundation-gilder",
        "recipient_id": "recipient-winep",
        "year": 2017,
        "amount_usd": 5000,
        "purpose": "Public Policy",
        "filing_url": "https://apps.irs.gov/pub/epostcard/cor/136176041_201712_990PF_2018122116034721.pdf",
    },
    {
        "id": "grant-spencer-jinsa-2021",
        "foundation_id": "foundation-diana-davis-spencer",
        "recipient_id": "recipient-jinsa",
        "year": 2021,
        "amount_usd": 300000,
        "purpose": "Educational Military Leadership Program",
        "filing_url": "https://apps.irs.gov/pub/epostcard/cor/203672969_202112_990PF_2023051221226614.pdf",
    },
]


def build_dataset() -> dict:
    totals_by_entity: dict[str, int] = defaultdict(int)
    counts_by_entity: dict[str, int] = defaultdict(int)
    links_by_entity: dict[str, set[str]] = defaultdict(set)

    for grant in GRANTS:
        foundation_id = grant["foundation_id"]
        recipient_id = grant["recipient_id"]
        amount = grant["amount_usd"]

        totals_by_entity[foundation_id] += amount
        totals_by_entity[recipient_id] += amount
        counts_by_entity[foundation_id] += 1
        counts_by_entity[recipient_id] += 1
        links_by_entity[foundation_id].add(recipient_id)
        links_by_entity[recipient_id].add(foundation_id)

    foundations = []
    for foundation in FOUNDATIONS:
        foundations.append(
            {
                **foundation,
                "total_grants_usd": totals_by_entity[foundation["id"]],
                "grant_count": counts_by_entity[foundation["id"]],
                "connected_entity_count": len(links_by_entity[foundation["id"]]),
            }
        )

    recipients = []
    for recipient in RECIPIENTS:
        recipients.append(
            {
                **recipient,
                "total_received_usd": totals_by_entity[recipient["id"]],
                "grant_count": counts_by_entity[recipient["id"]],
                "connected_entity_count": len(links_by_entity[recipient["id"]]),
            }
        )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "grant_count": len(GRANTS),
            "foundation_count": len(FOUNDATIONS),
            "recipient_count": len(RECIPIENTS),
            "total_amount_usd": sum(grant["amount_usd"] for grant in GRANTS),
            "year_range": {
                "start": min(grant["year"] for grant in GRANTS),
                "end": max(grant["year"] for grant in GRANTS),
            },
        },
        "foundations": foundations,
        "recipients": recipients,
        "grants": GRANTS,
        "notes": [
            "Seed dataset for the MVP Money Map panel.",
            "Each grant record includes a filing URL suitable for direct source review.",
            "Additional ingestion stages can extend this JSON from dev-time SQLite or raw filing extracts.",
        ],
    }


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(build_dataset(), indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
