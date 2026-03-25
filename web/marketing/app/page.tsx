import Image from 'next/image'
import Link from 'next/link'

export default function HomePage() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex items-center bg-green-950 overflow-hidden">
        {/* Background image */}
        <Image
          src="https://images.unsplash.com/photo-1574943320219-553eb213f72d?auto=format&fit=crop&w=1920&q=80"
          alt="Green irrigated crop field"
          fill
          className="object-cover opacity-25"
          priority
          unoptimized
        />
        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-green-950 via-green-950/90 to-green-900/70" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-20 w-full">
          <div className="max-w-3xl">
            <span className="inline-block text-green-400 text-sm font-semibold tracking-widest uppercase mb-6">
              Smart Irrigation Platform
            </span>
            <h1 className="font-display text-5xl md:text-6xl lg:text-7xl font-bold text-white leading-[1.1] mb-6">
              Because every<br />
              <span className="text-green-400">drop counts.</span>
            </h1>
            <p className="text-lg md:text-xl text-green-100 max-w-xl leading-relaxed mb-10">
              The Open Smart Irrigation (OSI) platform delivers affordable, offline-first
              irrigation solutions for smallholder farmers in low-resource environments —
              powered by open technology, grounded in field research.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link
                href="/osi-system"
                className="inline-flex items-center gap-2 bg-green-500 hover:bg-green-400 text-white px-7 py-3.5 rounded-full font-semibold transition-colors text-base shadow-lg shadow-green-900/40"
              >
                Explore the System
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
              <Link
                href="/our-background"
                className="inline-flex items-center gap-2 border border-green-500 text-green-300 hover:bg-green-500 hover:text-white px-7 py-3.5 rounded-full font-semibold transition-colors text-base"
              >
                Our Story
              </Link>
            </div>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-green-500">
          <span className="text-xs tracking-widest uppercase">Scroll</span>
          <svg
            className="w-5 h-5 animate-bounce"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </section>

      {/* ── Statistics bar ────────────────────────────────────────────────── */}
      <section className="bg-green-700 py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-green-600 text-center text-white">
            <div className="py-6 md:py-0 px-8">
              <p className="font-display text-5xl font-bold text-green-200">40%</p>
              <p className="text-lg font-semibold mt-1">projected water supply gap</p>
              <p className="text-green-300 text-sm mt-1">globally by 2030 &mdash; World Bank</p>
            </div>
            <div className="py-6 md:py-0 px-8">
              <p className="font-display text-5xl font-bold text-green-200">2.2B</p>
              <p className="text-lg font-semibold mt-1">people in water-stressed countries</p>
              <p className="text-green-300 text-sm mt-1">today and growing</p>
            </div>
            <div className="py-6 md:py-0 px-8">
              <p className="font-display text-5xl font-bold text-green-200">90M+</p>
              <p className="text-lg font-semibold mt-1">facing acute hunger</p>
              <p className="text-green-300 text-sm mt-1">Eastern &amp; Southern Africa, 2025</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Problem intro ────────────────────────────────────────────────── */}
      <section className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <span className="text-green-600 text-sm font-semibold tracking-widest uppercase">
                The Problem
              </span>
              <h2 className="font-display text-4xl md:text-5xl font-bold text-stone-900 mt-3 mb-6 leading-tight">
                A Global Water Crisis Threatens Smallholder Farmers
              </h2>
              <p className="text-stone-600 leading-relaxed mb-4 text-lg">
                Smallholder farmers in low- and middle-income countries are on the front line
                of climate change. Reliant on rainfed agriculture, they face increasing risks
                from droughts, erratic rainfall, and rising temperatures.
              </p>
              <p className="text-stone-600 leading-relaxed mb-8">
                While smart irrigation offers a promising way to improve resilience and save
                water, current solutions are often too expensive, too complex, and too dependent
                on stable infrastructure — conditions that many rural farming communities lack.
              </p>
              <Link
                href="/global-water-crisis"
                className="inline-flex items-center gap-2 text-green-700 font-semibold hover:text-green-600 transition-colors"
              >
                Learn more about the crisis
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
            <div className="relative">
              {/* Quote card */}
              <div className="bg-stone-50 rounded-2xl p-8 border-l-4 border-green-500 shadow-sm">
                <svg
                  className="w-8 h-8 text-green-400 mb-4"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
                </svg>
                <blockquote className="font-display text-xl text-stone-800 leading-relaxed mb-5">
                  &ldquo;I need irrigation to cultivate crops in the dry seasons.
                  Droughts have become more frequent, and ground levels are sinking.&rdquo;
                </blockquote>
                <cite className="not-italic">
                  <p className="font-semibold text-stone-900">Benad Okolimong</p>
                  <p className="text-sm text-stone-500">
                    Farmer, 38 &mdash; Ngora District, Uganda
                  </p>
                </cite>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Solution: OSI OS + Academy ───────────────────────────────────── */}
      <section className="py-24 bg-stone-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <span className="text-green-600 text-sm font-semibold tracking-widest uppercase">
              Our Solution
            </span>
            <h2 className="font-display text-4xl md:text-5xl font-bold text-stone-900 mt-3 mb-4">
              Open Smart Irrigation
            </h2>
            <p className="text-stone-600 text-lg max-w-2xl mx-auto">
              Scalable, climate-resilient irrigation built on two core pillars —
              open technology and local knowledge.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* OSI OS */}
            <div className="bg-white rounded-2xl p-8 shadow-sm border border-stone-100 hover:shadow-md transition-shadow">
              <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center mb-6">
                <svg
                  className="w-6 h-6 text-green-700"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"
                  />
                </svg>
              </div>
              <h3 className="font-display text-2xl font-bold text-stone-900 mb-3">OSI OS</h3>
              <p className="text-stone-600 leading-relaxed mb-6">
                A free, open-source operating system for smart irrigation hubs. Runs fully
                offline on low-power hardware, connecting soil sensors and irrigation valves
                over LoRa radio — with a local web dashboard accessible via Wi-Fi.
              </p>
              <ul className="space-y-2.5 mb-8">
                {[
                  'Offline-first — no internet required',
                  'LoRa radio: long range, low power',
                  'Automated threshold-based irrigation scheduling',
                  'Solar-powered; batteries last up to 10 years',
                  'Free and open-source, MIT licensed',
                ].map((f) => (
                  <li key={f} className="flex items-start gap-3 text-sm text-stone-700">
                    <svg
                      className="w-4 h-4 text-green-500 mt-0.5 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/osi-system"
                className="inline-flex items-center gap-2 text-green-700 font-semibold hover:text-green-600 transition-colors text-sm"
              >
                Learn more about OSI OS
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>

            {/* OSI Academy */}
            <div className="bg-white rounded-2xl p-8 shadow-sm border border-stone-100 hover:shadow-md transition-shadow">
              <div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center mb-6">
                <svg
                  className="w-6 h-6 text-amber-700"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 14l9-5-9-5-9 5 9 5zm0 0l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z"
                  />
                </svg>
              </div>
              <h3 className="font-display text-2xl font-bold text-stone-900 mb-3">OSI Academy</h3>
              <p className="text-stone-600 leading-relaxed mb-6">
                A multilingual education and training platform. Step-by-step video tutorials,
                on-ground workshops, and &ldquo;superuser&rdquo; training ensure farmers are confident
                operators — not just recipients — of smart water technology.
              </p>
              <ul className="space-y-2.5 mb-8">
                {[
                  'Multilingual step-by-step video tutorials',
                  'On-ground farmer workshops & field installations',
                  'Local superuser programme for community hubs',
                  'Targeted training and support for women',
                  'Agronomist-guided scientific support',
                ].map((f) => (
                  <li key={f} className="flex items-start gap-3 text-sm text-stone-700">
                    <svg
                      className="w-4 h-4 text-amber-500 mt-0.5 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/osi-system"
                className="inline-flex items-center gap-2 text-amber-700 font-semibold hover:text-amber-600 transition-colors text-sm"
              >
                Learn more about OSI Academy
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Vision pull-quote ────────────────────────────────────────────── */}
      <section className="py-24 bg-green-950 relative overflow-hidden">
        {/* Decorative circle */}
        <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-green-900/40 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full bg-green-900/40 blur-3xl pointer-events-none" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <span className="text-green-400 text-sm font-semibold tracking-widest uppercase mb-6 block">
            Our Vision
          </span>
          <h2 className="font-display text-3xl md:text-4xl lg:text-5xl font-bold text-white leading-tight mb-8">
            &ldquo;We want every farmer to access the tools
            needed to grow food sustainably, no matter
            their income or location.&rdquo;
          </h2>
          <p className="text-green-300 text-lg max-w-2xl mx-auto leading-relaxed mb-10">
            OSI is more than technology. It enables real change — boosting yields, reducing
            waste, and making water use more efficient. At scale, it fosters climate resilience
            and accelerates the shift toward data-informed, resource-efficient farming.
          </p>
          <Link
            href="/our-vision"
            className="inline-flex items-center gap-2 border border-green-500 text-green-300 hover:bg-green-500 hover:text-white px-7 py-3 rounded-full font-semibold transition-colors"
          >
            Read our full vision
          </Link>
        </div>
      </section>

      {/* ── Background / Field research ──────────────────────────────────── */}
      <section className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div className="order-2 lg:order-1 relative">
              <div className="aspect-[4/3] rounded-2xl overflow-hidden">
                <Image
                  src="https://images.unsplash.com/photo-1523348837708-15d4a09cfac2?auto=format&fit=crop&w=800&q=80"
                  alt="Farmer in Uganda working in the field"
                  fill
                  className="object-cover"
                  unoptimized
                />
              </div>
              {/* Floating badge */}
              <div className="absolute -bottom-5 -right-5 bg-green-700 text-white rounded-xl shadow-xl p-4">
                <p className="text-2xl font-bold">2023–24</p>
                <p className="text-green-200 text-sm">Field trials, Uganda</p>
              </div>
            </div>
            <div className="order-1 lg:order-2">
              <span className="text-green-600 text-sm font-semibold tracking-widest uppercase">
                Our Background
              </span>
              <h2 className="font-display text-4xl font-bold text-stone-900 mt-3 mb-6 leading-tight">
                Developed from the field
              </h2>
              <p className="text-stone-600 leading-relaxed mb-4">
                OSI was born out of real-world research. Between 2023 and 2024, field trials
                in Uganda tested smart irrigation components under everyday farming conditions —
                revealing great potential but also major barriers to adoption by smallholders.
              </p>
              <p className="text-stone-600 leading-relaxed mb-8">
                We paused and listened. A countrywide farmer survey in 2024 shaped our core
                design principles:{' '}
                <strong className="text-stone-800">accessibility</strong> and{' '}
                <strong className="text-stone-800">robustness</strong>. No existing system
                fully met these criteria — so we built OSI from the ground up.
              </p>
              <Link
                href="/our-background"
                className="inline-flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white px-6 py-3 rounded-full font-semibold transition-colors"
              >
                Our full story
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Focus pillars ────────────────────────────────────────────────── */}
      <section className="py-20 bg-stone-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="font-display text-3xl font-bold text-stone-900">Our focus</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                icon: (
                  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                  </svg>
                ),
                title: 'Equip smallholders',
                body: 'Provide affordable, robust smart irrigation tools built specifically for low-resource environments.',
              },
              {
                icon: (
                  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                ),
                title: 'Build farmer capacity',
                body: 'Develop smart water management skills through OSI Academy — locally owned, multilingual, and women-inclusive.',
              },
              {
                icon: (
                  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                ),
                title: 'Open infrastructure',
                body: 'Support self-managed, locally owned, and fully adaptable irrigation systems — no subscriptions, no lock-in.',
              },
            ].map((p) => (
              <div key={p.title} className="bg-white rounded-2xl p-7 shadow-sm border border-stone-100">
                <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center text-green-700 mb-5">
                  {p.icon}
                </div>
                <h3 className="font-display text-xl font-bold text-stone-900 mb-3">{p.title}</h3>
                <p className="text-stone-600 text-sm leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="py-24 bg-white">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="font-display text-4xl font-bold text-stone-900 mb-4">Get involved</h2>
          <p className="text-stone-600 text-lg mb-10">
            Whether you are a researcher, farmer, developer, or development organisation —
            there is a role for you in the OSI community.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <a
              href="mailto:philippe.hess@opensmartirrigation.org"
              className="inline-flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white px-8 py-4 rounded-full font-semibold transition-colors text-base shadow-lg shadow-green-900/20"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Get in touch
            </a>
            <a
              href="https://github.com/Open-Smart-Irrigation"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 border-2 border-stone-200 text-stone-700 hover:border-stone-300 hover:bg-stone-50 px-8 py-4 rounded-full font-semibold transition-colors text-base"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
              View on GitHub
            </a>
          </div>
        </div>
      </section>
    </>
  )
}
