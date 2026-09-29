import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'fs'

// The app's version, shown in Settings › About; package.json is the one place to bump it.
const APP_VERSION = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['icons/favicon-32.png', 'icons/apple-touch-icon-180.png'],
      manifest: {
        name: 'Vastra.io',
        short_name: 'Vastra',
        description: 'Personal wardrobe management',
        theme_color: '#111111',
        background_color: '#fafaf8',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-48.png', sizes: '48x48', type: 'image/png' },
          { src: '/icons/icon-72.png', sizes: '72x72', type: 'image/png' },
          { src: '/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
          { src: '/icons/icon-144.png', sizes: '144x144', type: 'image/png' },
          { src: '/icons/icon-168.png', sizes: '168x168', type: 'image/png' },
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        apple_touch_icon: '/icons/apple-touch-icon-180.png',
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'name',
            text: 'description',
            url: 'link',
            files: [
              {
                name: 'image',
                // BOTH MIME types AND extensions — Android Chrome silently rejects
                // file-shares from some apps when only MIME types are listed.
                accept: ['image/*', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'],
              },
            ],
          },
        },
      },
      // Custom service worker lives in src/sw.ts. It owns precaching, the SPA
      // navigation fallback (with the /api/* denylist), runtime caching, and the
      // push / notificationclick handlers. globPatterns feed self.__WB_MANIFEST.
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // Not `true`: that disables Vite's DNS-rebinding host check. IPs and
    // localhost are always allowed (LAN phone testing); quick-tunnel domains
    // cover scripts/dev.ts.
    allowedHosts: ['.trycloudflare.com'],
    // changeOrigin stays false on EVERY proxy: rewriting Host to :3000 makes
    // it diverge from the browser's Origin (http://localhost:5173), which the
    // CSRF middleware rejects — every mutation would 403 in dev (#295 review
    // item 1). Express doesn't depend on Host, so the browser's Host — and the
    // Cloudflare-tunnel domain in scripts/dev.ts — reaches it unchanged.
    //
    // /mcp (#317) isn't under /api, so it needs its own entry: without it the
    // tunnel URL from scripts/dev.ts serves the SPA for /mcp and sandboxed MCP
    // clients (Codex etc.) that can't reach this machine's localhost have no
    // route to the server. /mcp is bearer-only (no cookie/CSRF), but keeping
    // Host unchanged is consistent and harmless. No extra options: http-proxy
    // pipes responses unbuffered with no proxy timeout, so Streamable HTTP
    // (JSON today, SSE if ever enabled) passes straight through.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
      '/images': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
      '/mcp': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
  },
})
