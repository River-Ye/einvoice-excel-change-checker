import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const developmentCsp = {
  name: 'development-csp',
  apply: 'serve' as const,
  transformIndexHtml: (html: string) =>
    html
      .replace(
        "connect-src 'none'",
        'connect-src ws://localhost:* ws://127.0.0.1:*',
      )
      .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
}

// https://vite.dev/config/
export default defineConfig({
  base: '/einvoice-excel-change-checker/',
  plugins: [vue(), developmentCsp],
  server: {
    watch: {
      usePolling: process.env.WATCH_USE_POLLING === 'true',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
