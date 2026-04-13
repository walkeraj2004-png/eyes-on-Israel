import { promises as fs } from "node:fs";
import path from "node:path";

import type { Publication } from "@/types/publications";

export async function getPublicationsDataset(): Promise<Publication[]> {
  const dataDir = path.join(process.cwd(), "data");
  const filePath = path.join(dataDir, "publications.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as Publication[];
  } catch {
    // Script hasn't been run yet — return empty so build doesn't fail
    return [];
  }
}
