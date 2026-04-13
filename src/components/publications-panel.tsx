"use client";

import { ChevronDown, ExternalLink } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Publication } from "@/types/publications";

const BAR_COLOR = "#927949";
const TOP_ORG_COUNT = 15;
const RECENT_LIST_COUNT = 30;

type OrgBarEntry = { name: string; fullName: string; count: number };

function OrgBarTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: OrgBarEntry }[];
}) {
  if (!active || !payload?.length) return null;
  const { fullName, count } = payload[0].payload;
  return (
    <div className="min-w-44 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 shadow-lg">
      <p className="mb-1 font-semibold leading-snug">{fullName}</p>
      <p className="text-zinc-300">
        {count} <span className="text-zinc-400">headlines</span>
      </p>
    </div>
  );
}

function OrgMentionsChart({ data }: { data: OrgBarEntry[] }) {
  if (!data.length) return null;
  return (
    <ResponsiveContainer width="100%" height={data.length * 32 + 24}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 32, bottom: 4, left: 0 }}
        barCategoryGap="28%"
      >
        <CartesianGrid horizontal={false} strokeDasharray="3 4" stroke="rgba(120,105,80,0.15)" />
        <XAxis
          type="number"
          axisLine={false}
          tickLine={false}
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          axisLine={false}
          tickLine={false}
          tick={{ fill: "#78716c", fontSize: 11 }}
          width={148}
        />
        <Tooltip
          cursor={{ fill: "rgba(146,121,73,0.08)" }}
          content={(props) => (
            <OrgBarTooltip
              active={props.active}
              payload={props.payload as unknown as { payload: OrgBarEntry }[] | undefined}
            />
          )}
        />
        <Bar dataKey="count" fill={BAR_COLOR} radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const OrgMentionsChartDynamic = dynamic(
  () => Promise.resolve(OrgMentionsChart),
  { ssr: false },
);

type PublicationsPanelProps = {
  publications: Publication[];
  grantYearRange?: { start: number; end: number };
};

export function PublicationsPanel({ publications }: PublicationsPanelProps) {
  const [headlinesOpen, setHeadlinesOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const { orgData, orgCount } = useMemo(() => {
    const orgCounts = new Map<string, number>();
    for (const pub of publications) {
      orgCounts.set(pub.recipient_name, (orgCounts.get(pub.recipient_name) ?? 0) + 1);
    }

    function shortName(name: string): string {
      let n = name
        .replace(/^American Friends Of The\s+/i, "")
        .replace(/^American Friends Of\s+/i, "");
      n = n.replace(/,?\s*(Inc|LLC|Ltd|Corp|Incorporated|Limited)\.?\s*$/i, "").trim();
      if (n.length > 26) n = n.slice(0, 24) + "…";
      return n;
    }

    const orgData: OrgBarEntry[] = [...orgCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_ORG_COUNT)
      .map(([name, count]) => ({ name: shortName(name), fullName: name, count }))
      .reverse(); // bottom-up for horizontal bar chart

    return { orgData, orgCount: orgCounts.size };
  }, [publications]);

  const recentPubs = useMemo(
    () =>
      [...publications]
        .filter((p) => p.title && p.url)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [publications],
  );

  const visiblePubs = showAll ? recentPubs : recentPubs.slice(0, RECENT_LIST_COUNT);

  if (publications.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Media Footprint</CardTitle>
          <CardDescription>
            Run <code className="rounded bg-muted px-1 py-0.5 text-xs">python3 scripts/collect_publications.py</code> to
            populate this panel.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Media Footprint</CardTitle>
        <CardDescription className="max-w-3xl">
          {publications.length.toLocaleString()} headlines found across {orgCount} organizations via Google News RSS ·{" "}
          <span className="italic text-muted-foreground/80">
            Google News RSS returns a limited, recency-biased sample. This panel shows relative
            media visibility across organizations, not absolute volume or trends over time.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 px-2 pb-4 md:px-4">
        {/* Org mentions bar chart */}
        <div className="grid gap-2">
          <p className="px-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Total headlines · top {TOP_ORG_COUNT} organizations
          </p>
          <OrgMentionsChartDynamic data={orgData} />
        </div>

        {/* Recent headlines — collapsible */}
        <div className="grid gap-2">
          <button
            onClick={() => setHeadlinesOpen((v) => !v)}
            className="flex items-center justify-between gap-3 px-1 text-left"
          >
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Recent headlines · {recentPubs.length} results · click to {headlinesOpen ? "collapse" : "expand"}
            </span>
            <ChevronDown
              className={[
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                headlinesOpen ? "rotate-180" : "",
              ].join(" ")}
            />
          </button>
          {headlinesOpen && (
            <>
              <div className="grid gap-1.5">
                {visiblePubs.map((pub) => (
                  <PublicationRow key={pub.id} pub={pub} />
                ))}
              </div>
              {recentPubs.length > RECENT_LIST_COUNT && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="mt-1 text-center text-xs text-muted-foreground hover:text-foreground transition"
                >
                  {showAll ? "Show fewer" : `Show all ${recentPubs.length} headlines`}
                </button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PublicationRow({ pub }: { pub: Publication }) {
  const shortOrg = pub.recipient_name
    .replace(/^American Friends Of The\s+/i, "")
    .replace(/^American Friends Of\s+/i, "")
    .replace(/,?\s*(Inc|LLC|Ltd|Corp|Incorporated|Limited)\.?\s*$/i, "")
    .trim();

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background/50 px-3 py-2.5 text-sm">
      <div className="min-w-0">
        <a
          href={pub.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-start gap-1 font-medium text-foreground hover:text-accent transition leading-snug"
        >
          <span className="line-clamp-2">{pub.title}</span>
          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
        </a>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {shortOrg}
          {pub.venue ? <> · {pub.venue}</> : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-xs text-muted-foreground">{pub.date.slice(0, 7)}</span>
        {pub.citation_count != null && pub.citation_count > 0 && (
          <Badge className="text-[10px]">{pub.citation_count} cit.</Badge>
        )}
        {pub.source_api === "google_news" && (
          <span className="rounded border border-border/50 px-1 py-px text-[10px] text-muted-foreground">
            news
          </span>
        )}
      </div>
    </div>
  );
}
