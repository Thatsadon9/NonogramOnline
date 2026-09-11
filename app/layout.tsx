import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nonogram Together — เล่นโนโนแกรมกับเพื่อน",
  description: "เกม Nonogram ขนาด 5×5 ถึง 25×25 พร้อมห้องออนไลน์สำหรับช่วยกันแก้แบบเรียลไทม์",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="th">
      <body className="antialiased">{children}</body>
    </html>
  );
}
