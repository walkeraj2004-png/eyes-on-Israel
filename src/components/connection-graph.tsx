"use client";

import { useEffect, useRef } from "react";

import cytoscape from "cytoscape";

type OrgNode = {
  id: string;
  label: string;
  type: "foundation" | "recipient";
};

type SharedEdge = {
  id: string;
  source: string;
  target: string;
  weight: number;
  peopleLabel: string;
  bridge: boolean;
  concurrent: boolean;
};

type ConnectionGraphProps = {
  nodes: OrgNode[];
  edges: SharedEdge[];
  selectedId: string | null;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (edgeId: string) => void;
  onClearSelection: () => void;
};

export function ConnectionGraph({
  nodes,
  edges,
  selectedId,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
}: ConnectionGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const elements = [
      ...nodes.map((n) => ({ data: { id: n.id, label: n.label, type: n.type } })),
      ...edges.map((e) => ({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          weight: e.weight,
          label: e.weight > 1 ? String(e.weight) : "",
          bridge: e.bridge ? 1 : 0,
          concurrent: e.concurrent ? 1 : 0,
        },
      })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      layout: {
        name: "cose",
        animate: false,
        padding: 40,
        nodeOverlap: 20,
        idealEdgeLength: () => 140,
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
            "text-max-width": "88px",
            "text-valign": "center",
            "text-halign": "center",
            width: 60,
            height: 60,
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
            width: "mapData(weight, 1, 5, 2, 8)",
            "curve-style": "bezier",
            "line-color": "#bfae8a",
            "target-arrow-color": "#bfae8a",
            "target-arrow-shape": "none",
            label: "data(label)",
            "font-size": "10px",
            color: "#928070",
            "text-rotation": "autorotate",
            opacity: 0.45,
            "overlay-opacity": 0,
          },
        },
        {
          selector: "edge[bridge = 1]",
          style: {
            "line-color": "#7a5c2e",
            "line-style": "solid",
            opacity: 0.88,
          },
        },
        {
          selector: "edge[bridge = 0]",
          style: {
            "line-color": "#bfae8a",
            "line-style": "dashed",
            "line-dash-pattern": [6, 4],
            opacity: 0.45,
          },
        },
        {
          selector: "edge[concurrent = 0]",
          style: {
            width: 1,
            opacity: 0.25,
            "line-dash-pattern": [3, 5],
          },
        },
        {
          selector: "edge.is-active",
          style: {
            "line-color": "#171513",
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
      onSelectEdge(String(event.target.data("id")));
    });

    cy.on("tap", (event) => {
      if (event.target === cy) onClearSelection();
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [nodes, edges, onSelectNode, onSelectEdge, onClearSelection]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$(".is-active").removeClass("is-active");
    if (selectedId) cy.$(`[id = "${selectedId}"]`).addClass("is-active");
  }, [selectedId]);

  return (
    <div ref={containerRef} className="h-[420px] w-full rounded-xl bg-[rgba(255,255,255,0.36)]" />
  );
}
