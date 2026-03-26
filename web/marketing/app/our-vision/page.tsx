import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Our Vision',
  description:
    "Smart Irrigation for All — OSI's vision for universal access to water-efficient farming, local ownership, and climate resilience.",
}

export default function OurVisionPage() {
  return (
    <>
      {/* Hero */}
      <section className="bg-green-950 pt-32 pb-20 overflow-hidden relative">
        {/* Decorative gradients */}
        <div className="absolute top-0 right-0 w-80 h-80 rounded-full bg-green-800/30 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-96 h-96 rounded-full bg-green-900/40 blur-3xl pointer-events-none" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <span className="text-green-400 text-sm font-semibold tracking-widest uppercase mb-4 block">
            Our Vision
          </span>
          <h1 className="font-display text-5xl md:text-6xl font-bold text-white leading-tight mb-8">
            Smart Irrigation for All
          </h1>
          <p className="font-display text-2xl text-green-200 leading-relaxed max-w-2xl">
            &ldquo;We envision a world where smallholder farmers — regardless of income,
            gender, or geography — have the tools to irrigate efficiently and grow food
            sustainably.&rdquo;
          </p>
        </div>
      </section>

      {/* Core vision text */}
      <section className="py-20 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
          <div>
            <h2 className="font-display text-3xl font-bold text-stone-900 mb-4">
              Access is the starting point
            </h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              Millions of farmers currently lack access to smart farming innovations due to
              high costs, infrastructure gaps, and digital barriers. OSI challenges this by
              providing an open, adaptable, locally-owned irrigation solution that works
              where other solutions fail.
            </p>
            <p className="text-stone-600 leading-relaxed">
              OSI is more than technology. It enables real change — starting with the
              individual farmer and scaling up to more sustainable agricultural systems.
              By boosting yields, reducing waste, and making water use more efficient, OSI
              improves farmer livelihoods and food security on the ground.
            </p>
          </div>

          <div>
            <h2 className="font-display text-3xl font-bold text-stone-900 mb-4">
              Community over dependency
            </h2>
            <p className="text-stone-600 leading-relaxed mb-4">
              Rather than creating dependency through subscription models, OSI promotes local
              ownership by combining education, shared infrastructure, and open-source design.
              A &ldquo;superuser&rdquo; approach equips local leaders to manage irrigation hubs
              and support their peers — ensuring that knowledge and capability remain within
              the community.
            </p>
            <p className="text-stone-600 leading-relaxed">
              With farmers, researchers, and partners, we are building a global commons for
              smart irrigation. Every crop deserves just the right amount of water.
            </p>
          </div>

          <div>
            <h2 className="font-display text-3xl font-bold text-stone-900 mb-4">
              Women at the centre
            </h2>
            <p className="text-stone-600 leading-relaxed">
              Women are often underrepresented in agricultural decision-making yet carry a
              disproportionate share of farming labour. OSI implements targeted training
              programmes and leadership opportunities, actively supporting women as community
              leaders and capable practitioners of smart water technology.
            </p>
          </div>
        </div>
      </section>

      {/* Strategic goals */}
      <section className="py-20 bg-stone-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="font-display text-3xl font-bold text-stone-900">
              What we are building toward
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
            {[
              {
                number: '01',
                title: 'Universal access to water and food security',
                body: 'Every farmer, regardless of location or income, should be able to irrigate efficiently and grow food sustainably.',
              },
              {
                number: '02',
                title: 'Regenerative, low-emission agricultural systems',
                body: 'Precision irrigation reduces water waste and chemical runoff, contributing to more sustainable land use at scale.',
              },
              {
                number: '03',
                title: 'Empowered smallholder communities',
                body: 'Local ownership and training — with special emphasis on women — build lasting capability within farming communities.',
              },
              {
                number: '04',
                title: 'Resilient, resource-efficient farming',
                body: 'Data-informed decisions adapted to local climate conditions help farmers respond to the realities of a changing climate.',
              },
            ].map((goal) => (
              <div
                key={goal.number}
                className="bg-white rounded-2xl p-7 shadow-sm border border-stone-100"
              >
                <span className="text-green-500 font-bold text-sm">{goal.number}</span>
                <h3 className="font-display text-xl font-bold text-stone-900 mt-2 mb-3">
                  {goal.title}
                </h3>
                <p className="text-stone-600 text-sm leading-relaxed">{goal.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Closing statement */}
      <section className="py-20 bg-green-950 relative overflow-hidden">
        <div className="absolute inset-0 opacity-5">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                "radial-gradient(circle at 1px 1px, white 1px, transparent 0)",
              backgroundSize: "32px 32px",
            }}
          />
        </div>
        <div className="relative max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="font-display text-2xl md:text-3xl text-white leading-relaxed">
            &ldquo;With farmers, researchers, and partners, we&rsquo;re building a global commons
            for smart irrigation. Every crop deserves just the right amount of water —
            because every drop counts.&rdquo;
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 bg-stone-50 border-t border-stone-100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-6">
          <p className="text-stone-700 font-medium text-lg">
            See how OSI turns this vision into practice
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
