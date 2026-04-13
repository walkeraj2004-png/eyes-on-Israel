import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectionWebPanel } from "@/components/connection-web";
import { PublicationsPanel } from "@/components/publications-panel";
import { getConnectionsDataset } from "@/lib/connections";
import { getMoneyMapDataset } from "@/lib/money-map";
import { getPublicationsDataset } from "@/lib/publications";
import { formatCurrency, formatDateTime } from "@/lib/utils";

import { MoneyMapPanel } from "@/components/money-map-panel";

export const dynamic = "force-static";

export default async function HomePage() {
  const [dataset, connectionsData, publications] = await Promise.all([
    getMoneyMapDataset(),
    getConnectionsDataset(),
    getPublicationsDataset(),
  ]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
      <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="overflow-hidden border-accent/20 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(249,246,240,0.88))]">
          <CardHeader className="gap-4">
            <Badge>Money Map MVP</Badge>
            <div className="grid gap-4 md:grid-cols-[1.3fr_0.7fr] md:items-end">
              <div className="space-y-3">
                <CardTitle className="max-w-3xl text-4xl md:text-5xl">
                  Cross-Node Capital Flow Dashboard
                </CardTitle>
                <CardDescription className="max-w-2xl text-base md:text-lg">
                  Foundation-to-recipient grant flows sourced from public IRS filings. This MVP
                  focuses on the Money Map panel and keeps each grant tethered to a filing URL for
                  direct review.
                </CardDescription>
              </div>
              <dl className="grid gap-3 rounded-xl border border-border/70 bg-background/55 p-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Total grant volume</dt>
                  <dd className="font-semibold">{formatCurrency(dataset.summary.total_amount_usd)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Coverage window</dt>
                  <dd className="font-semibold">
                    {dataset.summary.year_range.start} to {dataset.summary.year_range.end}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">JSON generated</dt>
                  <dd className="font-semibold">{formatDateTime(dataset.generated_at)}</dd>
                </div>
              </dl>
            </div>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="gap-4">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="text-2xl">Methodology</CardTitle>
              <Link
                href="/methodology"
                className="shrink-0 text-xs text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
              >
                Full methodology →
              </Link>
            </div>
            <CardDescription className="max-w-prose">
              All grant data sourced from IRS 990-PF filings via ProPublica Nonprofit Explorer.
              Personnel data extracted from Part VII officer/director disclosures. Media footprint
              approximated via Google News RSS. Every data point links to its source filing or
              article. No editorial conclusions are drawn — this tool surfaces patterns in public
              records for independent analysis.
            </CardDescription>
          </CardHeader>
        </Card>
      </section>

      <MoneyMapPanel dataset={dataset} />

      <PublicationsPanel
        publications={publications}
        grantYearRange={dataset.summary.year_range}
      />

      <ConnectionWebPanel
        connections={connectionsData.connections}
        foundations={dataset.foundations}
      />
    </main>
  );
}
