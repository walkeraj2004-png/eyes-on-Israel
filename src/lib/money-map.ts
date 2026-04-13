import { promises as fs } from "node:fs";
import path from "node:path";

import type { Foundation, Grant, MoneyMapDataset, Recipient } from "@/types/money-map";

// Raw shapes from the Python pipeline output
type PipelineFoundation = {
  id: string; // slug, e.g. "ford-foundation"
  name: string;
  ein: string; // formatted "XX-XXXXXXX"
  total_granted: number;
  grant_years: number[];
};

type PipelineGrant = {
  id: string;
  funder_ein: string;
  funder_name: string;
  recipient_name: string;
  recipient_country: string;
  amount: number | null;
  year: number | null;
  purpose: string;
  mechanism: string;
  filing_url: string;
  tax_period: string;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "item";
}

export async function getMoneyMapDataset(): Promise<MoneyMapDataset> {
  const dataDir = path.join(process.cwd(), "data");

  const [foundationsRaw, grantsRaw] = await Promise.all([
    fs.readFile(path.join(dataDir, "foundations.json"), "utf8"),
    fs.readFile(path.join(dataDir, "grants.json"), "utf8"),
  ]);

  const pFoundations = JSON.parse(foundationsRaw) as PipelineFoundation[];
  const pGrants = JSON.parse(grantsRaw) as PipelineGrant[];

  // EIN (digits only) → pipeline foundation
  const foundationByEin = new Map<string, PipelineFoundation>();
  for (const f of pFoundations) {
    foundationByEin.set(f.ein.replace(/-/g, ""), f);
  }

  // Accumulate per-recipient stats while building grant records
  type RecipientAgg = {
    id: string;
    name: string;
    country: string;
    total: number;
    count: number;
    funderIds: Set<string>;
  };
  const recipientAgg = new Map<string, RecipientAgg>();

  const grants: Grant[] = [];

  for (const pg of pGrants) {
    if (pg.year === null || pg.amount === null || pg.amount < 10_000) continue;

    const einKey = pg.funder_ein.replace(/-/g, "");
    const pf = foundationByEin.get(einKey);
    if (!pf) continue;

    const recipientId = "recipient-" + slugify(pg.recipient_name);

    if (!recipientAgg.has(recipientId)) {
      recipientAgg.set(recipientId, {
        id: recipientId,
        name: pg.recipient_name,
        country: pg.recipient_country || "UNKNOWN",
        total: 0,
        count: 0,
        funderIds: new Set(),
      });
    }
    const ra = recipientAgg.get(recipientId)!;
    ra.total += pg.amount;
    ra.count++;
    ra.funderIds.add(pf.id);

    grants.push({
      id: pg.id,
      foundation_id: pf.id,
      recipient_id: recipientId,
      year: pg.year,
      amount_usd: pg.amount,
      purpose: pg.purpose || "",
      mechanism: (pg.mechanism as Grant["mechanism"]) || "unclear",
      filing_url: pg.filing_url || "",
    });
  }

  // Build Foundation entities — reuse pre-computed stats from grant scan above
  const grantCountByFoundation = new Map<string, number>();
  const connectedByFoundation = new Map<string, Set<string>>();
  for (const g of grants) {
    grantCountByFoundation.set(g.foundation_id, (grantCountByFoundation.get(g.foundation_id) ?? 0) + 1);
    if (!connectedByFoundation.has(g.foundation_id)) connectedByFoundation.set(g.foundation_id, new Set());
    connectedByFoundation.get(g.foundation_id)!.add(g.recipient_id);
  }

  const foundations: Foundation[] = pFoundations.map((pf) => ({
    id: pf.id,
    name: pf.name,
    location: pf.ein,
    entity_type: "foundation" as const,
    total_grants_usd: pf.total_granted,
    grant_count: grantCountByFoundation.get(pf.id) ?? 0,
    connected_entity_count: connectedByFoundation.get(pf.id)?.size ?? 0,
  }));

  // Build Recipient entities, sorted by total received (largest first)
  const recipients: Recipient[] = [...recipientAgg.values()]
    .sort((a, b) => b.total - a.total)
    .map((ra) => ({
      id: ra.id,
      name: ra.name,
      location: ra.country,
      entity_type: "recipient" as const,
      category: ra.country === "US" ? "US-based" : "Foreign-based",
      total_received_usd: ra.total,
      grant_count: ra.count,
      connected_entity_count: ra.funderIds.size,
    }));

  const allYears = grants.map((g) => g.year);
  const totalAmount = grants.reduce((sum, g) => sum + g.amount_usd, 0);

  return {
    generated_at: new Date().toISOString(),
    summary: {
      grant_count: grants.length,
      foundation_count: foundations.length,
      recipient_count: recipients.length,
      total_amount_usd: totalAmount,
      year_range: {
        start: Math.min(...allYears),
        end: Math.max(...allYears),
      },
    },
    foundations,
    recipients,
    grants,
    notes: [],
  };
}

export function getEntityMaps(dataset: MoneyMapDataset) {
  const foundations = new Map<string, Foundation>();
  const recipients = new Map<string, Recipient>();
  for (const f of dataset.foundations) foundations.set(f.id, f);
  for (const r of dataset.recipients) recipients.set(r.id, r);
  return { foundations, recipients };
}

export function getGrantLabel(grant: Grant, dataset: MoneyMapDataset) {
  const { foundations, recipients } = getEntityMaps(dataset);
  const foundation = foundations.get(grant.foundation_id);
  const recipient = recipients.get(grant.recipient_id);
  return `${foundation?.name ?? "Unknown foundation"} -> ${recipient?.name ?? "Unknown recipient"}`;
}
