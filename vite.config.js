import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Use relative asset URLs so the bundle works regardless of the path the
  // server is mounted at. Combined with server-side BASE_URL support, this
  // lets the same image run at `/`, `/notetrace/`, or any other prefix
  // without a rebuild.
  base: './',
  server: {
    proxy: {
      '/api':     'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
    }
  },
  build: {
    // Main bundle was past the 500KB warning at v0.1.0; manualChunks
    // peels third-party libs into their own async chunks so the
    // initial paint downloads only what the start page needs.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/jszip')) return 'jszip';
          if (id.includes('node_modules/cheerio')) return 'cheerio';
          if (id.includes('node_modules/@zxing')) return 'zxing';
          if (id.includes('node_modules/quagga')) return 'quagga';
          // Bucket every other node_modules dep into a single
          // 'vendor' chunk so the main app code stays small.
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
  // Capacitor native build: output to dist/ (default) — capacitor.config.ts points webDir here
  plugins: [
    svelte(),
    VitePWA({
      // 'prompt' downloads new bundles but WAITS for the app to
      // call updateSW(true) before activating. That's what lets us
      // show a "Reload" banner instead of swapping the page out from
      // under the user with no warning. See src/lib/pwa-update.js
      // for the Svelte-side bridge.
      registerType: 'prompt',
      workbox: {
        globPatterns: ['offline.html'],
        // Opens the note when a reminder notification is clicked (public/sw-notifications.js).
        importScripts: ['sw-notifications.js'],
        navigateFallback: null,
        navigateFallbackDenylist: [/.*/],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages-cache',
              networkTimeoutSeconds: 3,
            }
          },
        ]
      },
      manifest: {
        name: 'NoteTrace',
        short_name: 'NoteTrace',
        description: 'Trace Every Thought. Self-hosted notes, lists, and reminders.',
        theme_color: '#0A0B0F',
        background_color: '#0A0B0F',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        // Installed PWA shows up in the OS share sheet; the server turns the
        // GET into a hash route that opens a pre-filled new note.
        share_target: {
          action: 'share-target',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
});
