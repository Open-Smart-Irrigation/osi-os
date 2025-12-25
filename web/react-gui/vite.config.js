import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/gui/',  // Must match httpStaticRoot in Node-RED settings.js
  server: {
    port: 3000,
    host: true,
    proxy: {
      // Proxy API requests to Node-RED backend
      // Use VITE_NODERED_URL env variable or default to localhost
      '/api': {
        target: process.env.VITE_NODERED_URL || 'http://localhost:1880',
        changeOrigin: true,
        secure: false
      },
      '/auth': {
        target: process.env.VITE_NODERED_URL || 'http://localhost:1880',
        changeOrigin: true,
        secure: false
      }
    }
  },
  build: {
    outDir: 'build',  // Changed to match docker-compose volume
    emptyOutDir: true
  }
})
