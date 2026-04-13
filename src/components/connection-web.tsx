"use client";

import { ExternalLink, Network, Table2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { Connection, PersonnelRole } from "@/types/connections";
import type { Foundation } from "@/types/money-map";

const ConnectionGraph = dynamic(
  () => import("@/components/connection-graph").then((m) => m.ConnectionGraph),
  { ssr: false },
);

type ConnectionWebProps = {
  connections: Connection[];
  foundations: Foundation[];
};

type EdgeSelection = { edgeId: string; connection: Connection } | null;
type NodeSelection = { orgId: string; orgName: string; roles: PersonnelRole[] } | null;

export function ConnectionWebPanel({ connections, foundations }: ConnectionWebProps) {
  const [view, setView] = useState<"graph" | "table">("graph");
  const [edgeSelection, setEdgeSelection] = useState<EdgeSelection>(null);
  const [nodeSelection, setNodeSelection] = useState<NodeSelection>(null);
  const [tableSortByType, setTableSortByType] = useState(false);

  const { graphNodes, graphEdges, edgeMap, bridgeCount, concurrentBridgeCount } = useMemo(() => {
    // Collect orgs from connections
    const orgMap = new Map<string, { label: string; type: "foundation" | "recipient" }>();

    // Always include all foundations as nodes so graph isn't blank in Phase 1
    for (const f of foundations) {
      orgMap.set(f.location.replace(/-/g, ""), {
        label: f.name,
        type: "foundation",
      });
    }

    // Add any recipient orgs from connections
    for (const conn of connections) {
      for (const role of conn.roles) {
        const einKey = role.organization_ein.replace(/-/g, "");
        if (!orgMap.has(einKey)) {
          orgMap.set(einKey, {
            label: role.organization_name,
            type: role.organization_type,
          });
        }
      }
    }

    const graphNodes = [...orgMap.entries()].map(([id, { label, type }]) => ({
      id,
      label,
      type,
    }));

    // Build edges: one per org-pair, accumulating shared people
    const pairMap = new Map<
      string,
      { source: string; target: string; count: number; people: string[]; concurrent: boolean }
    >();
    const edgeMap = new Map<string, Connection>(); // edgeId → connection (for detail rail)

    for (const conn of connections) {
      const orgEins = [
        ...new Set(conn.roles.map((r) => r.organization_ein.replace(/-/g, ""))),
      ].sort();

      // Pairwise edges for multi-org connections
      for (let i = 0; i < orgEins.length; i++) {
        for (let j = i + 1; j < orgEins.length; j++) {
          const key = `${orgEins[i]}||${orgEins[j]}`;
          const existing = pairMap.get(key);
          if (existing) {
            existing.count++;
            existing.people.push(conn.person_name);
            // edge is concurrent if any contributing connection is concurrent
            if (conn.concurrent) existing.concurrent = true;
          } else {
            pairMap.set(key, {
              source: orgEins[i],
              target: orgEins[j],
              count: 1,
              people: [conn.person_name],
              concurrent: conn.concurrent,
            });
          }
          edgeMap.set(key, conn);
        }
      }
    }

    const graphEdges = [...pairMap.entries()].map(([key, { source, target, count, people, concurrent }]) => {
      const sourceType = orgMap.get(source)?.type;
      const targetType = orgMap.get(target)?.type;
      const bridge = (sourceType === "foundation") !== (targetType === "foundation");
      return { id: key, source, target, weight: count, peopleLabel: people.join(", "), bridge, concurrent };
    });

    // Count connections (people) that bridge foundation ↔ recipient
    const bridgeConnections = connections.filter((c) => {
      const types = new Set(c.roles.map((r) => r.organization_type));
      return types.has("foundation") && types.has("recipient");
    });
    const bridgeCount = bridgeConnections.length;
    const concurrentBridgeCount = bridgeConnections.filter((c) => c.concurrent).length;

    return { graphNodes, graphEdges, edgeMap, bridgeCount, concurrentBridgeCount };
  }, [connections, foundations]);

  const selectedId = useMemo(() => {
    if (edgeSelection) return edgeSelection.edgeId;
    if (nodeSelection) return nodeSelection.orgId;
    return null;
  }, [edgeSelection, nodeSelection]);

  function handleSelectEdge(edgeId: string) {
    const conn = edgeMap.get(edgeId);
    if (conn) {
      setEdgeSelection({ edgeId, connection: conn });
      setNodeSelection(null);
    }
  }

  function handleSelectNode(orgId: string) {
    const node = graphNodes.find((n) => n.id === orgId);
    if (!node) return;

    // Collect all roles at this org from all connections
    const roles: PersonnelRole[] = [];
    for (const conn of connections) {
      for (const role of conn.roles) {
        if (role.organization_ein.replace(/-/g, "") === orgId) {
          roles.push(role);
        }
      }
    }

    setNodeSelection({ orgId, orgName: node.label, roles });
    setEdgeSelection(null);
  }

  function handleClearSelection() {
    setEdgeSelection(null);
    setNodeSelection(null);
  }

  const sortedConnections = useMemo(() => {
    const isBridge = (c: Connection) =>
      c.roles.some((r) => r.organization_type === "foundation") &&
      c.roles.some((r) => r.organization_type === "recipient");

    return [...connections].sort((a, b) => {
      if (tableSortByType) {
        const aBridge = isBridge(a) ? 0 : 1;
        const bBridge = isBridge(b) ? 0 : 1;
        if (aBridge !== bBridge) return aBridge - bBridge;
      }
      return b.organization_count - a.organization_count || a.person_name.localeCompare(b.person_name);
    });
  }, [connections, tableSortByType]);

  return (
    <section className="grid gap-6">
      <Card className="border-accent/20">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Network className="h-4 w-4 text-accent" />
                <span>Connection Web</span>
              </div>
              <CardTitle>Personnel overlaps across organizations</CardTitle>
              <CardDescription className="max-w-3xl">
                {connections.length > 0 ? (
                  <>
                    {connections.length} personnel connections across {graphNodes.length} organizations
                    {bridgeCount > 0 && (
                      <> · <span className="font-medium text-foreground">{bridgeCount} foundation-recipient bridges</span>{" "}
                      ({concurrentBridgeCount} concurrent · {bridgeCount - concurrentBridgeCount} sequential)</>
                    )}
                  </>
                ) : (
                  <>Individuals identified in Part VII officer/director/trustee disclosures across multiple organizations.</>
                )}
              </CardDescription>
            </div>

            <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/60 p-1">
              <button
                onClick={() => setView("graph")}
                className={[
                  "flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition",
                  view === "graph"
                    ? "bg-accent/15 text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                <Network className="h-3.5 w-3.5" />
                Graph
              </button>
              <button
                onClick={() => setView("table")}
                className={[
                  "flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition",
                  view === "table"
                    ? "bg-accent/15 text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                <Table2 className="h-3.5 w-3.5" />
                Table
              </button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {view === "graph" ? (
        <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          <Card className="overflow-hidden">
            <CardContent className="grid gap-4 px-4 py-4 md:px-6 md:py-6">
              <div className="flex items-center justify-between gap-3 px-1">
                <p className="text-sm text-muted-foreground">
                  {graphNodes.length} organizations · {graphEdges.length} shared-personnel edges
                </p>
                {connections.length === 0 && (
                  <span className="rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                    no cross-org overlaps found
                  </span>
                )}
              </div>

              {connections.length === 0 && (
                <div className="rounded-xl border border-border/60 bg-surface px-4 py-3 text-sm text-muted-foreground">
                  No board or officer overlaps found among the 8 foundations.
                  These organizations operate with entirely separate governance structures.
                </div>
              )}

              <ConnectionGraph
                nodes={graphNodes}
                edges={graphEdges}
                selectedId={selectedId}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                onClearSelection={handleClearSelection}
              />

              {connections.length > 0 && (
                <p className="px-1 text-xs text-muted-foreground">
                  <span className="mr-3 inline-flex items-center gap-1.5">
                    <span className="inline-block h-px w-5 bg-[#7a5c2e] opacity-90" />
                    Solid edges = foundation↔recipient bridge
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-px w-5 border-t border-dashed border-[#bfae8a]" />
                    Dashed edges = recipient↔recipient overlap
                  </span>
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Detail Rail</CardTitle>
              <CardDescription>
                Click an edge to inspect the shared individual. Click a node to see that
                organization&rsquo;s Part VII disclosures across all filings.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              {edgeSelection ? (
                <ConnectionDetail connection={edgeSelection.connection} />
              ) : nodeSelection ? (
                <OrgDetail orgName={nodeSelection.orgName} roles={nodeSelection.roles} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {connections.length === 0
                    ? "Select a foundation node to view its Part VII disclosures."
                    : "Select an edge or node to inspect personnel details."}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Connections Table</CardTitle>
            <CardDescription>
              Individuals appearing in Part VII disclosures of 2+ distinct organizations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sortedConnections.length === 0 ? (
              <div className="py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  No cross-organizational connections found in Phase 1.
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  Phase 2 will run ProPublica lookups for 534 US-based grantee organizations
                  and re-match against the 147 individuals already extracted from foundation filings.
                </p>
              </div>
            ) : (
              <ConnectionTable
                connections={sortedConnections}
                sortByType={tableSortByType}
                onToggleSortByType={() => setTableSortByType((v) => !v)}
              />
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConnectionDetail({ connection }: { connection: Connection }) {
  const orgNames = [...new Set(connection.roles.map((r) => r.organization_name))];

  return (
    <div className="grid gap-4">
      <div className="space-y-2">
        <Badge>Shared person</Badge>
        <h3 className="font-serif text-3xl tracking-[-0.03em]">{connection.person_name}</h3>
        <p className="text-sm text-muted-foreground">
          Appears in {connection.organization_count} organizations
        </p>
      </div>

      <dl className="grid gap-3 rounded-xl border border-border/70 bg-background/55 p-4 text-sm">
        <DetailRow label="Organizations" value={orgNames.join(", ")} />
        <DetailRow label="Total roles" value={String(connection.roles.length)} />
      </dl>

      <div className="grid gap-2">
        {connection.roles.map((role, i) => (
          <RoleCard key={i} role={role} />
        ))}
      </div>
    </div>
  );
}

function OrgDetail({ orgName, roles }: { orgName: string; roles: PersonnelRole[] }) {
  if (roles.length === 0) {
    return (
      <div className="grid gap-4">
        <div className="space-y-2">
          <Badge>Organization</Badge>
          <h3 className="font-serif text-2xl tracking-[-0.03em]">{orgName}</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          No cross-org personnel connections found for this organization in Phase 1.
        </p>
      </div>
    );
  }

  const totalComp = roles.reduce((sum, r) => sum + (r.compensation ?? 0), 0);
  const years = [...new Set(roles.map((r) => r.tax_year))].sort();

  return (
    <div className="grid gap-4">
      <div className="space-y-2">
        <Badge>Organization</Badge>
        <h3 className="font-serif text-2xl tracking-[-0.03em]">{orgName}</h3>
      </div>

      <dl className="grid gap-3 rounded-xl border border-border/70 bg-background/55 p-4 text-sm">
        <DetailRow label="Shared roles" value={String(roles.length)} />
        <DetailRow label="Years covered" value={`${Math.min(...years)}–${Math.max(...years)}`} />
        {totalComp > 0 && <DetailRow label="Total compensation" value={formatCurrency(totalComp)} />}
      </dl>

      <div className="grid gap-2">
        {roles.map((role, i) => (
          <RoleCard key={i} role={role} />
        ))}
      </div>
    </div>
  );
}

function RoleCard({ role }: { role: PersonnelRole }) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-foreground">{role.organization_name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{role.title}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">{role.tax_year}</p>
          {role.compensation != null && role.compensation > 0 && (
            <p className="text-xs font-medium text-foreground">{formatCurrency(role.compensation)}</p>
          )}
        </div>
      </div>
      {role.filing_url && (
        <a
          href={role.filing_url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:text-foreground"
        >
          IRS filing
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

function ConnectionTable({
  connections,
  sortByType,
  onToggleSortByType,
}: {
  connections: Connection[];
  sortByType: boolean;
  onToggleSortByType: () => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-y-2">
        <thead>
          <tr className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
            <th className="px-3 py-2">Person</th>
            <th className="px-3 py-2">Organization 1</th>
            <th className="px-3 py-2">Title 1</th>
            <th className="px-3 py-2">Organization 2</th>
            <th className="px-3 py-2">Title 2</th>
            <th className="px-3 py-2">Years</th>
            <th className="px-3 py-2">
              <button
                onClick={onToggleSortByType}
                className={[
                  "flex items-center gap-1 transition",
                  sortByType ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                Type
                <span className="text-[10px]">{sortByType ? "↑" : "⇅"}</span>
              </button>
            </th>
            <th className="px-3 py-2">Timing</th>
            <th className="px-3 py-2">Filings</th>
          </tr>
        </thead>
        <tbody>
          {connections.map((conn) => {
            const orgs = [...new Map(conn.roles.map((r) => [r.organization_ein, r])).values()];
            const org1 = orgs[0];
            const org2 = orgs[1];
            const years = [...new Set(conn.roles.map((r) => r.tax_year))].sort();
            const isBridge =
              conn.roles.some((r) => r.organization_type === "foundation") &&
              conn.roles.some((r) => r.organization_type === "recipient");
            return (
              <tr
                key={conn.match_key}
                className="rounded-2xl border border-border/80 bg-background/65 text-sm"
              >
                <td className="rounded-l-2xl px-3 py-3 align-top font-medium">
                  {conn.person_name}
                </td>
                <td className="px-3 py-3 align-top text-muted-foreground">
                  {org1?.organization_name}
                </td>
                <td className="px-3 py-3 align-top text-muted-foreground">{org1?.title}</td>
                <td className="px-3 py-3 align-top text-muted-foreground">
                  {org2?.organization_name}
                </td>
                <td className="px-3 py-3 align-top text-muted-foreground">{org2?.title}</td>
                <td className="px-3 py-3 align-top text-muted-foreground">
                  {years.length === 1 ? years[0] : `${years[0]}–${years[years.length - 1]}`}
                </td>
                <td className="px-3 py-3 align-top">
                  {isBridge ? (
                    <span className="rounded-md bg-accent/15 px-2 py-0.5 text-xs font-medium text-foreground">
                      Bridge
                    </span>
                  ) : (
                    <span className="rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                      Overlap
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 align-top">
                  {conn.concurrent ? (
                    <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      Concurrent
                    </span>
                  ) : (
                    <span className="rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                      Sequential
                    </span>
                  )}
                </td>
                <td className="rounded-r-2xl px-3 py-3 align-top">
                  <div className="flex flex-col gap-1">
                    {conn.roles
                      .filter((r) => r.filing_url)
                      .slice(0, 2)
                      .map((r, i) => (
                        <a
                          key={i}
                          href={r.filing_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-accent hover:text-foreground"
                        >
                          {r.tax_year}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

