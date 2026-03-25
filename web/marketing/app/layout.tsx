import type { Metadata } from 'next'
import { Inter, Lora } from 'next/font/google'
import './globals.css'
import Nav from '@/components/Nav'
import Footer from '@/components/Footer'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const lora = Lora({
  subsets: ['latin'],
  variable: '--font-lora',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    default: 'Open Smart Irrigation',
    template: '%s | Open Smart Irrigation',
  },
  description:
    'Smart, offline-first irrigation for smallholder farmers worldwide. Because every drop counts.',
  keywords: [
    'irrigation',
    'smallholder farmers',
    'LoRaWAN',
    'open source',
    'smart agriculture',
    'water conservation',
  ],
  openGraph: {
    title: 'Open Smart Irrigation',
    description:
      'Smart, offline-first irrigation for smallholder farmers worldwide. Because every drop counts.',
    url: 'https://opensmartirrigation.org',
    siteName: 'Open Smart Irrigation',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${lora.variable}`}>
      <body className="font-sans bg-white text-stone-900 antialiased">
        <Nav />
        {children}
        <Footer />
      </body>
    </html>
  )
}
