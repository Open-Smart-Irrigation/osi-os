import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Our Team',
  description:
    'The interdisciplinary team behind Open Smart Irrigation — researchers, engineers, educators, and farmers working together.',
}

const coreTeam = [
  {
    name: 'Philippe Hess',
    role: 'Project Lead',
    bio: 'Founder of OSI and agricultural researcher, overseeing all activities from concept to fieldwork with a focus on practical impact.',
    photo: '/team/philippe.jpeg',
    initials: 'PH',
  },
  {
    name: 'Hannah Burkard',
    role: 'Legal & Education',
    bio: "Lawyer and expert in female empowered education, shaping OSI Academy's inclusive training programmes.",
    photo: '/team/hannah.jpeg',
    initials: 'HB',
  },
  {
    name: 'Sofia Felicioni',
    role: 'Agronomy & Training',
    bio: 'Horticulture specialist guiding field trials, scientific data aggregation, and farmer training.',
    photo: '/team/sofia.jpg',
    initials: 'SF',
  },
  {
    name: 'Joel Ikabat',
    role: 'Country Manager Uganda',
    bio: "Agricultural engineer with deep field expertise and strong community ties, leading OSI's pilot implementation and managing local partnerships across Uganda.",
    photo: '/team/joel.jpeg',
    initials: 'JI',
  },
  {
    name: 'Silvan Imhof',
    role: 'Software Development (Backend)',
    bio: 'Engineer and enthusiastic open-source contributor, leading the backend development of OSI OS with a focus on modularity, system stability, and long-term maintainability.',
    photo: '/team/silvan.jpeg',
    initials: 'SI',
  },
  {
    name: 'Panya Gisler',
    role: 'Software Development (Frontend)',
    bio: 'User interface designer focused on intuitive design, developing the OSI OS frontend and OSI Academy web platform.',
    photo: '/team/panya.jpg',
    initials: 'PG',
  },
]

const advisoryBoard = [
  {
    name: 'Elodie Huber',
    role: 'Business Strategy & Investor Relations',
    bio: 'Experienced startup consultant with a finance background, advising OSI on growth strategy and investment readiness.',
    photo: '/team/elodie.jpeg',
    initials: 'EH',
  },
  {
    name: 'Jesper Clement',
    role: 'Marketing & User-Centred Design',
    bio: "Professor of consumer behaviour and intuitive design, supporting OSI's approach to user-friendly technology.",
    photo: '/team/jesper.jpeg',
    initials: 'JC',
  },
  {
    name: 'Thomas Anken',
    role: 'Smart Irrigation & Agronomy',
    bio: 'Head of digital production at Agroscope, providing expert guidance on precision agriculture and field evaluation.',
    photo: '/team/thomas.jpeg',
    initials: 'TA',
  },
  {
    name: 'Alex Mathis',
    role: 'Sustainable Crop Production',
    bio: 'Senior researcher and lecturer in vegetable crops (ZHAW), enhancing the OSI Academy curriculum on sustainable farming practices.',
    photo: '/team/alex.jpg',
    initials: 'AM',
  },
]

function Avatar({ photo, initials, name }: { photo: string; initials: string; name: string }) {
  return (
    <div className="w-16 h-16 rounded-full overflow-hidden shrink-0 bg-stone-200">
      <Image
        src={photo}
        alt={name}
        width={64}
        height={64}
        className="object-cover w-full h-full"
        unoptimized
      />
    </div>
  )
}

export default function OurTeamPage() {
  return (
    <>
      {/* Hero */}
      <section className="bg-stone-900 pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <span className="text-green-400 text-sm font-semibold tracking-widest uppercase mb-4 block">
            Our Team
          </span>
          <h1 className="font-display text-5xl md:text-6xl font-bold text-white leading-tight mb-6">
            The people behind OSI
          </h1>
          <p className="text-stone-300 text-xl leading-relaxed max-w-2xl">
            An interdisciplinary team with deep expertise in agriculture, technology, education,
            and sustainable development — united by a shared commitment to farmer-centred
            innovation.
          </p>
        </div>
      </section>

      {/* Intro */}
      <section className="py-16 bg-white border-b border-stone-100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-stone-600 text-xl leading-relaxed">
            The Open Smart Irrigation initiative is driven by a team with hands-on experience
            and passion for the field, while our advisory board provides strategic guidance
            across key disciplines.
          </p>
        </div>
      </section>

      {/* Core team */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="font-display text-3xl font-bold text-stone-900 mb-10">Core team</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {coreTeam.map((person) => (
              <div
                key={person.name}
                className="bg-stone-50 rounded-2xl p-6 border border-stone-100 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start gap-4 mb-4">
                  <Avatar photo={person.photo} initials={person.initials} name={person.name} />
                  <div>
                    <h3 className="font-display text-lg font-bold text-stone-900">
                      {person.name}
                    </h3>
                    <p className="text-green-700 text-sm font-medium">{person.role}</p>
                  </div>
                </div>
                <p className="text-stone-600 text-sm leading-relaxed">{person.bio}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Advisory board */}
      <section className="py-20 bg-stone-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="font-display text-3xl font-bold text-stone-900 mb-3">Advisory board</h2>
          <p className="text-stone-600 mb-10 max-w-xl">
            Our advisory board provides strategic guidance across business, design,
            agronomy, and sustainable development.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {advisoryBoard.map((person) => (
              <div
                key={person.name}
                className="bg-white rounded-2xl p-6 shadow-sm border border-stone-100 flex gap-4 items-start"
              >
                <Avatar photo={person.photo} initials={person.initials} name={person.name} />
                <div>
                  <h3 className="font-display text-lg font-bold text-stone-900">{person.name}</h3>
                  <p className="text-stone-500 text-sm font-medium mb-2">{person.role}</p>
                  <p className="text-stone-600 text-sm leading-relaxed">{person.bio}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Partner institutions */}
      <section className="py-14 bg-white border-t border-stone-100">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-stone-500 text-sm uppercase tracking-widest font-semibold mb-6">
            Research partners &amp; institutions
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            {['Agroscope', 'ZHAW', 'Makerere University', 'FoodLAND', 'VIA'].map((p) => (
              <span
                key={p}
                className="px-5 py-2 bg-stone-50 border border-stone-200 rounded-full text-stone-600 text-sm font-medium"
              >
                {p}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 bg-green-950">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="font-display text-3xl font-bold text-white mb-4">
            Join the community
          </h2>
          <p className="text-green-300 text-lg mb-8">
            We welcome researchers, engineers, farmers, and development partners.
            Get in touch to explore collaboration.
          </p>
          <a
            href="mailto:philippe.hess@opensmartirrigation.org"
            className="inline-flex items-center gap-2 bg-green-500 hover:bg-green-400 text-white px-8 py-4 rounded-full font-semibold transition-colors text-base"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Get in touch
          </a>
        </div>
      </section>
    </>
  )
}
