/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// GitHub Pages serves the app from /probewire/; local builds and previews use /.
const base = process.env.BASE_PATH ?? '/';

const BOARD = '#152724';
const MASK = '#0f1d1b';

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'logo.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: base,
        name: 'Probewire',
        short_name: 'Probewire',
        description:
          'A logic analyzer in your browser tab. Capture from Raspberry Pi Pico analyzers over USB, decode UART, I2C and SPI, and exchange .sr files with PulseView.',
        theme_color: BOARD,
        background_color: MASK,
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
  preview: {
    port: 4799,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/core/**', 'src/decoders/**', 'src/formats/**', 'src/drivers/**', 'src/storage/**', 'src/render/viewport.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: { statements: 80, lines: 80, functions: 80, branches: 70 },
    },
  },
});
