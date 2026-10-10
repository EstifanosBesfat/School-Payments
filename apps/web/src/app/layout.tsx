import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Ethiopic } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const notoSansEthiopic = Noto_Sans_Ethiopic({ subsets: ['ethiopic'], variable: '--font-ethiopic', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'School Payments', template: '%s · School Payments' },
  description: 'Pay school fees with telebirr, CBE Birr, M-Pesa or card and get a signed receipt you can always verify.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#047857',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${notoSansEthiopic.variable}`}>
      <body className="min-h-dvh font-sans">{children}</body>
    </html>
  );
}
