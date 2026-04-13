import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Cross-Node Capital Flow Dashboard",
  description:
    "Money Map panel for tracing foundation grants to Israeli think tanks and Israel-focused policy organizations using filing-linked records.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
