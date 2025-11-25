import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  plugins: [react()],
  base: '/gui/',  // Must match httpStaticRoot in Node-RED settings.js
  server: {
    port: 3000,
    host: true
  },
  build: {
    outDir: path.resolve(__dirname, '../../feeds/chirpstack-openwrt-feed/apps/node-red/files/gui'),
    emptyOutDir: true
  }
})
