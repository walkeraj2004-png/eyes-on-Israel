"use client";

import { ChevronDown, ExternalLink, Landmark, Network, Rows3, Scale } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import dynamic from "next/dynamic";

const MoneyMapGraph = dynamic(
  () => import("@/components/money-map-graph").then((m) => m.MoneyMapGraph),
  { ssr: false },
);

const TimelinePanel = dynamic(
  () => import("@/components/timeline-panel").then((m) => m.TimelinePanel),
  { ssr: false },
);
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { Foundation, Grant, Mechanism, MoneyMapDataset, Recipient } from "@/types/money-map";

type Selection =
  | { type: "grant"; id: string }
  | { type: "node"; id: string }
  | null;

const TOP_RECIPIENT_COUNT = 75;

const ALL_MECHANISMS: Mechanism[] = ["directed", "general", "matching", "unclear"];
const MECHANISM_LABELS: Record<Mechanism, string> = {
  directed: "Directed",
  general: "General",
  matching: "Matching",
  unclear: "Unclear",
};

type MoneyMapPanelProps = {
  dataset: MoneyMapDataset;
};

export function MoneyMapPanel({ dataset }: MoneyMapPanelProps) {
  const defaultGrant = useMemo(
    () => [...dataset.grants].sort((a, b) => b.amount_usd - a.amount_usd)[0] ?? null,
    [dataset.grants],
  );
  const [selectedYear, setSelectedYear] = useState<string>("all");
  const [selectedFoundationIds, setSelectedFoundationIds] = useState<Set<string>>(() => new Set());
  const [recipientSearch, setRecipientSearch] = useState("");
  const [minAmount, setMinAmount] = useState(0);
  const [selectedMechanisms, setSelectedMechanisms] = useState<Set<Mechanism>>(
    () => new Set(ALL_MECHANISMS),
  );
  const [mechInfoOpen, setMechInfoOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [selection, setSelection] = useState<Selection>(() =>
    defaultGrant ? { type: "grant", id: defaultGrant.id } : null,
  );

  const foundationMap = useMemo(
    () => new Map(dataset.foundations.map((f) => [f.id, f])),
    [dataset.foundations],
  );
  const recipientMap = useMemo(
    () => new Map(dataset.recipients.map((r) => [r.id, r])),
    [dataset.recipients],
  );

  const years = useMemo(
    () => [...new Set(dataset.grants.map((g) => g.year))].sort((a, b) => b - a),
    [dataset.grants],
  );

  const filteredGrants = useMemo(() => {
    const searchLower = recipientSearch.trim().toLowerCase();
    return dataset.grants.filter((grant) => {
      if (selectedYear !== "all" && String(grant.year) !== selectedYear) return false;
      if (selectedFoundationIds.size > 0 && !selectedFoundationIds.has(grant.foundation_id)) return false;
      if (searchLower && !recipientMap.get(grant.recipient_id)?.name.toLowerCase().includes(searchLower)) return false;
      if (!selectedMechanisms.has(grant.mechanism)) return false;
      return true;
    });
  }, [dataset.grants, selectedYear, selectedFoundationIds, recipientSearch, selectedMechanisms, recipientMap]);

  const defaultFilteredGrant = useMemo(
    () => [...filteredGrants].sort((a, b) => b.amount_usd - a.amount_usd)[0] ?? null,
    [filteredGrants],
  );

  const visibleFoundationIds = useMemo(
    () => new Set(filteredGrants.map((g) => g.foundation_id)),
    [filteredGrants],
  );
  const visibleRecipientIds = useMemo(
    () => new Set(filteredGrants.map((g) => g.recipient_id)),
    [filteredGrants],
  );

  const totals = useMemo(
    () => ({
      grantCount: filteredGrants.length,
      totalAmount: filteredGrants.reduce((sum, g) => sum + g.amount_usd, 0),
      foundationCount: visibleFoundationIds.size,
      recipientCount: visibleRecipientIds.size,
    }),
    [filteredGrants, visibleFoundationIds.size, visibleRecipientIds.size],
  );

  // Aggregate edges and compute which recipients appear in the graph.
  // minAmount acts as an edge threshold (graph only — ledger ignores it).
  const graphRecipientData = useMemo(() => {
    const pairTotals = new Map<string, number>();
    const pairMechCounts = new Map<string, Map<string, number>>();

    for (const grant of filteredGrants) {
      const key = `${grant.foundation_id}||${grant.recipient_id}`;
      pairTotals.set(key, (pairTotals.get(key) ?? 0) + grant.amount_usd);
      if (!pairMechCounts.has(key)) pairMechCounts.set(key, new Map());
      const mc = pairMechCounts.get(key)!;
      mc.set(grant.mechanism, (mc.get(grant.mechanism) ?? 0) + 1);
    }

    // Dominant mechanism for each pair (most frequent across its grants)
    const pairMechanisms = new Map<string, string>();
    for (const [key, counts] of pairMechCounts) {
      let best = "unclear";
      let bestN = 0;
      for (const [mech, n] of counts) {
        if (n > bestN) { bestN = n; best = mech; }
      }
      pairMechanisms.set(key, best);
    }

    // Apply edge threshold
    const recipientTotals = new Map<string, number>();
    for (const [key, amount] of pairTotals) {
      if (minAmount > 0 && amount < minAmount) continue;
      const recipientId = key.split("||")[1];
      recipientTotals.set(recipientId, (recipientTotals.get(recipientId) ?? 0) + amount);
    }

    const totalCount = recipientTotals.size;
    const topIds = new Set(
      [...recipientTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_RECIPIENT_COUNT)
        .map(([id]) => id),
    );

    return { topIds, pairTotals, pairMechanisms, recipientTotals, totalCount };
  }, [filteredGrants, minAmount]);

  const graphElements = useMemo(() => {
    const { topIds, pairTotals, pairMechanisms, recipientTotals } = graphRecipientData;

    const foundationTotals = new Map<string, number>();
    const graphFoundationIds = new Set<string>();
    for (const [key, amount] of pairTotals) {
      if (minAmount > 0 && amount < minAmount) continue;
      const [foundationId, recipientId] = key.split("||");
      if (!topIds.has(recipientId)) continue;
      foundationTotals.set(foundationId, (foundationTotals.get(foundationId) ?? 0) + amount);
      graphFoundationIds.add(foundationId);
    }

    const foundationNodes = dataset.foundations
      .filter((f) => graphFoundationIds.has(f.id))
      .map((f) => ({
        data: {
          id: f.id,
          label: f.name,
          type: f.entity_type,
          size: 50 + Math.min(40, Math.round((foundationTotals.get(f.id) ?? 0) / 5_000_000)),
        },
      }));

    const recipientNodes = dataset.recipients
      .filter((r) => topIds.has(r.id))
      .map((r) => ({
        data: {
          id: r.id,
          label: r.name,
          type: r.entity_type,
          size: 15 + Math.min(45, Math.round((recipientTotals.get(r.id) ?? 0) / 200_000)),
        },
      }));

    const edges: { data: { id: string; source: string; target: string; amount: number; mechanism: string } }[] = [];
    for (const [key, amount] of pairTotals) {
      if (minAmount > 0 && amount < minAmount) continue;
      const [source, target] = key.split("||");
      if (!topIds.has(target)) continue;
      edges.push({ data: { id: key, source, target, amount, mechanism: pairMechanisms.get(key) ?? "unclear" } });
    }

    return [...foundationNodes, ...recipientNodes, ...edges];
  }, [dataset.foundations, dataset.recipients, graphRecipientData, minAmount]);

  const selectedId = selection?.type === "node" ? selection.id : null;

  const activeGrant = useMemo(() => {
    if (selection?.type === "grant") {
      return filteredGrants.find((g) => g.id === selection.id) ?? null;
    }
    return defaultFilteredGrant;
  }, [defaultFilteredGrant, filteredGrants, selection]);

  const activeNode = useMemo(() => {
    if (selection?.type !== "node") return null;
    return foundationMap.get(selection.id) ?? recipientMap.get(selection.id) ?? null;
  }, [foundationMap, recipientMap, selection]);

  useEffect(() => {
    if (!selection) {
      if (defaultFilteredGrant) setSelection({ type: "grant", id: defaultFilteredGrant.id });
      return;
    }
    if (selection.type === "grant" && !filteredGrants.some((g) => g.id === selection.id)) {
      setSelection(defaultFilteredGrant ? { type: "grant", id: defaultFilteredGrant.id } : null);
      return;
    }
    if (
      selection.type === "node" &&
      !filteredGrants.some((g) => selection.id === g.foundation_id || selection.id === g.recipient_id)
    ) {
      setSelection(defaultFilteredGrant ? { type: "grant", id: defaultFilteredGrant.id } : null);
    }
  }, [defaultFilteredGrant, filteredGrants, selection]);

  const relatedGrants = useMemo(() => {
    if (activeNode) {
      return filteredGrants
        .filter((g) =>
          activeNode.entity_type === "foundation" ? g.foundation_id === activeNode.id : g.recipient_id === activeNode.id,
        )
        .sort((a, b) => b.amount_usd - a.amount_usd);
    }
    if (activeGrant) return [activeGrant];
    return filteredGrants;
  }, [activeGrant, activeNode, filteredGrants]);

  function toggleFoundation(id: string) {
    setSelectedFoundationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function isFoundationActive(id: string) {
    return selectedFoundationIds.size === 0 || selectedFoundationIds.has(id);
  }

  return (
    <section className="grid gap-6">
      <Card className="border-accent/20">
        <CardHeader className="gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Network className="h-4 w-4 text-accent" />
                <span>Money Map</span>
              </div>
              <CardTitle>Foundation-to-recipient flow view</CardTitle>
              <CardDescription className="max-w-3xl">
                Filter the visible network, inspect a grant edge or entity node, and open the
                filing PDF directly from the detail rail or the ledger below.
              </CardDescription>
            </div>

            <div className="grid gap-2 rounded-xl border border-border/70 bg-background/60 p-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <Landmark className="h-3.5 w-3.5 text-accent" />
                <span>Foundations use circular nodes.</span>
              </div>
              <div className="flex items-center gap-2">
                <Rows3 className="h-3.5 w-3.5 text-accent" />
                <span>Recipients use rounded rectangular nodes.</span>
              </div>
              <div className="flex items-center gap-2">
                <Scale className="h-3.5 w-3.5 text-accent" />
                <span>Edge weight scales with reported grant amount.</span>
              </div>
            </div>
          </div>

          <div className="grid gap-4">
            <div className="grid gap-4 lg:grid-cols-[1fr_1fr_0.65fr_0.65fr_0.65fr_auto]">
              <FilterField label="Tax year">
                <select
                  className="h-11 rounded-xl border border-border bg-surface px-3 text-sm outline-none transition focus:border-accent"
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(e.target.value)}
                >
                  <option value="all">All years</option>
                  {years.map((year) => (
                    <option key={year} value={String(year)}>
                      {year}
                    </option>
                  ))}
                </select>
              </FilterField>

              <FilterField label="Recipient search">
                <input
                  type="text"
                  className="h-11 rounded-xl border border-border bg-surface px-3 text-sm outline-none transition focus:border-accent"
                  placeholder="Search recipients…"
                  value={recipientSearch}
                  onChange={(e) => setRecipientSearch(e.target.value)}
                />
              </FilterField>

              <FilterField label="Graph edge min ($)">
                <input
                  type="number"
                  className="h-11 rounded-xl border border-border bg-surface px-3 text-sm outline-none transition focus:border-accent"
                  placeholder="0"
                  min={0}
                  value={minAmount || ""}
                  onChange={(e) => setMinAmount(Number(e.target.value) || 0)}
                />
              </FilterField>

              <MetricTile label="Visible grants" value={String(totals.grantCount)} />
              <MetricTile label="Visible volume" value={formatCurrency(totals.totalAmount)} />

              <div className="flex items-end">
                <Button
                  variant="ghost"
                  className="h-11 w-full"
                  onClick={() => {
                    setSelectedYear("all");
                    setSelectedFoundationIds(new Set());
                    setRecipientSearch("");
                    setMinAmount(0);
                    setSelectedMechanisms(new Set(ALL_MECHANISMS));
                    setSelection(defaultGrant ? { type: "grant", id: defaultGrant.id } : null);
                  }}
                >
                  Reset filters
                </Button>
              </div>
            </div>

            <div className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Foundations</span>
              <div className="flex flex-wrap gap-2">
                {dataset.foundations.map((f) => {
                  // Schusterman (73-1312965) files grants as a PDF attachment — no XML grant data
                  const isNoXml = f.location === "73-1312965";
                  return (
                    <button
                      key={f.id}
                      onClick={() => toggleFoundation(f.id)}
                      title={
                        isNoXml
                          ? "Grant schedule filed as PDF attachment — individual grants not available in XML data"
                          : undefined
                      }
                      className={[
                        "rounded-lg border px-3 py-1.5 text-xs font-medium transition",
                        isFoundationActive(f.id)
                          ? "border-accent/60 bg-accent/15 text-foreground"
                          : "border-border bg-transparent text-muted-foreground hover:border-accent/40",
                      ].join(" ")}
                    >
                      {f.name}
                      {isNoXml && (
                        <span
                          className="ml-1 text-muted-foreground/50"
                          aria-label="no XML grant data available"
                        >
                          *
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground/50">
                * Grant schedule filed as PDF attachment — individual grants not available in XML data
              </p>
            </div>

            <div className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Grant mechanism</span>
              <div className="flex flex-wrap gap-2">
                {ALL_MECHANISMS.map((mech) => (
                  <button
                    key={mech}
                    onClick={() =>
                      setSelectedMechanisms((prev) => {
                        const next = new Set(prev);
                        if (next.has(mech)) next.delete(mech);
                        else next.add(mech);
                        return next;
                      })
                    }
                    className={[
                      "rounded-lg border px-3 py-1.5 text-xs font-medium transition",
                      selectedMechanisms.has(mech)
                        ? "border-accent/60 bg-accent/15 text-foreground"
                        : "border-border bg-transparent text-muted-foreground hover:border-accent/40",
                    ].join(" ")}
                  >
                    {MECHANISM_LABELS[mech]}
                  </button>
                ))}
              </div>

              <div>
                <button
                  onClick={() => setMechInfoOpen((v) => !v)}
                  className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
                >
                  <ChevronDown
                    className={[
                      "h-3.5 w-3.5 transition-transform duration-200",
                      mechInfoOpen ? "rotate-180" : "",
                    ].join(" ")}
                  />
                  What do these categories mean?
                </button>

                {mechInfoOpen && (
                  <div className="mt-4 grid gap-5 border-l border-border/50 pl-4">
                    <div className="grid gap-1.5">
                      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#7a5c2e" }}>
                        Directed
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Grants where the filing&rsquo;s purpose text specifies a program, project, or deliverable. The funder has stated what the money is for.
                      </p>
                      <p className="text-xs text-zinc-500">
                        Questions this raises: Which recipients receive primarily directed funding — and what are they being directed to do? When a funder shifts from general support to directed grants with the same recipient, what changed? Do directed grants to policy organizations cluster around specific legislative cycles or geopolitical events?
                      </p>
                    </div>

                    <div className="grid gap-1.5">
                      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#8a7a5a" }}>
                        General
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Unrestricted operating support — &ldquo;general support,&rdquo; &ldquo;core support,&rdquo; or blank purpose text. The funder provides capital without stated programmatic constraints.
                      </p>
                      <p className="text-xs text-zinc-500">
                        Questions this raises: What share of a recipient&rsquo;s total funding is unrestricted? Organizations with high general-support ratios have more autonomy over how funds are deployed — does this correlate with the scale or longevity of the funder-recipient relationship? When a funder gives general support to an advocacy organization, is the absence of a stated purpose itself informative?
                      </p>
                    </div>

                    <div className="grid gap-1.5">
                      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#927949" }}>
                        Matching
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Grants flagged as matching gift programs — typically employer-match or donor-advised fund pass-throughs. The funder is matching an individual donor&rsquo;s contribution rather than making an independent allocation decision.
                      </p>
                      <p className="text-xs text-zinc-500">
                        Questions this raises: Matching gifts reveal individual donor interest patterns routed through institutional channels. Which recipients attract the most matching gift volume, and does that pattern differ from the foundation&rsquo;s direct grantmaking priorities? Are matching gifts concentrated among a foundation&rsquo;s employees or board members?
                      </p>
                    </div>

                    <div className="grid gap-1.5">
                      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#9a8e75" }}>
                        Unclear
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Purpose text exists but is too brief or vague to classify as directed or general — short descriptions, ambiguous language, or non-standard phrasing.
                      </p>
                      <p className="text-xs text-zinc-500">
                        Questions this raises: A high proportion of unclear grants for a given foundation may indicate inconsistent filing practices rather than intentional ambiguity. Is the unclear rate stable across tax years, or does it change when filing requirements tighten?
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <Card className="overflow-hidden">
          <CardContent className="grid gap-4 px-4 py-4 md:px-6 md:py-6">
            <div className="flex items-center justify-between gap-3 px-1">
              <p className="text-sm text-muted-foreground">
                {totals.foundationCount} foundations linked to {totals.recipientCount} recipients in
                the current view.
              </p>
              <Badge>{formatCurrency(totals.totalAmount)}</Badge>
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              Showing top {TOP_RECIPIENT_COUNT} recipients by grant volume
              &nbsp;·&nbsp;
              {graphRecipientData.topIds.size} of {graphRecipientData.totalCount} recipients visible
            </p>
            <MoneyMapGraph
              elements={graphElements}
              selectedId={selectedId}
              onSelectNode={(nodeId) => setSelection({ type: "node", id: nodeId })}
              onClearSelection={() =>
                setSelection(defaultFilteredGrant ? { type: "grant", id: defaultFilteredGrant.id } : null)
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Detail Rail</CardTitle>
            <CardDescription>
              Grant-level review stays linked to the filing source, while node-level review rolls up
              totals without adding interpretation.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {activeNode ? (
              <NodeDetail
                entity={activeNode}
                grants={relatedGrants}
                foundationMap={foundationMap}
                recipientMap={recipientMap}
              />
            ) : activeGrant ? (
              <GrantDetail
                grant={activeGrant}
                foundation={foundationMap.get(activeGrant.foundation_id)}
                recipient={recipientMap.get(activeGrant.recipient_id)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">No records match the active filters.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <TimelinePanel grants={filteredGrants} foundations={dataset.foundations} />

      <Card>
        <CardHeader
          className="cursor-pointer select-none"
          onClick={() => setLedgerOpen((v) => !v)}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-2xl">Grant Ledger</CardTitle>
              <CardDescription>
                {filteredGrants.length} records · click to {ledgerOpen ? "collapse" : "expand"}
              </CardDescription>
            </div>
            <ChevronDown
              className={[
                "h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200",
                ledgerOpen ? "rotate-180" : "",
              ].join(" ")}
            />
          </div>
        </CardHeader>
        {ledgerOpen && <CardContent className="overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-y-2">
            <thead>
              <tr className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                <th className="px-3 py-2">Year</th>
                <th className="px-3 py-2">Foundation</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Purpose</th>
                <th className="px-3 py-2">Mechanism</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {filteredGrants
                .slice()
                .sort((a, b) => b.amount_usd - a.amount_usd)
                .map((grant) => {
                  const foundation = foundationMap.get(grant.foundation_id);
                  const recipient = recipientMap.get(grant.recipient_id);
                  const isSelected = selection?.type === "grant" && selection.id === grant.id;

                  return (
                    <tr
                      key={grant.id}
                      className="cursor-pointer rounded-2xl border border-border/80 bg-background/65 text-sm transition hover:border-accent/40 hover:bg-accent/5"
                      onClick={() => setSelection({ type: "grant", id: grant.id })}
                    >
                      <td className="rounded-l-2xl px-3 py-3 align-top font-medium">{grant.year}</td>
                      <td className="px-3 py-3 align-top">
                        <div className="grid gap-1">
                          <span className={isSelected ? "font-semibold text-foreground" : "font-medium"}>
                            {foundation?.name}
                          </span>
                          <span className="text-xs text-muted-foreground">{foundation?.location}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="grid gap-1">
                          <span className={isSelected ? "font-semibold text-foreground" : "font-medium"}>
                            {recipient?.name}
                          </span>
                          <span className="text-xs text-muted-foreground">{recipient?.category}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top text-muted-foreground">{grant.purpose}</td>
                      <td className="px-3 py-3 align-top">
                        <span className="rounded-md border border-border/60 bg-surface px-2 py-0.5 text-xs text-muted-foreground">
                          {MECHANISM_LABELS[grant.mechanism]}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top font-semibold">{formatCurrency(grant.amount_usd)}</td>
                      <td className="rounded-r-2xl px-3 py-3 align-top">
                        <a
                          className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:text-foreground"
                          href={grant.filing_url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Filing PDF
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </CardContent>}
      </Card>
    </section>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-2 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-xl border border-border bg-surface px-4 py-3">
      <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
      <strong className="text-lg font-semibold text-foreground">{value}</strong>
    </div>
  );
}

function GrantDetail({
  grant,
  foundation,
  recipient,
}: {
  grant: Grant;
  foundation?: Foundation;
  recipient?: Recipient;
}) {
  return (
    <div className="grid gap-4">
      <div className="space-y-2">
        <Badge>Grant record</Badge>
        <h3 className="font-serif text-3xl tracking-[-0.03em]">{formatCurrency(grant.amount_usd)}</h3>
        <p className="text-sm text-muted-foreground">
          {foundation?.name} to {recipient?.name}
        </p>
      </div>

      <dl className="grid gap-3 rounded-xl border border-border/70 bg-background/55 p-4 text-sm">
        <DetailRow label="Tax year" value={String(grant.year)} />
        <DetailRow label="Purpose" value={grant.purpose} />
        <DetailRow label="Foundation base" value={foundation?.location ?? "Unknown"} />
        <DetailRow label="Recipient base" value={recipient?.location ?? "Unknown"} />
      </dl>

      <a
        href={grant.filing_url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:text-foreground"
      >
        Open IRS filing PDF
        <ExternalLink className="h-4 w-4" />
      </a>
    </div>
  );
}

function NodeDetail({
  entity,
  grants,
  foundationMap,
  recipientMap,
}: {
  entity: Foundation | Recipient;
  grants: Grant[];
  foundationMap: Map<string, Foundation>;
  recipientMap: Map<string, Recipient>;
}) {
  const total = grants.reduce((sum, g) => sum + g.amount_usd, 0);

  return (
    <div className="grid gap-4">
      <div className="space-y-2">
        <Badge>{entity.entity_type}</Badge>
        <h3 className="font-serif text-3xl tracking-[-0.03em]">{entity.name}</h3>
        <p className="text-sm text-muted-foreground">{entity.location}</p>
      </div>

      <dl className="grid gap-3 rounded-xl border border-border/70 bg-background/55 p-4 text-sm">
        <DetailRow label="Visible grant count" value={String(grants.length)} />
        <DetailRow
          label={entity.entity_type === "foundation" ? "Visible outflow" : "Visible inflow"}
          value={formatCurrency(total)}
        />
        <DetailRow
          label="Connected organizations"
          value={String(
            new Set(
              grants.map((g) =>
                entity.entity_type === "foundation" ? g.recipient_id : g.foundation_id,
              ),
            ).size,
          )}
        />
        {"category" in entity ? <DetailRow label="Category" value={entity.category} /> : null}
      </dl>

      <div className="grid gap-3">
        <p className="text-sm font-medium text-foreground">Linked grants</p>
        <div className="grid gap-2">
          {grants.map((grant) => {
            const counterpart =
              entity.entity_type === "foundation"
                ? recipientMap.get(grant.recipient_id)?.name
                : foundationMap.get(grant.foundation_id)?.name;

            return (
              <div
                key={grant.id}
                className="rounded-xl border border-border/70 bg-surface px-4 py-3 text-sm text-muted-foreground"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-foreground">{counterpart}</span>
                  <span className="font-semibold text-foreground">{formatCurrency(grant.amount_usd)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span>{grant.year}</span>
                  <a
                    href={grant.filing_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-accent hover:text-foreground"
                  >
                    Filing
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}
