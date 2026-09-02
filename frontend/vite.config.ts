import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * Split the big third-party libraries into their own chunks.
         *
         * Two reasons this matters here:
         *
         *  1. Charting (recharts + d3) is only used on Analytics and Data
         *     Pipeline. Bundled with everything else it was downloaded by
         *     people who never open those pages.
         *
         *  2. Vendor code changes far less often than salon code. Separate
         *     chunks get separate content hashes, so a tweak to a dashboard no
         *     longer invalidates the cached copy of React and Recharts — repeat
         *     visits re-download only what actually changed.
         *
         * xlsx / jsPDF are deliberately absent: they are reached through
         * dynamic import() at export time, so Rollup already isolates them.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return

          // Only split libraries the ENTRY genuinely needs. Recharts is
          // deliberately NOT listed: naming it forces it into a single chunk
          // that Rollup then hoists into the entry's static graph, undoing the
          // lazy routing. Left alone, it lands in the async chunks that
          // actually use it (Analytics, Data Pipeline) and is never fetched by
          // someone who only visits the landing page.
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('react-router')) {
            return 'react-vendor'
          }
          if (id.includes('framer-motion')) return 'motion'
        },
      },
    },
    // The remaining warning is the export chunk, which is intentionally large
    // and loaded on demand. Keep the ceiling meaningful rather than noisy.
    chunkSizeWarningLimit: 700,
  },
})
