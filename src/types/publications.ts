export type Publication = {
  id: string;
  recipient_name: string;
  title: string;
  date: string;
  year: number;
  venue: string;
  url: string;
  source_api: "semantic_scholar" | "google_news";
  citation_count: number | null;
};
