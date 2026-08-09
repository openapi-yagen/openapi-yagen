import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import CodeBlock from '@theme/CodeBlock';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './index.module.css';

const kotlinCommand = `openapi-yagen generate openapi.yaml \\
  -g generators/kotlin_ktor_client_generator/src \\
  -o generated \\
  -v packageName=com.example.petstore`;

const kotlinUsage = `val client = HttpClient(CIO) {
    install(ContentNegotiation) { json() }
}

val petsApi = PetsApi(
    client,
    baseUrl = "https://petstore.example.com/v1",
)

val pets = petsApi.listPets(limit = 20)`;

const features = [
  {
    title: 'Small standalone engine',
    text: 'The generator core is distributed as a small statically linked binary. JavaScript support is built in, so Node.js, Java, and other language runtimes are not required.',
  },
  {
    title: 'JavaScript and Jinja-like templates',
    text: 'Generators use modern JavaScript for logic and familiar Jinja-like templates for output, making them straightforward to write and customize.',
  },
  {
    title: 'Built-in OpenAPI version conversion',
    text: 'The engine converts between OpenAPI 2.0, 3.0, 3.1, and 3.2. A generator targets one 3.x version; when the engine adds another input version, existing generators keep their declared data shape.',
  },
  {
    title: 'Local or remote generators',
    text: 'Keep a generator with your project sources, package it as a ZIP, or load it directly from an HTTP or GitHub URL.',
  },
  {
    title: 'Selective file overrides',
    text: 'Replace only the generator files you need to adjust without copying or maintaining a complete fork.',
  },
  {
    title: 'Output post-processing',
    text: 'Run custom tools such as formatters, linters, or checkers on generated files as part of the same command.',
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

        <div className={styles.quickExample}>
          <div className={styles.panelHeader}>
            <span>Generate a Kotlin Ktor client</span>
            <Link to="/generators/kotlin-ktor-client">Details</Link>
          </div>
          <CodeBlock language="bash">{kotlinCommand}</CodeBlock>
          <div className={styles.outputTree}>
            <span>generated/com/example/petstore/</span>
            <code>models/Pet.kt</code>
            <code>apis/PetsApi.kt</code>
            <code>QueryUtils.kt</code>
          </div>
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
                  <Heading as="h3">{feature.title}</Heading>
                  <p>{feature.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.exampleSection}>
          <div className={`container ${styles.exampleGrid}`}>
            <div className={styles.exampleDescription}>
              <span className={styles.label}>Kotlin client example</span>
              <Heading as="h2">Use the generated client with your own Ktor setup</Heading>
              <p>
                The Kotlin generator creates serializable models and one API class per OpenAPI
                tag. It does not choose an HTTP engine or create an <code>HttpClient</code>.
              </p>
              <ul>
                <li>Typed request parameters and response values</li>
                <li>Kotlin Multiplatform-compatible generated sources</li>
                <li>Caller-managed HTTP engine, authentication, and plugins</li>
              </ul>
              <Link className={styles.textLink} to="/generators/kotlin-ktor-client">
                Kotlin generator documentation <Arrow />
              </Link>
            </div>
            <div className={styles.codePanel}>
              <div className={styles.panelHeader}>
                <span>Application code</span>
                <code>Example.kt</code>
              </div>
              <CodeBlock language="kotlin">{kotlinUsage}</CodeBlock>
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
          </div>
        </section>
      </main>
    </Layout>
  );
}

export default Home;
