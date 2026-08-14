import type {Config} from '@docusaurus/types';
import type {Options, ThemeConfig} from '@docusaurus/preset-classic';
import {themes as prismThemes} from 'prism-react-renderer';

const config: Config = {
  title: 'openapi-yagen',
  tagline: 'Extensible OpenAPI code generation',
  favicon: 'img/openapi-yagen.png',
  url: 'https://openapi-yagen.github.io',
  baseUrl: '/openapi-yagen/',
  organizationName: 'openapi-yagen',
  projectName: 'openapi-yagen',
  trailingSlash: false,
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  staticDirectories: ['.generated-static'],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: '..',
          routeBasePath: '/',
          include: [
            'README.md',
            'docs/*.md',
            'docs/*.mdx',
            'generators/README.md',
            'generators/*/README.md',
          ],
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/openapi-yagen/openapi-yagen/edit/master/',
          breadcrumbs: true,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          changefreq: 'weekly',
          priority: 0.5,
        },
      } satisfies Options,
    ],
  ],

  plugins: [
    [
      '@cmfcmf/docusaurus-search-local',
      {
        indexDocs: true,
        indexBlog: false,
        indexPages: true,
        language: 'en',
        maxSearchResults: 8,
      },
    ],
  ],

  themeConfig: {
    image: 'img/openapi-yagen-social.png',
    metadata: [
      {
        name: 'description',
        content:
          'A compact, extensible OpenAPI code generator powered by JavaScript and Inja templates.',
      },
    ],
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'openapi-yagen',
      hideOnScroll: false,
      logo: {
        alt: 'openapi-yagen logo',
        src: 'img/openapi-yagen.png',
      },
      items: [
        {to: '/docs/overview', label: 'Docs', position: 'left'},
        {to: '/generators', label: 'Generators', position: 'left'},
        {to: '/docs/playground', label: 'Playground', position: 'left'},
        {
          href: 'https://github.com/openapi-yagen/openapi-yagen/releases/latest',
          label: 'Releases',
          position: 'right',
        },
        {
          href: 'https://github.com/openapi-yagen/openapi-yagen',
          label: 'GitHub',
          position: 'right',
          className: 'navbar-github-link',
          'aria-label': 'GitHub repository',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Learn',
          items: [
            {label: 'Overview', to: '/docs/overview'},
            {label: 'Tutorial', to: '/docs/tutorial'},
            {label: 'JavaScript API', to: '/docs/javascript-api'},
            {label: 'Playground', to: '/docs/playground'},
          ],
        },
        {
          title: 'Generators',
          items: [
            {label: 'Generator collection', to: '/generators'},
            {label: 'Generator format', to: '/docs/generator-format'},
            {label: 'Templating', to: '/docs/templating'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'GitHub', href: 'https://github.com/openapi-yagen/openapi-yagen'},
            {
              label: 'Releases',
              href: 'https://github.com/openapi-yagen/openapi-yagen/releases/latest',
            },
          ],
        },
      ],
      copyright: `openapi-yagen documentation`,
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: false,
      },
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
      additionalLanguages: ['bash', 'json', 'yaml', 'kotlin', 'cpp', 'ruby'],
    },
  } satisfies ThemeConfig,
};

export default config;
