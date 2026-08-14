import type {ReactNode} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';

// Entry point rendered by docs/playground.mdx. Wrapped in BrowserOnly (this codebase's first use
// of it) because Playground.tsx and everything it pulls in (the wasm-backed Web Worker) touches
// browser-only APIs that don't exist during Docusaurus's Node-based SSR build.
export default function GeneratorPlayground(): ReactNode {
  return (
    <BrowserOnly fallback={<div>Loading playground…</div>}>
      {() => {
        const Playground = require('./Playground').default;
        return <Playground />;
      }}
    </BrowserOnly>
  );
}
