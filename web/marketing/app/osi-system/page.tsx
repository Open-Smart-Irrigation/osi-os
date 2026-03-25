import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'OSI System',
  description:
    'How OSI works: OSI OS, an open-source offline irrigation hub, and OSI Academy, a multilingual training platform for smallholder farmers.',
}

export default function OsiSystemPage() {
  return (
    <>
      {/* Hero */}
      <section className="bg-green-900 pt-32 pb-20 relative overflow-hidden">
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-green-700/20 blur-3xl pointer-events-none" />
        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <span className="text-green-400 text-sm font-semibold tracking-widest uppercase mb-4 block">
            OSI System
          </span>
          <h1 className="font-display text-5xl md:text-6xl font-bold text-white leading-tight mb-6">
            How OSI Works
          </h1>
          <p className="text-green-200 text-xl leading-relaxed max-w-2xl">
            A practical approach to smart irrigation, built around two pillars:
            open technology and local knowledge.
          </p>
        </div>
      </section>

      {/* Intro */}
      <section className="py-16 bg-white border-b border-stone-100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-stone-600 text-xl leading-relaxed">
            Open Smart Irrigation combines open technology, local training, and real-world
            field validation to deliver scalable solutions for smallholder farmers. The system
            is built around two key pillars.
          </p>
        </div>
      </section>

      {/* OSI OS */}
      <section className="py-20 bg-white" id="osi-os">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
            <div>
              <div className="w-14 h-14 bg-green-100 rounded-2xl flex items-center justify-center mb-6">
                <svg
                  className="w-7 h-7 text-green-700"
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
              <span className="text-green-600 text-sm font-semibold tracking-widest uppercase mb-2 block">
                Pillar One
              </span>
              <h2 className="font-display text-4xl font-bold text-stone-900 mb-4 leading-tight">
                OSI OS
              </h2>
              <p className="text-stone-600 leading-relaxed mb-6 text-lg">
                An open-source operating system for smart irrigation hubs, built on
                ChirpStack Gateway OS and Raspberry Pi — designed to work where others fail.
              </p>
              <p className="text-stone-600 leading-relaxed">
                A single hub maintained by a trained local operator can serve multiple farmers
                within its LoRa network. The &ldquo;superuser model&rdquo; makes community-scale
                deployment practical and sustainable without ongoing external support.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4">
              {[
                {
                  title: 'Offline-first operation',
                  desc: 'Stores and processes sensor data locally, schedules irrigation events, and offers a web dashboard via Wi-Fi — no internet required.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829l-2.829-2.829m0 0a5 5 0 010-7.072m0 0l2.829 2.829M9 9l2.828 2.828" />
                    </svg>
                  ),
                },
                {
                  title: 'LoRa radio communication',
                  desc: 'Long-range, low-power wireless technology connects soil sensors and smart valves up to several kilometres away.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
                    </svg>
                  ),
                },
                {
                  title: 'Solar-powered, ultra-low energy',
                  desc: 'Components run entirely off-grid on solar panels or long-life batteries — with lifespans of up to 10 years.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                  ),
                },
                {
                  title: 'Visual programming with Node-RED',
                  desc: 'All logic runs locally using Node-RED — a visual programming environment that is beginner-friendly and highly adaptable.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                    </svg>
                  ),
                },
                {
                  title: 'Modular sensor ecosystem',
                  desc: 'Plugin system integrates soil moisture sensors, dendrometers, and smart actuators — built to grow with your needs.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                  ),
                },
                {
                  title: 'Free and open-source',
                  desc: 'MIT licensed for unrestricted use, modification, and distribution. Farmers and developers own their systems completely.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                    </svg>
                  ),
                },
              ].map((f) => (
                <div key={f.title} className="flex gap-4 items-start bg-stone-50 rounded-xl p-4">
                  <div className="w-9 h-9 rounded-lg bg-green-100 text-green-700 flex items-center justify-center shrink-0">
                    {f.icon}
                  </div>
                  <div>
                    <p className="font-semibold text-stone-900 text-sm mb-0.5">{f.title}</p>
                    <p className="text-stone-500 text-sm leading-relaxed">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Divider */}
      <div className="h-px bg-stone-100 max-w-7xl mx-auto" />

      {/* OSI Academy */}
      <section className="py-20 bg-white" id="osi-academy">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
            <div className="order-1 lg:order-2">
              <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mb-6">
                <svg
                  className="w-7 h-7 text-amber-700"
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
              <span className="text-amber-600 text-sm font-semibold tracking-widest uppercase mb-2 block">
                Pillar Two
              </span>
              <h2 className="font-display text-4xl font-bold text-stone-900 mb-4 leading-tight">
                OSI Academy
              </h2>
              <p className="text-stone-600 leading-relaxed mb-6 text-lg">
                The second core element of the OSI platform ensures that technology is not
                only available — but usable and empowering.
              </p>
              <p className="text-stone-600 leading-relaxed">
                OSI Academy makes sure farmers are not just recipients of technology —
                they are co-creators and operators of smart water technology, trained through
                community learning and supported by a growing global network.
              </p>
            </div>
            <div className="order-2 lg:order-1 grid grid-cols-1 gap-4">
              {[
                {
                  title: 'Step-by-step video tutorials',
                  desc: 'Comprehensive multilingual guides explain system setup, operation, and maintenance in accessible, practical formats.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  ),
                },
                {
                  title: 'On-ground workshops & field installations',
                  desc: 'Hands-on training at demonstration sites equips local operators to manage community hubs and support peers.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  ),
                },
                {
                  title: 'The superuser model',
                  desc: 'Trained local operators manage irrigation hubs for their community — building local expertise that stays in the community.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                  ),
                },
                {
                  title: 'Women-focused training & leadership',
                  desc: 'Targeted programmes actively support women — often underrepresented in agricultural decision-making — as community leaders.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                    </svg>
                  ),
                },
                {
                  title: 'Agronomist-supported science',
                  desc: 'Farmers are supported by agronomists and research partners, ensuring environmental and social impacts are accurately measured.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                  ),
                },
                {
                  title: 'Access to funding opportunities',
                  desc: 'Workshops also support farmers in identifying and accessing funding for irrigation components.',
                  icon: (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  ),
                },
              ].map((f) => (
                <div key={f.title} className="flex gap-4 items-start bg-amber-50/60 rounded-xl p-4">
                  <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                    {f.icon}
                  </div>
                  <div>
                    <p className="font-semibold text-stone-900 text-sm mb-0.5">{f.title}</p>
                    <p className="text-stone-500 text-sm leading-relaxed">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Conclusion */}
      <section className="py-16 bg-green-950">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="font-display text-xl md:text-2xl text-green-100 leading-relaxed">
            Together, OSI OS and OSI Academy deliver a practical, field-tested solution that
            adapts to the realities of smallholder agriculture while building toward long-term
            resilience and sustainability.
          </p>
        </div>
      </section>

      {/* Open source CTA */}
      <section className="py-16 bg-stone-50 border-t border-stone-100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-6">
          <p className="text-stone-700 font-medium text-lg">
            OSI OS is open-source and available on GitHub
          </p>
          <div className="flex gap-4">
            <a
              href="https://github.com/Open-Smart-Irrigation"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-stone-900 hover:bg-stone-700 text-white px-6 py-3 rounded-full font-semibold transition-colors shrink-0 text-sm"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
              GitHub
            </a>
            <Link
              href="/our-team"
              className="inline-flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white px-6 py-3 rounded-full font-semibold transition-colors shrink-0 text-sm"
            >
              Meet the team
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
