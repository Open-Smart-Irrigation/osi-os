/**
 * Shared Tailwind preset over the ui-core tokens (tokens.css).
 * Canonical in osi-os web/react-gui/src/ui-core; byte-mirrored to
 * osi-server frontend/src/ui-core. Consumed as `presets: [uiCorePreset]`
 * by each repo's tailwind.config.js (edge activates its config with
 * `@config` in src/index.css because Tailwind v4 is CSS-first).
 */
export default {
  theme: {
    extend: {
      colors: {
        /* Legacy palette moved here from the two repo tailwind configs. */
        'farm-green': '#22c55e',
        'farm-red': '#ef4444',
        'farm-blue': '#3b82f6',
        'farm-yellow': '#eab308',
        /* Semantic names over the ui-core tokens. */
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        card: 'var(--card)',
        text: 'var(--text)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        'text-disabled': 'var(--text-disabled)',
        border: 'var(--border)',
        focus: 'var(--focus)',
        primary: 'var(--primary)',
        'primary-hover': 'var(--primary-hover)',
        'secondary-bg': 'var(--secondary-bg)',
        'header-bg': 'var(--header-bg)',
        'header-text': 'var(--header-text)',
        'header-subtext': 'var(--header-subtext)',
        'brand-red': 'var(--brand-red)',
        'success-bg': 'var(--success-bg)',
        'success-text': 'var(--success-text)',
        'success-border': 'var(--success-border)',
        'warn-bg': 'var(--warn-bg)',
        'warn-text': 'var(--warn-text)',
        'warn-border': 'var(--warn-border)',
        'error-bg': 'var(--error-bg)',
        'error-text': 'var(--error-text)',
        'danger-fg': 'var(--danger-fg)',
        'soil-wet': 'var(--soil-wet)',
        'soil-wet-bg': 'var(--soil-wet-bg)',
        'soil-moist': 'var(--soil-moist)',
        'soil-moist-bg': 'var(--soil-moist-bg)',
        'soil-dry': 'var(--soil-dry)',
        'soil-dry-bg': 'var(--soil-dry-bg)',
        'toggle-on': 'var(--toggle-on)',
        'toggle-off': 'var(--toggle-off)',
        overlay: 'var(--overlay)',
      },
    },
  },
};
