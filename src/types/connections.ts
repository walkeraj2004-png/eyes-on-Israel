export type PersonnelRole = {
  organization_name: string;
  organization_ein: string;
  organization_type: "foundation" | "recipient";
  title: string;
  tax_year: number;
  compensation: number | null;
  filing_url: string;
};

export type Connection = {
  person_name: string;
  match_key: string;
  organization_count: number;
  concurrent: boolean;
  roles: PersonnelRole[];
};

export type ConnectionsDataset = {
  connections: Connection[];
};
