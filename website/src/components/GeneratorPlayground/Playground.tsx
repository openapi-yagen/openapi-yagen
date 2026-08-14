import type {ReactNode} from 'react';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import {useYagenWorker} from './useYagenWorker';
import GenerateTab from './GenerateTab';
import ConvertTab from './ConvertTab';
import styles from './styles.module.css';

// The client-only implementation - loaded via BrowserOnly from index.tsx, since it uses browser
// APIs (Worker, import.meta.url worker resolution) that don't exist during Docusaurus's SSR build.
export default function Playground(): ReactNode {
  const {request, cancel} = useYagenWorker();

  return (
    <div className={styles.playground}>
      <Tabs groupId="playground-mode">
        <TabItem value="generate" label="Generate" default>
          <div className={styles.tabsPanel}>
            <GenerateTab request={request} cancel={cancel} />
          </div>
        </TabItem>
        <TabItem value="convert" label="Convert">
          <div className={styles.tabsPanel}>
            <ConvertTab request={request} cancel={cancel} />
          </div>
        </TabItem>
      </Tabs>
    </div>
  );
}
