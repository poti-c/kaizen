import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
import path from 'path'

export default defineConfig({
  // Honor the PORT env var (set by the Claude preview launcher); default 5176 for manual runs.
  // host: true binds IPv6 + IPv4 — the preview panel connects via ::1.
  server: {
    host: true,
    port: Number(process.env.PORT) || 5176,
  },
  plugins: [
    react(),
    // Ship a `nomodule` fallback bundle (SystemJS + core-js polyfills) for old Android /
    // Chrome < 80, which otherwise SyntaxError on `??` and render a blank page. Modern
    // browsers are UNAFFECTED — they keep loading the untouched `type="module"` bundle;
    // the legacy chunks only exist in dist/ and are served via `nomodule`.
    legacy({
      targets: ['Android >= 6', 'Chrome >= 61', 'iOS >= 11', 'Safari >= 11'],
      // Also polyfill any modern syntax/APIs we ship in the MODERN bundle for the
      // in-between engines (native-ESM but pre-ES2020) that load it.
      modernPolyfills: true,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
