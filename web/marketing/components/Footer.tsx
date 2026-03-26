import Link from 'next/link'

const navLinks = [
  { href: '/global-water-crisis', label: 'Global Water Crisis' },
  { href: '/our-background', label: 'Our Background' },
  { href: '/our-vision', label: 'Our Vision' },
  { href: '/osi-system', label: 'OSI System' },
  { href: '/our-team', label: 'Our Team' },
]

export default function Footer() {
  return (
    <footer className="bg-green-950 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
          {/* Brand */}
          <div>
            <div className="flex items-center gap-2 font-display text-xl font-bold mb-4">
              <svg
                className="w-6 h-6 text-green-400"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M17 8C8 10 5.9 16.17 3.82 21.34L5.71 22l1-2.3A4.49 4.49 0 0 0 8 20C19 20 22 3 22 3c-1 2-8 2-8 2 4 0 6 3 6 3-8 0-10 4-10 4 6 0 8 4 8 4-8 0-10.17 5.07-10.17 5.07" />
              </svg>
              <span>Open Smart Irrigation</span>
            </div>
            <p className="text-green-300 text-sm leading-relaxed mb-4">
              Empowering farmers and conserving water to build a sustainable tomorrow.
            </p>
            <p className="text-green-500 text-xs italic">
              &ldquo;...because every drop counts!&rdquo;
            </p>
          </div>

          {/* Navigation */}
          <div>
            <h3 className="font-semibold text-green-400 uppercase text-xs tracking-wider mb-4">
              Explore
            </h3>
            <ul className="space-y-2">
              {navLinks.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="text-sm text-green-200 hover:text-white transition-colors"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h3 className="font-semibold text-green-400 uppercase text-xs tracking-wider mb-4">
              Get in Touch
            </h3>
            <a
              href="mailto:philippe.hess@opensmartirrigation.org"
              className="block text-sm text-green-200 hover:text-white transition-colors mb-4 break-all"
            >
              philippe.hess@opensmartirrigation.org
            </a>
            <div className="flex gap-4">
              <a
                href="https://youtube.com/@OSI-ORG"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-green-300 hover:text-white transition-colors text-sm"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.55 3.5 12 3.5 12 3.5s-7.55 0-9.38.55A3.02 3.02 0 0 0 .5 6.19C0 8.03 0 12 0 12s0 3.97.5 5.81a3.02 3.02 0 0 0 2.12 2.14C4.45 20.5 12 20.5 12 20.5s7.55 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14C24 15.97 24 12 24 12s0-3.97-.5-5.81zM9.75 15.02V8.98L15.5 12l-5.75 3.02z" />
                </svg>
                YouTube
              </a>
              <a
                href="https://linkedin.com/company/open-smart-irrigation"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-green-300 hover:text-white transition-colors text-sm"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                </svg>
                LinkedIn
              </a>
              <a
                href="https://t.me/opensmartirrigation"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-green-300 hover:text-white transition-colors text-sm"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                </svg>
                Telegram
              </a>
            </div>
          </div>
        </div>

        <div className="border-t border-green-900 mt-12 pt-8 flex flex-col sm:flex-row justify-between items-center gap-4 text-green-600 text-sm">
          <p>© 2026 Open Smart Irrigation</p>
          <p>Open-source · MIT Licensed · Built from the field</p>
        </div>
      </div>
    </footer>
  )
}
