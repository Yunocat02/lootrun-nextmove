import "./globals.css";

export const metadata = {
  title: "YunYun Lootrun Advisor",
  description:
    "A self-hosted Wynncraft lootrun companion that ranks manual next moves with MCTS, Monte Carlo simulation, and guide-tuned rules.",
  applicationName: "YunYun Lootrun Advisor",
  authors: [{ name: "YunYun" }],
  keywords: [
    "Wynncraft",
    "lootrun",
    "lootrun advisor",
    "Monte Carlo",
    "MCTS",
    "self-hosted",
  ],
  openGraph: {
    title: "YunYun Lootrun Advisor",
    description:
      "Manual Wynncraft lootrun next-move advisor with guide-tuned simulation.",
    type: "website",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
