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
      '/api':     'http://localhost:3004',
      '/uploads': 'http://localhost:3004',
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
        // The app itself is cached, so the installed web app opens without a
        // connection and shows the notes, images, and voice notes it has seen.
        globPatterns: ['**/*.{js,css,html,woff2,woff,png,svg,ico,webmanifest}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Reminder notification clicks and shared photos (public/sw-extras.js).
        importScripts: ['sw-extras.js'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//, /^\/share-target/],
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
          {
            // Images and voice notes: kept after the first play or view, and
            // rangeRequests lets a cached recording be scrubbed offline.
            urlPattern: ({ url }) => url.pathname.startsWith('/uploads/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'note-files',
              rangeRequests: true,
              cacheableResponse: { statuses: [0, 200, 206] },
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 60, purgeOnQuotaError: true },
            }
          },
          {
            // The last notes, labels, and settings seen, so the app opens with
            // something to read offline. Writes still need the server.
            urlPattern: ({ url, request }) => request.method === 'GET' && /^\/api\/(notes|labels|settings)/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'note-data',
              networkTimeoutSeconds: 4,
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 14 },
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
        // Long-press the installed app's icon: start a voice note, a note, or a list.
        shortcuts: [
          { name: 'Voice Note', short_name: 'Voice Note', url: './#/?new=voice', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'New Note', short_name: 'New Note', url: './#/?new=text', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'New List', short_name: 'New List', url: './#/?new=checklist', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
        ],
        // Installed PWA shows up in the OS share sheet; the server turns the
        // GET into a hash route that opens a pre-filled new note.
        // POST so photos can come along. The service worker takes the share
        // (public/sw-extras.js); /share-target on the server is the fallback
        // for text before the worker is installed.
        share_target: {
          action: 'share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [{ name: 'images', accept: ['image/*', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', 'audio/*', '.m4a', '.mp3', '.wav', '.ogg', '.opus', '.webm', '.aac', '.amr', '.3gp'] }],
          },
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
