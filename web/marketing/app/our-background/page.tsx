import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Our Background',
  description:
    'OSI was born from real-world field research in Uganda. Learn about the field trials, farmer surveys, and design principles that shaped the platform.',
}

export default function OurBackgroundPage() {
  return (
    <>
      {/* Hero */}
      <section className="relative bg-stone-900 pt-32 pb-20 overflow-hidden">
        <Image
          src="https://images.unsplash.com/photo-1464226184884-fa280b87c399?auto=format&fit=crop&w=1920&q=80"
          alt="Irrigation drip system in a crop field"
          fill
          className="object-cover opacity-30"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-b from-stone-900/80 to-stone-900" />
        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <span className="text-amber-400 text-sm font-semibold tracking-widest uppercase mb-4 block">
            Our Background
          </span>
          <h1 className="font-display text-5xl md:text-6xl font-bold text-white leading-tight mb-6">
            Developed from the field
          </h1>
          <p className="text-stone-300 text-xl leading-relaxed max-w-2xl">
            OSI was born out of real-world research — shaped by farmers, field trials,
            and a commitment to accessibility and robustness.
          </p>
        </div>
      </section>

      {/* Timeline / narrative */}
      <section className="py-20 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16">
          {/* Origin */}
          <div>
            <div className="flex items-center gap-3 mb-5">
              <span className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 font-bold flex items-center justify-center text-sm shrink-0">
                01
              </span>
              <h2 className="font-display text-3xl font-bold text-stone-900">
                A research initiative in Uganda
              </h2>
            </div>
            <p className="text-stone-600 leading-relaxed mb-4">
              Everything started with a research initiative embedded within the{' '}
              <a
                href="https://foodland-africa.eu"
                target="_blank"
                rel="noopener noreferrer"
                className="text-green-700 underline underline-offset-2 hover:text-green-600"
              >
                FoodLAND project
              </a>. Philippe Hess led a collaborative field experiment in Uganda, undertaken
              by the Swiss research institute Agroscope, the Zurich University of Applied
              Sciences (ZHAW), and Makerere University in Uganda.
            </p>
            <p className="text-stone-600 leading-relaxed">
              Between 2023 and 2024, field trials near the capital Kampala evaluated smart
              irrigation solutions in terms of water productivity, as well as the technological
              and social barriers to their adoption in low- and middle-income countries (LMICs)
              like Uganda.
            </p>
          </div>

          {/* Field image */}
          <div className="relative aspect-[16/9] rounded-2xl overflow-hidden">
            <Image
              src="https://images.unsplash.com/photo-1523348837708-15d4a09cfac2?auto=format&fit=crop&w=1200&q=80"
              alt="Field research in Uganda"
              fill
              className="object-cover"
              unoptimized
            />
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-6">
              <p className="text-white text-sm">
                Field trials near Kampala, Uganda, 2023–2024
              </p>
            </div>
          </div>

          {/* What they found */}
          <div>
            <div className="flex items-center gap-3 mb-5">
              <span className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 font-bold flex items-center justify-center text-sm shrink-0">
                02
              </span>
              <h2 className="font-display text-3xl font-bold text-stone-900">
                What the trials revealed
              </h2>
            </div>
            <p className="text-stone-600 leading-relaxed mb-4">
              Two systems were tested: a fully automated setup using commercial off-the-shelf
              components, and the manual Chameleon sensor system (developed by VIA), tailored to
              smallholder contexts. Both demonstrated promising results in improving yields and
              conserving water.
            </p>
            <p className="text-stone-600 leading-relaxed mb-6">
              However, the Chameleon sensor stood out for its robustness and simplicity — while
              the fully automated solution, though promising in potential, lacked resilience in
              real-world rural settings. The trials showed that while existing technologies offer
              potential, they often fail in practical deployment where infrastructure is limited
              and cost-sensitivity is high.
            </p>
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-5">
              <p className="text-stone-700 font-medium">
                Key finding: existing market solutions were not built with smallholders in mind.
                Potential existed, but practical adoption required something different.
              </p>
            </div>
          </div>

          {/* Listening */}
          <div>
            <div className="flex items-center gap-3 mb-5">
              <span className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 font-bold flex items-center justify-center text-sm shrink-0">
                03
              </span>
              <h2 className="font-display text-3xl font-bold text-stone-900">
                Listening to farmers
              </h2>
            </div>
            <p className="text-stone-600 leading-relaxed mb-4">
              This insight led us to pause and reassess. In 2024, we travelled across Uganda,
              visiting farms in different climatic zones to better understand the real challenges
              farmers face. By listening directly to their experiences and needs, we gathered
              invaluable perspectives on daily constraints, irrigation practices, and priorities.
            </p>
            <p className="text-stone-600 leading-relaxed">
              The combination of field trials, nationwide farmer interviews, household surveys,
              and literature review resulted in the development of a comprehensive requirement
              catalogue for the successful adoption of smart irrigation technologies in LMICs.
            </p>
          </div>

          {/* Design principles */}
          <div>
            <div className="flex items-center gap-3 mb-5">
              <span className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 font-bold flex items-center justify-center text-sm shrink-0">
                04
              </span>
              <h2 className="font-display text-3xl font-bold text-stone-900">
                Two core design principles
              </h2>
            </div>
            <p className="text-stone-600 leading-relaxed mb-8">
              These requirements fall into two overarching categories that now guide every
              aspect of OSI development:
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-green-50 rounded-2xl p-6 border border-green-100">
                <h3 className="font-display text-xl font-bold text-green-900 mb-4">
                  Accessibility
                </h3>
                <ul className="space-y-2.5">
                  {[
                    'Cost-effective components',
                    'Availability of parts and spares',
                    'Human-centred, intuitive interfaces',
                    'Clear guidelines and hands-on training',
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-sm text-green-800">
                      <svg className="w-4 h-4 text-green-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bg-amber-50 rounded-2xl p-6 border border-amber-100">
                <h3 className="font-display text-xl font-bold text-amber-900 mb-4">
                  Robustness
                </h3>
                <ul className="space-y-2.5">
                  {[
                    'Minimal dependence on electricity and internet',
                    'Resilience to environmental conditions',
                    'Local ownership — no subscriptions or lock-in',
                    'Freedom to maintain, adapt, and operate independently',
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-sm text-amber-800">
                      <svg className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Conclusion */}
          <div className="bg-green-950 rounded-2xl p-8 text-white">
            <p className="text-green-300 text-sm font-semibold tracking-widest uppercase mb-3">
              The result
            </p>
            <p className="font-display text-xl leading-relaxed">
              Since no existing system fully met these criteria, and inspired by the pragmatic
              design philosophy behind the Chameleon sensor, Philippe Hess initiated the
              development of the OSI platform alongside like-minded partners. Grounded in the
              twin pillars of accessibility and robustness, OSI was designed as a modular,
              open-source system tailored specifically for smallholder needs.
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 bg-stone-50 border-t border-stone-100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-6">
          <p className="text-stone-700 font-medium text-lg">
            Meet the people behind OSI
          </p>
          <Link
            href="/our-team"
            className="inline-flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white px-7 py-3 rounded-full font-semibold transition-colors shrink-0"
          >
            Our Team
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </Link>
        </div>
      </section>
    </>
  )
}
