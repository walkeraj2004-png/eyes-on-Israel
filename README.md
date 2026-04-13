# Ecuador Cut-Flower Network Research Repo

This repository provides a starter Python workflow to map actors and trade flows in Ecuador's cut-flower sector (especially roses).

## Proposed Repository Structure

```text
.
├── data/
│   ├── producers.csv
│   ├── buyers.csv
│   ├── shipments.csv
│   ├── associations.csv
│   ├── memberships.csv
│   ├── issues.csv
│   ├── politicians.csv (optional)
│   └── political_links.csv (optional)
├── notebooks/
├── outputs/
│   ├── rankings/
│   ├── node_metrics.csv
│   ├── shipments_enriched.csv
│   ├── shipments_with_associations.csv
│   └── network_sample.png
├── src/
│   └── flower_network/
│       ├── __init__.py
│       ├── models.py
│       ├── etl.py
│       ├── network_analysis.py
│       ├── visualize.py
│       └── pipeline.py
└── pyproject.toml
```

## Data Schema

### `producers.csv`
- `producer_id`: stable ID (e.g., `P001`)
- `legal_name`: official producer/exporter name
- `normalized_name`: optional normalized key (auto-filled if empty)
- `country_iso2`, `province`, `city`
- `primary_flower_type`: e.g., `rose`
- `website`, `notes`
- `altitude_m` (optional): farm elevation in meters
- `latitude`, `longitude` (optional): approximate farm/office coordinates
- `certifications` (optional): comma-separated labels (e.g., `Rainforest,FlorEcuador`)
- `main_markets` (optional): comma-separated region labels (e.g., `US,EU,Russia`)
- `key_executives` (optional): comma-separated executive names for people/power analysis
- `owner_group` (optional): ownership group or holding name
- `ethics_score` (optional): composite ethics/sustainability score on a 1-10 scale
- `ethics_notes` (optional): short rationale for ethics score (labor, environmental, governance context)

### `buyers.csv`
- `buyer_id`: stable ID (e.g., `B001`)
- `buyer_name`
- `normalized_name`: optional normalized key (auto-filled if empty)
- `country_iso2`
- `region_group`: e.g., `US`, `EU`, `Russia`, `Kazakhstan`
- `buyer_type`: importer, wholesaler, retailer, etc.
- `notes`
- `city` (optional)
- `main_channel` (optional): e.g., supermarket, wholesaler, florist
- `segment` (optional): e.g., mass market, premium, luxury
- `key_contacts` (optional): comma-separated contact names for people/power analysis
- `ethics_score` (optional): composite ethics/sustainability score on a 1-10 scale
- `ethics_notes` (optional): short rationale for ethics score

### `shipments.csv`
- `shipment_id`: row ID (or transaction ID)
- `producer_id`, `buyer_id` (foreign keys)
- `year`
- `month`: optional integer month (`1-12`)
- `value_usd`: numeric export value
- `volume_kg`: numeric volume
- `product_segment`: optional label (e.g., `premium_rose`, `spray_rose`, `mixed`)
- `source`: citation for the record

### `associations.csv`
- `association_id`: stable ID (e.g., `A001`)
- `association_name`
- `normalized_name`: optional normalized key (auto-filled if empty)
- `country_iso2`
- `association_type`
- `website`, `notes`
- `leadership` (optional): comma-separated leadership names for people/power analysis
- `ethics_score` (optional): composite ethics/sustainability score on a 1-10 scale
- `ethics_notes` (optional): short rationale for ethics score

### `memberships.csv`
- `membership_id`
- `association_id` (foreign key)
- `member_type`: `producer` or `buyer`
- `member_id`: ID from corresponding table
- `role`
- `start_year`, `end_year`
- `source`

### `issues.csv`
- `issue_id`
- `entity_type`: `producer`, `buyer`, or `association`
- `entity_id`: ID in referenced table
- `issue_category`: e.g., labor, pesticide, environmental
- `issue_title`
- `report_date`
- `source_org`, `source_url`
- `severity`
- `summary`

### `politicians.csv` (optional)
- `politician_id`
- `name`
- `role`: e.g., minister, deputy, regulator
- `institution`: ministry, agency, committee, etc.
- `party_or_alignment`
- `notes`: short contextual comment

### `political_links.csv` (optional)
- `link_id`
- `politician_id` (foreign key to `politicians.csv`)
- `entity_type`: `producer`, `buyer`, or `association`
- `entity_id`: ID in referenced entity table
- `link_type`: e.g., donor relationship, board member, family tie, public supporter, regulator for sector
- `confidence_level`: `low`, `medium`, or `high`
- `source`: short citation / URL

## Ethics Scoring

`ethics_score` is a composite 1-10 indicator inspired by sustainability and ESG-style criteria, combining environmental practices, labor conditions, certifications, and controversies.

- `8-10`: `high` ethics band
- `5-7`: `medium` ethics band
- `1-4`: `low` ethics band

Treat current sample values as illustrative placeholders until replaced with verified assessments.

## Quick Start

1. Create and activate a Python environment.
2. Install dependencies:

```bash
pip install -e .
```

3. Fill the CSV files in `data/` with manually curated records.
4. Run pipeline:

```bash
python -m flower_network.pipeline
```

## 990-PF Grant Ingestion

Use the ingestion script to fetch ProPublica Nonprofit Explorer organization metadata and filing indexes for the seed foundation EINs, download any available 990-PF XML filings, and extract Israel-related grant records into static JSON files.

Install the required packages:

```bash
pip install -r requirements.txt
```

Run the ingest:

```bash
python3 scripts/ingest_990s.py
```

Optional local smoke test against only the first seed foundation:

```bash
python3 scripts/ingest_990s.py --max-foundations 1
```

Outputs:

- `data/foundations.json`: foundation-level totals and grant years
- `data/grants.json`: matched grant records with filing URLs and tax periods
- `data/ingest_990s.log`: ingest log including missing-XML warnings, matched grants, and totals
- `data/raw/irs_990pf_xml/`: downloaded XML filings, organized by EIN

## What the Pipeline Produces

- Loads and validates all CSV tables.
- Normalizes actor names (if `normalized_name` is blank).
- Builds joined views linking producers, buyers, and association memberships.
- Builds a producer↔buyer trade graph weighted by `value_usd`.
- Optionally adds association membership edges for broker-style centrality analysis.
- Computes degree, weighted degree, and betweenness centrality.
- Exports top-20 rankings by node type (`producer`, `buyer`, `association`) into `outputs/rankings/`.
- Saves a sample network visualization as `outputs/network_sample.png`.

## Notes

- TODO fields and example rows are placeholders. Replace with verified records and citations.
- No external paid APIs are used.
- Scraping can be added later by appending new ETL input modules, while keeping this curated CSV baseline.

## Streamlit UI

Run the web UI from the project root:

```bash
source .venv/bin/activate
streamlit run app_streamlit.py
```

The sidebar includes a `Run pipeline now` button that refreshes outputs before analysis.

## Data Entry Helper

Use the interactive CLI to append curated rows into `data/producers.csv`, `data/buyers.csv`, `data/shipments.csv`, or `data/issues.csv`:

```bash
PYTHONPATH=src python3 -m flower_network.data_entry
```
