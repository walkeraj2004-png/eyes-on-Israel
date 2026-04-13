"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type OrgBarEntry = { name: string; fullName: string; count: number };

const BAR_COLOR = "#927949";

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

export function OrgMentionsChart({ data }: { data: OrgBarEntry[] }) {
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
