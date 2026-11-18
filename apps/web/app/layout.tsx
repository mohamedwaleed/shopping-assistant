// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shopping Assistant",
  description:
    "Self-hosted shopping assistant for the Netherlands — English and Dutch.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
