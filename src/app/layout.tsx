import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Display face with real character (not Inter, not Space Grotesk) for headlines;
// Geist for clean body; Geist Mono powers tabular figures in metrics.
const display = Bricolage_Grotesque({
  variable: "--ff-display",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
});
const sans = Geist({ variable: "--ff-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--ff-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FanFunnel — Creator Prize Wheels",
  description:
    "Send each fan a personal prize wheel. Every spin wins; rare drops keep them coming back.",
};

// viewportFit:"cover" + safe-area padding (in globals.css) keeps content clear
// of the iPhone status bar / notch. themeColor matches the tinted-dark base.
export const viewport: Viewport = {
  themeColor: "#0c0a0e",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-[100dvh] flex flex-col bg-base text-ink">
        {children}
      </body>
    </html>
  );
}
