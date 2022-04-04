/// <reference types="node" />

import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "dotoleeoak's home",
  description: '민트초코를 싫어하는 minchoi',
  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }]
  ],
  // <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  vite: {
    server: {
      hmr: {
        // hmr websocket port for gitpod
        clientPort: process.env.GITPOD_HOST ? 443 : undefined
      }
    }
  }
})
