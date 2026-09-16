import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';

// PDF.js reads these at run time: the 14 standard fonts (a PDF that names
// Helvetica without embedding it), character maps for Asian scripts, and the
// decoders and colour profiles scanned PDFs need. They go out with the app
// under pdfjs/ and are fetched only when a PDF uses them (src/lib/pdf.js).
const PDFJS_DIRS = ['standard_fonts', 'cmaps', 'wasm', 'iccs'];
function pdfjsAssets() {
  const root = path.resolve('node_modules/pdfjs-dist');
  return {
    name: 'pdfjs-assets',
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        const from = path.join(root, dir);
        if (!fs.existsSync(from)) continue;
        for (const name of fs.readdirSync(from)) {
          const file = path.join(from, name);
          if (fs.statSync(file).isFile()) this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${name}`, source: fs.readFileSync(file) });
        }
      }
    },
  };
}

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
          // PDF.js loads only when a PDF is opened or added (src/lib/pdf.js).
          if (id.includes('node_modules/pdfjs-dist')) return 'pdfjs';
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
    pdfjsAssets(),
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
        globPatterns: ['**/*.{js,mjs,css,html,woff2,woff,png,svg,ico,webmanifest}'],
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
              // Only whole responses: the Cache API refuses a 206, and a partial
              // stored as the whole file would play back truncated.
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 60, purgeOnQuotaError: true },
            }
          },
          {
            // PDF.js fonts and decoders: fetched the first time a PDF needs one, then kept.
            urlPattern: ({ url }) => /\/pdfjs\//.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdfjs-assets',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 180 },
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
            // Any file: pictures, recordings, PDFs, documents.
            files: [{ name: 'images', accept: ['*/*'] }],
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
