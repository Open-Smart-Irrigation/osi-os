/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // High contrast colors for farmers in developing countries
      colors: {
        'farm-green': '#22c55e',
        'farm-red': '#ef4444',
        'farm-blue': '#3b82f6',
        'farm-yellow': '#eab308',
      }
    },
  },
  plugins: [],
}
