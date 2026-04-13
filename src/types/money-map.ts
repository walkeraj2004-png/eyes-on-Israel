export type EntityType = "foundation" | "recipient";

export type Foundation = {
  id: string;
  name: string;
  location: string;
  entity_type: "foundation";
  total_grants_usd: number;
  grant_count: number;
  connected_entity_count: number;
};

export type Recipient = {
  id: string;
  name: string;
  location: string;
  entity_type: "recipient";
  category: string;
  total_received_usd: number;
  grant_count: number;
  connected_entity_count: number;
};

export type Mechanism = "directed" | "general" | "matching" | "unclear";

export type Grant = {
  id: string;
  foundation_id: string;
  recipient_id: string;
  year: number;
  amount_usd: number;
  purpose: string;
  mechanism: Mechanism;
  filing_url: string;
};

export type MoneyMapDataset = {
  generated_at: string;
  summary: {
    grant_count: number;
    foundation_count: number;
    recipient_count: number;
    total_amount_usd: number;
    year_range: {
      start: number;
      end: number;
    };
  };
  foundations: Foundation[];
  recipients: Recipient[];
  grants: Grant[];
  notes: string[];
};
