/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'logo.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Logic in a Tab',
        short_name: 'Logic',
        description:
          'A logic analyzer in your browser. Capture from Pico-based analyzers over Web Serial, decode UART, I2C and SPI, and exchange .sr files with PulseView.',
        theme_color: '#0b0f14',
        background_color: '#0b0f14',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        scope: '.',
        categories: ['developer', 'utilities', 'productivity'],
        file_handlers: [
          {
            action: '.',
            accept: { 'application/zip': ['.sr'] },
          },
        ],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // woff2 covers every browser that has Web Serial; the .woff fallbacks are not precached.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/decoders/**', 'src/formats/**', 'src/drivers/**', 'src/storage/**', 'src/render/viewport.ts'],
      exclude: ['**/*.test.ts'],
    },
  },
});
