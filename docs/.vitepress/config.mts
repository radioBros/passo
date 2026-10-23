import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'PASSO',
  description: 'Italian e-invoicing relay — CRM to SdI via pluggable channels',
  lastUpdated: true,
  cleanUrls: true,
  head: [
    ['link', { rel: 'icon', href: '/logo.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'alternate icon', href: '/logo.png', type: 'image/png' }],
  ],
  themeConfig: {
    logo: '/logo.png',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/overview' },
      { text: 'Integrations', link: '/integrations/channels' },
      { text: 'Operations', link: '/operations/runbook' },
      { text: 'Reference', link: '/reference/configuration' },
      { text: 'Compliance', link: '/compliance/data-protection' },
    ],
    sidebar: {
      '/guide/': [{
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'How PASSO works', link: '/guide/architecture' },
          { text: 'What PASSO is not', link: '/guide/scope' },
          { text: 'Submission lifecycle', link: '/guide/lifecycle' },
          { text: 'Integration modes', link: '/guide/integration-modes' },
          { text: 'Multi-tenancy', link: '/guide/tenancy' },
          { text: 'Italian e-invoicing primer', link: '/guide/fatturapa' },
        ],
      }],
      '/api/': [{
        text: 'API',
        items: [
          { text: 'Overview', link: '/api/overview' },
          { text: 'API reference (OpenAPI)', link: '/api/reference' },
          { text: 'Submitting invoices', link: '/api/invoices' },
          { text: 'Invoice data model', link: '/api/invoice-model' },
          { text: 'Notifications & webhooks', link: '/api/webhooks' },
          { text: 'Transformations API', link: '/api/transformations' },
          { text: 'Privacy and export', link: '/api/privacy' },
          { text: 'Admin API', link: '/api/admin' },
          { text: 'Errors', link: '/api/errors' },
        ],
      }],
      '/integrations/': [{
        text: 'Integrations',
        items: [
          { text: 'SdI channels', link: '/integrations/channels' },
          { text: 'Transformations', link: '/integrations/transformations' },
          { text: 'MCP server', link: '/integrations/mcp' },
        ],
      }],
      '/operations/': [{
        text: 'Operations',
        items: [
          { text: 'Runbook', link: '/operations/runbook' },
          { text: 'Deployment', link: '/operations/deployment' },
          { text: 'Security', link: '/operations/security' },
          { text: 'Backup & restore', link: '/operations/backup' },
          { text: 'Sizing', link: '/operations/sizing' },
          { text: 'Alerts', link: '/operations/alerts' },
          { text: 'DLQ and quarantine', link: '/operations/dlq' },
          { text: 'Troubleshooting', link: '/operations/troubleshooting' },
        ],
      }],
      '/compliance/': [{
        text: 'Compliance',
        items: [
          { text: 'Data protection', link: '/compliance/data-protection' },
        ],
      }],
      '/reference/': [{
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Database schema', link: '/reference/schema' },
          { text: 'Queue topology', link: '/reference/queues' },
        ],
      }],
    },
    search: { provider: 'local' },
    footer: {
      message: 'AGPL-3.0-or-later · PASSO is software, not tax advice.',
    },
  },
});
