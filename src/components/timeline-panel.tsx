"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { Foundation, Grant } from "@/types/money-map";

// 8 muted warm tones — ordered for maximum contrast between adjacent stack segments
const STACK_COLORS = [
  "#3d2510", // espresso
  "#b89050", // amber
  "#6b4820", // dark brown
  "#d4a86a", // warm gold
  "#927949", // accent brown
  "#c0a070", // tan
  "#5a3a18", // deep umber
  "#e2cc98", // pale straw
];

type TimelinePanelProps = {
  grants: Grant[];
  foundations: Foundation[];
};

function formatYAxis(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(0)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value}`;
}

type TooltipPayloadEntry = {
  dataKey: string;
  name: string;
  value: number;
  fill: string;
};

function ChartTooltip({
  active,
  payload,
  label,
  grantCounts,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  grantCounts: Map<string, Map<string, number>>;
}) {
  if (!active || !payload?.length) return null;

  const visible = payload.filter((e) => e.value > 0);
  if (!visible.length) return null;

  const yearCounts = grantCounts.get(String(label)) ?? new Map();
  const total = visible.reduce((sum, e) => sum + e.value, 0);

  return (
    <div className="min-w-52 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 shadow-lg">
      <p className="mb-2 font-semibold">{label}</p>
      <div className="grid gap-1.5">
        {visible
          .slice()
          .sort((a, b) => b.value - a.value)
          .map((entry) => {
            const count = yearCounts.get(entry.dataKey) ?? 0;
            return (
              <div key={entry.dataKey} className="flex items-start justify-between gap-4">
                <span className="flex items-center gap-1.5 text-zinc-300">
                  <span
                    className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-sm"
                    style={{ background: entry.fill }}
                  />
                  {entry.name}
                </span>
                <span className="text-right">
                  <span className="font-semibold text-zinc-100">{formatCurrency(entry.value)}</span>
                  <span className="ml-1.5 text-zinc-500">{count}g</span>
                </span>
              </div>
            );
          })}
      </div>
      <div className="mt-2 border-t border-zinc-700 pt-2 text-right text-xs text-zinc-400">
        Total {formatCurrency(total)}
      </div>
    </div>
  );
}

export function TimelinePanel({ grants, foundations }: TimelinePanelProps) {
  const { chartData, activeFoundations, grantCounts } = useMemo(() => {
    const activeFoundationIds = new Set(grants.map((g) => g.foundation_id));
    const activeFoundations = foundations.filter((f) => activeFoundationIds.has(f.id));

    // Accumulate amount and count per year × foundation
    type Cell = { amount: number; count: number };
    const grid = new Map<number, Map<string, Cell>>();

    for (const grant of grants) {
      if (!grid.has(grant.year)) grid.set(grant.year, new Map());
      const row = grid.get(grant.year)!;
      const cell = row.get(grant.foundation_id);
      if (cell) {
        cell.amount += grant.amount_usd;
        cell.count++;
      } else {
        row.set(grant.foundation_id, { amount: grant.amount_usd, count: 1 });
      }
    }

    const years = [...grid.keys()].sort();

    const chartData = years.map((year) => {
      const row = grid.get(year)!;
      const entry: Record<string, number | string> = { year: String(year) };
      for (const f of activeFoundations) {
        entry[f.id] = row.get(f.id)?.amount ?? 0;
      }
      return entry;
    });

    // Grant counts per year × foundation, keyed by year string for tooltip lookup
    const grantCounts = new Map<string, Map<string, number>>();
    for (const [year, row] of grid) {
      const yearStr = String(year);
      grantCounts.set(yearStr, new Map());
      for (const [fId, cell] of row) {
        grantCounts.get(yearStr)!.set(fId, cell.count);
      }
    }

    return { chartData, activeFoundations, grantCounts };
  }, [grants, foundations]);

  if (!chartData.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Funding Timeline</CardTitle>
          <CardDescription>Annual grant volume by foundation · filtered view</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="py-8 text-center text-sm text-muted-foreground">No grants match the active filters.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Funding Timeline</CardTitle>
        <CardDescription>Annual grant volume by foundation · filtered view</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pb-4 md:px-4">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 64 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="rgba(120,105,80,0.15)" />
            <XAxis
              dataKey="year"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#a1a1aa", fontSize: 12 }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickFormatter={formatYAxis}
              tick={{ fill: "#a1a1aa", fontSize: 11 }}
              width={60}
            />
            <Tooltip
              cursor={{ fill: "rgba(146,121,73,0.08)" }}
              content={(props) => (
                <ChartTooltip
                  active={props.active}
                  payload={props.payload as unknown as TooltipPayloadEntry[] | undefined}
                  label={props.label != null ? String(props.label) : undefined}
                  grantCounts={grantCounts}
                />
              )}
            />
            <Legend
              wrapperStyle={{ fontSize: "11px", paddingTop: "12px" }}
              formatter={(value) => <span style={{ color: "#a1a1aa" }}>{value}</span>}
            />
            {activeFoundations.map((f, i) => (
              <Bar
                key={f.id}
                dataKey={f.id}
                stackId="stack"
                fill={STACK_COLORS[i % STACK_COLORS.length]}
                name={f.name}
                radius={i === activeFoundations.length - 1 ? [3, 3, 0, 0] : undefined}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
