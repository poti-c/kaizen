import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  // Honor the PORT env var (set by the Claude preview launcher); default 5176 for manual runs.
  // host: true binds IPv6 + IPv4 — the preview panel connects via ::1.
  server: {
    host: true,
    port: Number(process.env.PORT) || 5176,
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
