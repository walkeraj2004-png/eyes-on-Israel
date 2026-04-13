import { promises as fs } from "node:fs";
import path from "node:path";

import type { Connection, ConnectionsDataset } from "@/types/connections";

export async function getConnectionsDataset(): Promise<ConnectionsDataset> {
  const dataDir = path.join(process.cwd(), "data");
  const raw = await fs.readFile(path.join(dataDir, "connections.json"), "utf8");
  const connections = JSON.parse(raw) as Connection[];
  return { connections };
}
