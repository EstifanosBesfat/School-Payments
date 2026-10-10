import { QrCode, ShieldCheck, Smartphone, School } from 'lucide-react';
import Link from 'next/link';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const tiles = [
  {
    href: '/parent',
    icon: Smartphone,
    title: 'Parents',
    am: 'ወላጆች',
    text: 'See your children’s fees and receipts with a code sent to your phone.',
  },
  {
    href: '/verify',
    icon: QrCode,
    title: 'Verify a receipt',
    am: 'ደረሰኝ ያረጋግጡ',
    text: 'Scan the QR code or enter the receipt number and code. Works even offline.',
  },
  {
    href: '/login',
    icon: School,
    title: 'School staff',
    am: 'የትምህርት ቤት ሰራተኞች',
    text: 'Issue invoices, follow payments, export receipts for your accountant.',
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12 sm:py-20">
      <section className="max-w-2xl">
        <p className="inline-flex items-center gap-2 rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-800">
          <ShieldCheck className="size-4" aria-hidden /> Payments processed by a licensed Ethiopian gateway
        </p>
        <h1 className="mt-5 text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">School fees, paid in a minute.</h1>
        <p className="mt-2 text-xl text-gray-600">የትምህርት ቤት ክፍያ በደቂቃ።</p>
        <p className="mt-5 text-lg text-gray-600">
          Pay with telebirr, CBE Birr, M-Pesa or card from the link your school sends by SMS. Every payment gives you a digitally signed receipt that proves you paid,
          even if this website is ever unavailable.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <LinkButton href="/parent" size="lg">
            I am a parent
          </LinkButton>
          <LinkButton href="/verify" size="lg" variant="secondary">
            Verify a receipt
          </LinkButton>
        </div>
      </section>

      <section className="mt-16 grid gap-4 sm:grid-cols-3">
        {tiles.map(({ href, icon: Icon, title, am, text }) => (
          <Link key={href} href={href} className="group">
            <Card className="h-full p-5 transition-shadow group-hover:shadow-md">
              <Icon className="size-6 text-brand-700" aria-hidden />
              <h2 className="mt-4 font-semibold text-gray-900">
                {title} <span className="font-normal text-gray-500">· {am}</span>
              </h2>
              <p className="mt-1 text-sm text-gray-600">{text}</p>
            </Card>
          </Link>
        ))}
      </section>
    </main>
  );
}
