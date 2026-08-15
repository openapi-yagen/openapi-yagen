import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Get started',
      collapsed: false,
      items: ['README', 'docs/tutorial', 'docs/playground'],
    },
    {
      type: 'category',
      label: 'Build a generator',
      collapsed: false,
      items: [
        'docs/README',
        'docs/generator-format',
        'docs/javascript-api',
        'docs/templating',
      ],
    },
    {
      type: 'category',
      label: 'Generator collection',
      collapsed: false,
      items: [
        'generators/README',
        'generators/typescript_fetch_client_generator/README',
        'generators/kotlin_ktor_client_generator/README',
        'generators/kotlin_ktor_server_generator/README',
        'generators/ruby_faraday_client_generator/README',
        'generators/sample_cpp_models_generator/README',
      ],
    },
  ],
};

export default sidebars;
