import { defineConfig } from 'vitepress';

// This directory is the user-facing documentation and nothing else. The normative specification and
// the design brief live in `design/`, deliberately outside the VitePress source root: they record
// why the library is what it is, and would only mislead somebody trying to use it.
export default defineConfig({
  title: 'taskwire',
  description: 'Progress reporting and awaitable dialogs for long-running operations',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/taskwire-icon.svg' }]],
  themeConfig: {
    logo: '/taskwire-icon.svg',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API Reference', link: '/api/python' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Progress and nesting', link: '/guide/progress' },
            { text: 'Dialogs', link: '/guide/dialogs' },
            { text: 'Cancellation', link: '/guide/cancellation' },
            { text: 'Collectable results', link: '/guide/results' },
            { text: 'Several operations', link: '/guide/several-operations' },
            { text: 'Transports', link: '/guide/transports' },
            { text: 'Tracking calls', link: '/guide/tracking-calls' },
            { text: 'The WebSocket transport', link: '/guide/websockets' },
            { text: 'fastapi-viewsets integration', link: '/guide/fastapi-viewsets' },
            { text: 'Changelog', link: '/guide/changelog' },
            { text: 'Migration guide', link: '/guide/migration' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API reference',
          items: [
            { text: 'Python', link: '/api/python' },
            { text: 'TypeScript', link: '/api/typescript' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/velis74/taskwire' }],
    footer: { message: 'Released under the MIT License.' },
  },
});
