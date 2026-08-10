import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import CodeBlock from '@theme/CodeBlock';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './index.module.css';

const installCommand = `curl -L https://github.com/openapi-yagen/openapi-yagen/releases/latest/download/openapi-yagen \\
  -o openapi-yagen && chmod +x openapi-yagen`;

const kotlinCommand = `curl -LO https://raw.githubusercontent.com/openapi-yagen/openapi-yagen/master/test/resources/petstore.yaml

openapi-yagen generate petstore.yaml \\
  -g https://raw.githubusercontent.com/openapi-yagen/openapi-yagen/master/generators/kotlin_ktor_client_generator/src \\
  -o generated \\
  -v packageName=com.example.petstore`;

const kotlinUsage = `val client = HttpClient(CIO) { install(ContentNegotiation) { json() } }
val petsApi = PetsApi(client, baseUrl = "https://petstore.example.com/v1")
val pets = petsApi.listPets(limit = 20)`;

const heroSteps = [
  {
    label: 'Install the CLI',
    language: 'bash',
    code: installCommand,
    docHref: '/docs/overview#installation',
    docLabel: 'Details',
  },
  {
    label: 'Generate a Kotlin Ktor client',
    language: 'bash',
    code: kotlinCommand,
    docHref: '/docs/generator-format#loading-a-generator',
    docLabel: 'Details',
  },
  {
    label: 'Use the generated client',
    language: 'kotlin',
    code: kotlinUsage,
    docHref: '/generators/kotlin-ktor-client#integrating-the-generated-code',
    docLabel: 'Details',
  },
];

function IconEngine(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M12 2 3 7v10l9 5 9-5V7z" />
      <path d="M3 7l9 5 9-5" />
      <path d="M12 12v10" />
    </svg>
  );
}

function IconTemplate(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="m9 8-4 4 4 4" />
      <path d="m15 8 4 4-4 4" />
    </svg>
  );
}

function IconConvert(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M4 7h13l-3-3" />
      <path d="M20 17H7l3 3" />
    </svg>
  );
}

function IconSource(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function IconLayers(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}

function IconTool(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2Z" />
    </svg>
  );
}

const features = [
  {
    title: 'Small standalone engine',
    text: 'The generator core is distributed as a small statically linked binary. JavaScript support is built in, so Node.js, Java, and other language runtimes are not required.',
    Icon: IconEngine,
  },
  {
    title: 'JavaScript and Jinja-like templates',
    text: 'Generators use modern JavaScript for logic and familiar Jinja-like templates for output, making them straightforward to write and customize.',
    Icon: IconTemplate,
  },
  {
    title: 'Built-in OpenAPI version conversion',
    text: 'The engine converts between OpenAPI 2.0, 3.0, 3.1, and 3.2. A generator targets one 3.x version; when the engine adds another input version, existing generators keep their declared data shape.',
    Icon: IconConvert,
  },
  {
    title: 'Local or remote generators',
    text: 'Keep a generator with your project sources, package it as a ZIP, or load it directly from an HTTP or GitHub URL.',
    Icon: IconSource,
  },
  {
    title: 'Selective file overrides',
    text: 'Replace only the generator files you need to adjust without copying or maintaining a complete fork.',
    Icon: IconLayers,
  },
  {
    title: 'Output post-processing',
    text: 'Run custom tools such as formatters, linters, or checkers on generated files as part of the same command.',
    Icon: IconTool,
  },
];

const generators = [
  {
    language: 'TypeScript',
    title: 'Fetch client',
    text: 'Browser-first API client with no third-party runtime dependencies.',
    to: '/generators/typescript-fetch-client',
  },
  {
    language: 'Kotlin Multiplatform',
    title: 'Ktor client',
    text: 'API clients using a caller-supplied Ktor HttpClient.',
    to: '/generators/kotlin-ktor-client',
  },
  {
    language: 'Kotlin Multiplatform',
    title: 'Ktor server',
    text: 'Validated routes and handler interfaces for Ktor servers.',
    to: '/generators/kotlin-ktor-server',
  },
  {
    language: 'C++',
    title: 'Models example',
    text: 'A small example generator for C++ model structs.',
    to: '/generators/sample-cpp-models',
  },
];

function Arrow(): ReactNode {
  return <span aria-hidden="true">→</span>;
}

function Hero(): ReactNode {
  const logo = useBaseUrl('/img/openapi-yagen.png');

  return (
    <header className={styles.hero}>
      <div className={`container ${styles.heroGrid}`}>
        <div className={styles.heroCopy}>
          <div className={styles.heroIntro}>
            <img className={styles.heroLogo} src={logo} alt="openapi-yagen" />
            <Heading as="h1">A compact OpenAPI generator engine</Heading>
          </div>
          <p>
            <strong>openapi-yagen</strong> is a small standalone binary. Generators are written in
            JavaScript with Jinja-like templates and do not require a separate language runtime.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryButton} to="/docs/overview">
              Read the documentation
            </Link>
            <Link className={styles.secondaryButton} to="/generators">
              Available generators
            </Link>
          </div>
        </div>

        <div className={styles.quickSteps}>
          {heroSteps.map((step, index) => (
            <div className={styles.stepPanel} key={step.label}>
              <div className={styles.panelHeader}>
                <span>
                  <em className={styles.stepNumber}>{index + 1}</em>
                  {step.label}
                </span>
                <Link to={step.docHref}>
                  {step.docLabel} <Arrow />
                </Link>
              </div>
              <CodeBlock language={step.language}>{step.code}</CodeBlock>
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}

function Home(): ReactNode {
  return (
    <Layout
      title="OpenAPI code generation with JavaScript and templates"
      description="A C++ CLI for generating source code from OpenAPI specifications with JavaScript and Inja templates.">
      <Hero />
      <main>
        <section className={styles.featureSection}>
          <div className="container">
            <Heading as="h2" className={styles.sectionTitle}>
              Main features
            </Heading>
            <div className={styles.featureGrid}>
              {features.map((feature) => (
                <article className={styles.featureItem} key={feature.title}>
                  <div className={styles.featureHead}>
                    <div className={styles.featureIcon}>
                      <feature.Icon />
                    </div>
                    <Heading as="h3">{feature.title}</Heading>
                  </div>
                  <p>{feature.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.gettingStarted}>
          <div className="container">
            <Heading as="h2" className={styles.sectionTitle}>
              Getting started
            </Heading>
            <div className={styles.steps}>
              <article>
                <span>1</span>
                <div>
                  <Heading as="h3">Install the CLI</Heading>
                  <p>Download the statically linked Linux binary from GitHub Releases.</p>
                  <Link to="/docs/overview#installation">Installation</Link>
                </div>
              </article>
              <article>
                <span>2</span>
                <div>
                  <Heading as="h3">Select a generator</Heading>
                  <p>Use one from this repository or provide your own directory or URL.</p>
                  <Link to="/generators">Generator collection</Link>
                </div>
              </article>
              <article>
                <span>3</span>
                <div>
                  <Heading as="h3">Run it against a spec</Heading>
                  <p>Set output options and variables, then integrate the generated files.</p>
                  <Link to="/docs/tutorial">Generator tutorial</Link>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className={styles.generatorsSection}>
          <div className="container">
            <div className={styles.sectionHeader}>
              <Heading as="h2" className={styles.sectionTitle}>
                Available generators
              </Heading>
              <Link to="/generators">Collection overview <Arrow /></Link>
            </div>
            <div className={styles.generatorGrid}>
              {generators.map((generator) => (
                <Link className={styles.generatorItem} to={generator.to} key={generator.title}>
                  <span>{generator.language}</span>
                  <Heading as="h3">{generator.title}</Heading>
                  <p>{generator.text}</p>
                </Link>
              ))}
            </div>
            <div className={styles.generatorNote}>
              <p>
                <strong>Don't see your language or framework?</strong> Generators are just
                JavaScript and Inja templates, so you can write your own.
              </p>
              <Link to="/docs/tutorial">
                Tutorial: writing a generator from scratch <Arrow />
              </Link>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}

export default Home;
