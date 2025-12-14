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
      '/api': {
        target: 'http://localhost:1880',
        changeOrigin: true
      },
      '/auth': {
        target: 'http://localhost:1880',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
