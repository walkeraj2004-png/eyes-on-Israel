import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-static";

export const metadata = {
  title: "Methodology — Cross-Node Capital Flow Dashboard",
  description:
    "Data sources, coverage limits, classification logic, and known limitations for the Cross-Node Capital Flow Dashboard.",
};

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="grid gap-4 scroll-mt-8">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="grid gap-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

function FoundationRow({
  ein,
  name,
  note,
}: {
  ein: string;
  name: string;
  note?: string;
}) {
  return (
    <tr className="border-b border-border/40 last:border-0">
      <td className="py-2.5 pr-6 font-mono text-xs text-muted-foreground/70">{ein}</td>
      <td className="py-2.5 pr-4 text-sm text-foreground">{name}</td>
      <td className="py-2.5 text-xs text-muted-foreground/70 italic">{note ?? ""}</td>
    </tr>
  );
}

export default function MethodologyPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-10 px-4 py-10 md:px-8 md:py-14">
      {/* Header */}
      <div className="grid gap-4">
        <Link
          href="/"
          className="text-xs text-muted-foreground transition hover:text-foreground"
        >
          ← Back to dashboard
        </Link>
        <div className="grid gap-2">
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Cross-Node Capital Flow Dashboard
          </p>
          <h1 className="text-4xl font-bold tracking-tight text-foreground">Methodology</h1>
          <p className="max-w-prose text-base text-muted-foreground">
            This page documents the data sources, computational methods, classification logic, and
            known limitations underlying every figure in the dashboard.
          </p>
        </div>
      </div>

      <div className="grid gap-10">
        {/* ── DATA SOURCES ── */}
        <Section id="data-sources" title="Data Sources">
          <p>
            IRS 990-PF filings are the backbone of this tool. All grant data is extracted from
            Schedule Part XV grant line items in electronically filed 990-PF returns, accessed via
            the IRS Tax Exempt Organization Search (TEOS) bulk XML data and the ProPublica Nonprofit
            Explorer API. Filing coverage spans tax years 2020 through 2024 — the oldest years for
            which machine-readable XML remains available on IRS servers. Pre-2020 filings exist only
            as PDF images and are not included in this release.
          </p>
          <p>
            Personnel data is extracted from Part VII (Officers, Directors, Trustees, and Key
            Employees) of the same filings. Cross-organization matches use exact name matching with
            a fuzzy similarity threshold of 93 (on a 0–100 scale, using Levenshtein-based token
            ratio) to catch formatting variations while minimizing false positives.
          </p>
          <p>
            Media footprint data is sourced from Google News RSS and represents a recency-biased,
            approximate sample of news coverage mentioning funded organizations. It is not a measure
            of direct publication output or research productivity.
          </p>
        </Section>

        {/* ── FOUNDATIONS COVERED ── */}
        <Section id="foundations" title="Foundations Covered">
          <p>
            The following eight foundations are included in this release. Selection was based on
            public reporting of substantial grant-making to Israeli-focused or Middle East policy
            organizations and the availability of electronically filed 990-PF returns.
          </p>

          <Card className="overflow-hidden border-border/60">
            <CardContent className="p-0">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/30">
                    <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      EIN
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Foundation
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Note
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30 px-4">
                  {[
                    { ein: "04-7024330", name: "Adelson Family Foundation" },
                    { ein: "13-1684331", name: "Ford Foundation" },
                    { ein: "94-1624987", name: "Koret Foundation" },
                    { ein: "58-1815651", name: "Marcus Foundation Inc" },
                    { ein: "13-7029285", name: "Open Society Institute" },
                    { ein: "13-1760106", name: "Rockefeller Brothers Fund Inc" },
                    {
                      ein: "73-1312965",
                      name: "Charles and Lynn Schusterman Family Foundation",
                      note: "Grant schedule extracted via OCR from 990-PF PDF attachments (tax years 2021–2022). 2020 and 2023–2024 PDF attachments unavailable.",
                    },
                    { ein: "13-3676152", name: "The Tikvah Fund" },
                  ].map((f) => (
                    <tr key={f.ein} className="px-4">
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground/70">
                        {f.ein}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-foreground">{f.name}</td>
                      <td className="px-4 py-2.5 text-xs italic text-muted-foreground/70">
                        {f.note ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <p>
            The Schusterman Foundation is included because it is one of the largest US foundations
            focused on Israel-related giving. Every filing routes its grant schedule to a PDF
            attachment rather than itemizing recipients in the XML return. For tax years 2021 and
            2022, individual grant records were recovered by OCR-processing the PDF attachments using
            pytesseract at 300 DPI. This yielded 128 Israel-related grants totaling approximately
            $139 million across the two years. The 2020 filing&rsquo;s PDF attachment is not
            available through IRS TEOS for that e-filed return; the 2023 PDF attachment downloaded
            from ProPublica contained a contributor schedule (Schedule B) rather than the grant
            schedule, and the 2024 filing was similarly incomplete.
          </p>
        </Section>

        {/* ── GRANT MECHANISM CLASSIFICATION ── */}
        <Section id="mechanism" title="Grant Mechanism Classification">
          <p>
            Each grant record is classified into one of four categories based on the purpose text
            field from the filing&rsquo;s grant schedule. Classification is performed at ingest time
            using a deterministic rule-based approach with no language model involvement.
          </p>
          <p>
            A grant is classified as <strong className="text-foreground">matching</strong> if the
            purpose text contains the phrase &ldquo;matching gift.&rdquo;
          </p>
          <p>
            A grant is classified as <strong className="text-foreground">general</strong> if the
            purpose text matches one of a set of known general-support phrases: &ldquo;general
            support,&rdquo; &ldquo;core support,&rdquo; &ldquo;operating support,&rdquo;
            &ldquo;charitable purposes,&rdquo; &ldquo;public welfare,&rdquo; &ldquo;operating
            expenses,&rdquo; &ldquo;annual fund,&rdquo; &ldquo;program support,&rdquo; and their
            close variants.
          </p>
          <p>
            A grant is classified as <strong className="text-foreground">directed</strong> if it
            passes neither of the above checks but contains at least one of the following indicator
            keywords: program, project, initiative, research, study, fellowship, conference,
            publication, campaign, report, training, curriculum, exhibition, scholarship, workshop,
            symposium, institute, center, or grant. A purpose string longer than 50 characters that
            contains none of the above keywords also falls into &ldquo;directed&rdquo; on the
            assumption that specificity implies direction.
          </p>
          <p>
            A grant is classified as <strong className="text-foreground">unclear</strong> only if
            all other checks fail — typically very short purpose strings (under 50 characters)
            without recognizable keywords. In the current dataset, 97% of grants are classified as
            directed, general, or matching with high confidence. The remaining 3% are genuinely
            ambiguous.
          </p>
        </Section>

        {/* ── PERSONNEL CONNECTION METHODOLOGY ── */}
        <Section id="personnel" title="Personnel Connection Methodology">
          <p>
            Officer and director names are extracted from Part VII of each 990-PF filing. Names are
            normalized prior to matching: honorific prefixes and common suffixes (Jr., Sr., III,
            Esq.) are stripped, and all text is case-folded. The normalized &ldquo;match key&rdquo;
            is stored alongside each role and is what comparisons operate on.
          </p>
          <p>
            Cross-organization matches are identified using the thefuzz library&rsquo;s token ratio
            scorer with a minimum threshold of 93. This threshold was chosen after an audit of
            flagged matches at lower thresholds (90–92) identified four false-positive pairs where
            different individuals shared similar names. All four were removed. The threshold accepts
            formatting differences such as middle-initial inclusion and hyphenation while rejecting
            different-surname matches.
          </p>
          <p>
            Each confirmed connection is further classified as{" "}
            <strong className="text-foreground">concurrent</strong> if the individuals held roles at
            two or more organizations in the same tax year, or{" "}
            <strong className="text-foreground">sequential</strong> if the overlapping
            organizations appear in different years. Concurrent connections represent active
            simultaneous board or staff relationships; sequential connections represent career
            transitions or advisory roles that did not overlap in time.
          </p>
          <p>
            The final dataset contains 57 confirmed cross-organization connections: 10
            foundation-recipient bridges (7 concurrent, 3 sequential) and 47 recipient-recipient
            overlaps.
          </p>
        </Section>

        {/* ── KNOWN LIMITATIONS ── */}
        <Section id="limitations" title="Known Limitations">
          <p>
            <strong className="text-foreground">Coverage window.</strong> Grant and personnel data
            covers tax years 2020–2024 only. IRS TEOS bulk XML for prior years is no longer hosted
            on IRS servers. The oldest confirmed accessible batch files date to 2021 (covering
            fiscal year 2020 returns). Pre-2020 returns exist as PDF scans and are not parseable
            in this pipeline without manual transcription.
          </p>
          <p>
            <strong className="text-foreground">Schusterman Foundation grants.</strong> Grant
            records for tax years 2021 and 2022 were recovered via OCR from PDF attachments (128
            Israel-related grants, ~$139M). The 2020, 2023, and 2024 grant schedule attachments were
            not available in machine-readable form at the time of data collection; the total
            disbursed across those three years ($300–365M/year) is documented in the filings but
            individual recipients are excluded from this dataset.
          </p>
          <p>
            <strong className="text-foreground">Recipient 990 coverage.</strong> Personnel
            connection data is limited to organizations that file their own 990 or 990-PF with the
            IRS. Of the 341 US-based recipient organizations in the grant dataset, 151 had
            findable, parseable 990 filings at the time of data collection. The remaining 190
            either file under a parent organization, fall below the filing threshold, or had no
            electronically filed return available. An additional 168 foreign-registered
            organizations do not file US 990s and are excluded from personnel analysis.
          </p>
          <p>
            <strong className="text-foreground">Media footprint.</strong> The Google News RSS feed
            returns a limited, recency-biased sample — recent coverage is systematically
            over-represented relative to earlier years. Counts reflect the number of news items
            returned by the API mentioning each organization, not the total volume of coverage that
            exists. Results include coverage about organizations, not only coverage produced by them.
          </p>
          <p>
            <strong className="text-foreground">Mechanism classification.</strong> The classifier
            is a keyword-based heuristic. It does not use natural language processing or semantic
            understanding. Edge cases exist: a purpose string of &ldquo;Israel education&rdquo;
            will be classified as unclear even though it might be a specific directed program.
            Users should treat mechanism labels as a best-effort approximation rather than
            authoritative categorization.
          </p>
          <p>
            <strong className="text-foreground">Personnel matching.</strong> Cross-organization
            person matching relies on name strings only. No Social Security number, ORCID, or other
            unique identifier is available in public filings. Common names (Smith, Cohen, Miller)
            increase the risk of false-positive matches despite the 93-point threshold. Users who
            need to verify a specific connection should cross-reference the linked filing PDFs.
          </p>
        </Section>

        {/* ── WHAT THIS TOOL IS NOT ── */}
        <Section id="not" title="What This Tool Is Not">
          <p>
            This tool surfaces patterns in public records. It does not establish causation between
            funding and policy outcomes. It does not allege impropriety on the part of any
            foundation, recipient organization, or individual named in the data.
          </p>
          <p>
            The inclusion of any foundation or organization in this dataset reflects their
            documented presence in IRS public filings, not an editorial judgment about the merit or
            character of their activities. Grant recipients range across the political and
            ideological spectrum and are included solely on the basis of appearing in a foundation
            filing as a grant beneficiary.
          </p>
          <p>
            Users are encouraged to verify specific claims against the linked source filings before
            drawing conclusions. Every grant record in the dashboard includes a direct link to the
            IRS filing from which it was extracted.
          </p>
        </Section>
      </div>

      {/* Footer nav */}
      <div className="border-t border-border/40 pt-8">
        <Link
          href="/"
          className="text-xs text-muted-foreground transition hover:text-foreground"
        >
          ← Back to dashboard
        </Link>
      </div>
    </main>
  );
}
