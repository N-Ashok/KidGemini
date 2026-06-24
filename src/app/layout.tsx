import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KidGemini — a friendly, safe AI buddy",
  description: "A kids-safe AI chat with voice, games, and parent controls.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;700&family=Nunito:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
