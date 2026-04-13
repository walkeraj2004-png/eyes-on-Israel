"use client";

import { useEffect, useRef } from "react";

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

  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      layout: {
        name: "cose",
        animate: false,
        padding: 32,
        nodeOverlap: 16,
      },
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            color: "#171513",
            "font-size": "11px",
            "font-family": "Avenir Next, Segoe UI, sans-serif",
            "text-wrap": "wrap",
            "text-max-width": "96px",
            "text-valign": "center",
            "text-halign": "center",
            width: "data(size)",
            height: "data(size)",
            "border-width": "1.5px",
            "border-color": "#57462a",
            "background-color": "#f8f4ea",
            "overlay-opacity": 0,
          },
        },
        {
          selector: 'node[type = "foundation"]',
          style: {
            shape: "ellipse",
            "background-color": "#927949",
            color: "#f7f3ea",
            "border-color": "#927949",
          },
        },
        {
          selector: 'node[type = "recipient"]',
          style: {
            shape: "round-rectangle",
            "background-color": "#f8f4ea",
            color: "#171513",
            "border-color": "#57462a",
          },
        },
        {
          selector: "node.is-active",
          style: {
            "border-width": "3px",
            "border-color": "#171513",
            "font-weight": 700,
          },
        },
        {
          selector: "edge",
          style: {
            width: "mapData(amount, 100000, 10000000, 1.5, 12)",
            "curve-style": "bezier",
            "line-color": "#bfae8a",
            "target-arrow-color": "#bfae8a",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.9,
            opacity: 0.85,
            "overlay-opacity": 0,
          },
        },
        {
          // Specific program/deliverable — most prominent
          selector: 'edge[mechanism = "directed"]',
          style: {
            "line-color": "#7a5c2e",
            "target-arrow-color": "#7a5c2e",
            "line-style": "solid",
            opacity: 0.92,
          },
        },
        {
          // General / unrestricted — dashed to de-emphasise
          selector: 'edge[mechanism = "general"]',
          style: {
            "line-color": "#bfae8a",
            "target-arrow-color": "#bfae8a",
            "line-style": "dashed",
            "line-dash-pattern": [7, 4],
            opacity: 0.7,
          },
        },
        {
          // Matching gift — dotted
          selector: 'edge[mechanism = "matching"]',
          style: {
            "line-color": "#927949",
            "target-arrow-color": "#927949",
            "line-style": "dotted",
            opacity: 0.75,
          },
        },
        {
          // Unclear — faint solid
          selector: 'edge[mechanism = "unclear"]',
          style: {
            "line-color": "#d4c8a8",
            "target-arrow-color": "#d4c8a8",
            "line-style": "solid",
            opacity: 0.5,
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
      ],
    });

    cy.on("tap", "node", (event) => {
      onSelectNode(String(event.target.data("id")));
    });

    cy.on("tap", "edge", (event) => {
      // Aggregated edges: select the recipient node (target)
      onSelectNode(String(event.target.data("target")));
    });

    cy.on("tap", (event) => {
      if (event.target === cy) onClearSelection();
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [elements, onSelectNode, onClearSelection]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$(".is-active").removeClass("is-active");
    if (selectedId) cy.$(`[id = "${selectedId}"]`).addClass("is-active");
  }, [selectedId]);

  return <div ref={containerRef} className="h-[470px] w-full rounded-xl bg-[rgba(255,255,255,0.36)]" />;
}
