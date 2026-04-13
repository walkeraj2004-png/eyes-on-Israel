"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import cytoscape from "cytoscape";

type GraphElement = {
  data: Record<string, string | number>;
  classes?: string;
};

type MoneyMapGraphProps = {
  elements: GraphElement[];
  selectedId: string | null;
  onSelectNode: (nodeId: string) => void;
  onClearSelection: () => void;
};

export function MoneyMapGraph({
  elements,
  selectedId,
  onSelectNode,
  onClearSelection,
}: MoneyMapGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [tooltip, setTooltip] = useState<{ label: string; x: number; y: number } | null>(null);

  const fitView = useCallback(() => {
    cyRef.current?.fit(undefined, 40);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // Augment node data: add displayLabel (truncated) and fullLabel for tooltips.
    // Edges (have data.source) are passed through unchanged.
    const processedElements = elements.map((el) => {
      if ("source" in el.data) return el;
      const isRecipient = el.data.type === "recipient";
      const full = String(el.data.label ?? "");
      const size = Number(el.data.size) || 0;
      // Very small recipient nodes show no label — hover tooltip gives the full name.
      const truncated = isRecipient && full.length > 20 ? full.slice(0, 19) + "…" : full;
      const displayLabel = isRecipient && size < 26 ? "" : truncated;
      return { ...el, data: { ...el.data, displayLabel, fullLabel: full } };
    });

    const cy = cytoscape({
      container: containerRef.current,
      elements: processedElements,
      layout: {
        name: "cose",
        animate: false,
        padding: 40,
        nodeRepulsion: () => 9000,
        idealEdgeLength: () => 220,
        nodeOverlap: 80,
        gravity: 0.6,
        numIter: 1500,
        initialTemp: 1000,
        coolingFactor: 0.99,
        minTemp: 1.0,
      } as cytoscape.CoseLayoutOptions,
      style: [
        // ── Base node ────────────────────────────────────────────────────────
        {
          selector: "node",
          style: {
            label: "data(displayLabel)",
            color: "#171513",
            "font-size": "9px",
            "font-family": "Avenir Next, Segoe UI, sans-serif",
            "text-wrap": "wrap",
            "text-max-width": "72px",
            "text-valign": "center",
            "text-halign": "center",
            width: "data(size)",
            height: "data(size)",
            "border-width": "1.5px",
            "border-color": "#57462a",
            "background-color": "#f8f4ea",
            "overlay-opacity": 0,
            // Cream halo so labels don't bleed into edges
            "text-background-color": "#f9f6f0",
            "text-background-opacity": 0.85,
            "text-background-shape": "roundrectangle",
            "text-background-padding": "2px",
          },
        },
        // ── Foundation nodes — visually dominant ─────────────────────────────
        {
          selector: 'node[type = "foundation"]',
          style: {
            shape: "ellipse",
            "background-color": "#927949",
            color: "#f7f3ea",
            "border-color": "#927949",
            "font-size": "12px",
            "font-weight": 700,
            // Dark halo for light text on dark background
            "text-background-color": "#3d2a14",
            "text-background-opacity": 0.45,
          },
        },
        // ── Recipient nodes ──────────────────────────────────────────────────
        {
          selector: 'node[type = "recipient"]',
          style: {
            shape: "round-rectangle",
            "background-color": "#f8f4ea",
            color: "#171513",
            "border-color": "#57462a",
          },
        },
        // ── Active (selected) node ───────────────────────────────────────────
        {
          selector: "node.is-active",
          style: {
            "border-width": "3px",
            "border-color": "#171513",
            "font-weight": 700,
          },
        },
        // ── Base edge — very faint at rest ───────────────────────────────────
        {
          selector: "edge",
          style: {
            width: "mapData(amount, 100000, 10000000, 1.5, 10)",
            "curve-style": "bezier",
            "line-color": "#bfae8a",
            "target-arrow-color": "#bfae8a",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.9,
            opacity: 0.15,
            "overlay-opacity": 0,
          },
        },
        {
          selector: 'edge[mechanism = "directed"]',
          style: {
            "line-color": "#7a5c2e",
            "target-arrow-color": "#7a5c2e",
            "line-style": "solid",
            opacity: 0.15,
          },
        },
        {
          selector: 'edge[mechanism = "general"]',
          style: {
            "line-color": "#bfae8a",
            "target-arrow-color": "#bfae8a",
            "line-style": "dashed",
            "line-dash-pattern": [7, 4],
            opacity: 0.15,
          },
        },
        {
          selector: 'edge[mechanism = "matching"]',
          style: {
            "line-color": "#927949",
            "target-arrow-color": "#927949",
            "line-style": "dotted",
            opacity: 0.15,
          },
        },
        {
          selector: 'edge[mechanism = "unclear"]',
          style: {
            "line-color": "#d4c8a8",
            "target-arrow-color": "#d4c8a8",
            "line-style": "solid",
            opacity: 0.12,
          },
        },
        {
          selector: "edge.is-active",
          style: {
            "line-color": "#171513",
            "target-arrow-color": "#171513",
            "line-style": "solid",
            opacity: 1,
          },
        },
        // ── Spotlight hover classes ───────────────────────────────────────────
        {
          selector: "edge.spotlight",
          style: { opacity: 0.9 },
        },
        {
          selector: "edge.dimmed",
          style: { opacity: 0.05 },
        },
      ],
    });

    // Fit to viewport once layout finishes
    cy.one("layoutstop", () => {
      cy.fit(undefined, 40);
    });

    // Spotlight on node hover — connected edges light up, everything else fades
    cy.on("mouseover", "node", (event) => {
      const node = event.target;
      const connected = node.connectedEdges();
      cy.batch(() => {
        cy.edges().not(connected).addClass("dimmed").removeClass("spotlight");
        connected.addClass("spotlight").removeClass("dimmed");
      });

      // Show tooltip only for truncated labels
      const full = String(node.data("fullLabel") ?? node.data("label") ?? "");
      const display = String(node.data("displayLabel") ?? full);
      if (display !== full && full) {
        const pos = node.renderedPosition();
        setTooltip({ label: full, x: pos.x, y: pos.y });
      }
    });

    cy.on("mouseout", "node", () => {
      cy.batch(() => {
        cy.edges().removeClass("dimmed spotlight");
      });
      setTooltip(null);
    });

    cy.on("tap", "node", (event) => {
      onSelectNode(String(event.target.data("id")));
    });

    cy.on("tap", "edge", (event) => {
      onSelectNode(String(event.target.data("target")));
    });

    cy.on("tap", (event) => {
      if (event.target === cy) onClearSelection();
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
      setTooltip(null);
    };
  }, [elements, onSelectNode, onClearSelection]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$(".is-active").removeClass("is-active");
    if (selectedId) cy.$(`[id = "${selectedId}"]`).addClass("is-active");
  }, [selectedId]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="h-[520px] w-full rounded-xl bg-[rgba(255,255,255,0.36)]"
      />
      <button
        onClick={fitView}
        className="absolute bottom-3 right-3 rounded-lg border border-border/60 bg-background/80 px-2.5 py-1.5 text-xs text-muted-foreground backdrop-blur-sm transition hover:text-foreground"
      >
        Fit to view
      </button>
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 max-w-52 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 shadow-lg"
          style={{ left: tooltip.x + 10, top: tooltip.y - 36 }}
        >
          {tooltip.label}
        </div>
      )}
    </div>
  );
}
