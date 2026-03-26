'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const links = [
  { href: '/global-water-crisis', label: 'Global Water Crisis' },
  { href: '/our-background', label: 'Our Background' },
  { href: '/our-vision', label: 'Our Vision' },
  { href: '/osi-system', label: 'OSI System' },
  { href: '/our-team', label: 'Our Team' },
]

export default function Nav() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const pathname = usePathname()
  const isHome = pathname === '/'

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 60)
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const transparent = isHome && !scrolled

  return (
    <header
      className={`${
        transparent
          ? 'absolute top-0 left-0 right-0 text-white'
          : 'fixed top-0 left-0 right-0 bg-white/95 backdrop-blur-sm shadow-sm text-stone-900'
      } z-50 transition-all duration-300`}
    >
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2 font-display text-lg font-bold tracking-tight"
        >
          <svg
            className="w-7 h-7 text-green-500"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M17 8C8 10 5.9 16.17 3.82 21.34L5.71 22l1-2.3A4.49 4.49 0 0 0 8 20C19 20 22 3 22 3c-1 2-8 2-8 2 4 0 6 3 6 3-8 0-10 4-10 4 6 0 8 4 8 4-8 0-10.17 5.07-10.17 5.07" />
          </svg>
          <span>OSI</span>
        </Link>

        {/* Desktop nav */}
        <ul className="hidden lg:flex items-center gap-7">
          {links.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className={`text-sm font-medium transition-colors hover:text-green-500 ${
                  pathname === l.href
                    ? transparent
                      ? 'text-green-300'
                      : 'text-green-600'
                    : ''
                }`}
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Mobile hamburger */}
        <button
          className="lg:hidden p-2 -mr-2"
          onClick={() => setOpen(!open)}
          aria-label="Toggle menu"
        >
          <span
            className={`block w-6 h-0.5 bg-current transition-all duration-200 ${
              open ? 'rotate-45 translate-y-1.5' : ''
            }`}
          />
          <span
            className={`block w-6 h-0.5 bg-current mt-1.5 transition-all duration-200 ${
              open ? 'opacity-0' : ''
            }`}
          />
          <span
            className={`block w-6 h-0.5 bg-current mt-1.5 transition-all duration-200 ${
              open ? '-rotate-45 -translate-y-3' : ''
            }`}
          />
        </button>
      </nav>

      {/* Mobile menu */}
      <div
        className={`lg:hidden bg-white border-t border-stone-100 shadow-lg transition-all duration-200 overflow-hidden ${
          open ? 'max-h-96' : 'max-h-0'
        }`}
      >
        <ul className="max-w-7xl mx-auto px-4 py-4 space-y-1">
          {links.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className={`block px-3 py-2 rounded-lg text-stone-900 font-medium hover:bg-green-50 hover:text-green-700 transition-colors ${
                  pathname === l.href ? 'bg-green-50 text-green-700' : ''
                }`}
                onClick={() => setOpen(false)}
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </header>
  )
}
