import uiCorePreset from './src/ui-core/tailwind-preset.js';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [uiCorePreset],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
