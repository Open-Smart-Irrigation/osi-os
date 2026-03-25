import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Global Water Crisis',
  description:
    'How climate change and water scarcity are threatening smallholder farmers worldwide — and what we can do about it.',
}

export default function GlobalWaterCrisisPage() {
  return (
    <>
      {/* Hero */}
      <section className="relative bg-blue-950 pt-32 pb-20 overflow-hidden">
        <Image
          src="https://images.unsplash.com/photo-1504537630180-9b4fa9c2c5b3?auto=format&fit=crop&w=1920&q=80"
          alt="Cracked dry earth — water scarcity"
          fill
          className="object-cover opacity-20"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-b from-blue-950/80 to-blue-950" />
        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <span className="text-blue-400 text-sm font-semibold tracking-widest uppercase mb-4 block">
            The Problem
          </span>
          <h1 className="font-display text-5xl md:text-6xl font-bold text-white leading-tight mb-6">
            How a Crisis Threatens Smallholder Farmers
          </h1>
          <p className="text-blue-200 text-xl leading-relaxed max-w-2xl">
            A perfect storm of climate change, population growth, and infrastructure gaps
            is putting millions of farming families at risk.
          </p>
        </div>
      </section>

      {/* Stats bar */}
      <section className="bg-blue-900 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-blue-800 text-center text-white">
            <div className="py-6 md:py-0 px-8">
              <p className="font-display text-5xl font-bold text-blue-200">40%</p>
              <p className="text-base font-semibold mt-1">water supply gap by 2030</p>
              <p className="text-blue-400 text-sm mt-1">World Bank, 2024</p>
            </div>
            <div className="py-6 md:py-0 px-8">
              <p className="font-display text-5xl font-bold text-blue-200">2.2B</p>
              <p className="text-base font-semibold mt-1">in water-stressed countries</p>
              <p className="text-blue-400 text-sm mt-1">today</p>
            </div>
            <div className="py-6 md:py-0 px-8">
              <p className="font-display text-5xl font-bold text-blue-200">1 in 4</p>
              <p className="text-base font-semibold mt-1">children in extreme water scarcity</p>
              <p className="text-blue-400 text-sm mt-1">by 2040 &mdash; UN, 2022</p>
            </div>
          </div>
        </div>
      </section>

      {/* Content */}
      <section className="py-20 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="space-y-12">
            {/* Section 1 */}
            <div>
              <h2 className="font-display text-3xl font-bold text-stone-900 mb-4">
                A rapidly narrowing gap between supply and demand
              </h2>
              <p className="text-stone-600 leading-relaxed mb-4">
                By 2030, global freshwater demand is projected to exceed supply by approximately
                40%. Over 2.2 billion people currently live in water-stressed countries, and by
                2040, one in four children may reside in areas with extreme water scarcity.
              </p>
              <p className="text-stone-600 leading-relaxed">
                Agriculture&rsquo;s demand for freshwater depletes groundwater reserves faster than
                they can be replenished, triggering land subsidence. Over one-third of irrigated
                lands suffer from salinisation or waterlogging. Tropical and subtropical zones
                experience shortened wet seasons and longer dry spells, destabilising planting
                cycles.
              </p>
            </div>

            {/* Section 2 */}
            <div>
              <h2 className="font-display text-3xl font-bold text-stone-900 mb-4">
                Smallholder farmers bear the greatest burden
              </h2>
              <p className="text-stone-600 leading-relaxed mb-4">
                Smallholder farmers in low- and middle-income countries face increasing risks
                from prolonged droughts, erratic rainfall patterns, and rising temperatures —
                due to their reliance on rainfed agriculture and limited capacity to adapt.
              </p>
              <p className="text-stone-600 leading-relaxed">
                In Eastern and Southern Africa alone, over 90 million people faced acute hunger
                due to prolonged drought in 2025. Without adaptation, up to 183 million
                additional people worldwide may face hunger by mid-century.
              </p>
            </div>

            {/* Farmer quote */}
            <div className="bg-blue-50 rounded-2xl p-8 border-l-4 border-blue-500">
              <svg
                className="w-7 h-7 text-blue-400 mb-4"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
              </svg>
              <blockquote className="font-display text-xl text-stone-800 leading-relaxed mb-5">
                &ldquo;I need irrigation to cultivate crops in the dry seasons. Droughts have become
                more frequent, and ground levels are sinking.&rdquo;
              </blockquote>
              <cite className="not-italic">
                <p className="font-semibold text-stone-900">Benad Okolimong</p>
                <p className="text-sm text-stone-500">
                  38-year-old farmer and father of two &mdash; Ngora District, Uganda
                </p>
              </cite>
            </div>

            {/* Section 3 */}
            <div>
              <h2 className="font-display text-3xl font-bold text-stone-900 mb-4">
                Existing solutions are not built for smallholders
              </h2>
              <p className="text-stone-600 leading-relaxed mb-4">
                Most existing smart irrigation solutions are designed for well-resourced,
                large-scale farms. They are too expensive, too complex, and too reliant on
                stable electricity and internet for the realities of smallholder farming
                communities.
              </p>
              <p className="text-stone-600 leading-relaxed">
                OSI was designed specifically to close this gap — building from field research,
                farmer surveys, and the principle that resilient technology must be accessible,
                locally owned, and truly robust.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 bg-stone-50 border-t border-stone-100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-6">
          <p className="text-stone-700 font-medium text-lg">
            See how OSI addresses these challenges
          </p>
          <Link
            href="/osi-system"
            className="inline-flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white px-7 py-3 rounded-full font-semibold transition-colors shrink-0"
          >
            Explore the OSI System
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </Link>
        </div>
      </section>
    </>
  )
}
