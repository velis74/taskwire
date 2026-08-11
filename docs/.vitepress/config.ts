import { defineConfig } from 'vitepress';

// This directory is the user-facing documentation and nothing else. The normative specification and
// the design brief live in `design/`, deliberately outside the VitePress source root: they record
// why the library is what it is, and would only mislead somebody trying to use it.
export default defineConfig({
  title: 'taskwire',
  description: 'Progress reporting and awaitable dialogs for long-running operations',
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API Reference', link: '/api/python' },
    ],
    sidebar: {
      '/guide/': [{ text: 'Guide', items: [{ text: 'Getting Started', link: '/guide/getting-started' }] }],
      '/api/': [{ text: 'API Reference', items: [{ text: 'Python', link: '/api/python' }] }],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/velis74/taskwire' }],
    footer: { message: 'Released under the MIT License.' },
  },
});
