import type {ReactNode} from 'react';
import {downloadTextFile} from './download';
import type {LogEntry, LogLevel} from './protocol';
import styles from './styles.module.css';

const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

function formatLogs(logs: readonly LogEntry[]): string {
  return logs.map((l) => `[${l.level}] ${l.name} - ${l.message}`).join('\n');
}

interface Props {
  logs: LogEntry[];
  level: LogLevel;
  onLevelChange: (level: LogLevel) => void;
  downloadName: string;
}

// Collapsed by default (a native <details>, same disclosure pattern as InfoPopover) so the log
// output doesn't push the actual result out of view - see docs/playground.mdx and
// wasm/bridge.cpp's MemoryLoggerBackend for where these entries come from.
export default function LogPanel({logs, level, onLevelChange, downloadName}: Props): ReactNode {
  return (
    <details className={styles.logPanel}>
      <summary className={styles.logSummary}>Logs{logs.length > 0 ? ` (${logs.length})` : ''}</summary>
      <div className={styles.logControls}>
        <label className={styles.logLevelLabel}>
          Level
          <select
            className={styles.select}
            value={level}
            onChange={(e) => onLevelChange(e.target.value as LogLevel)}>
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={logs.length === 0}
          onClick={() => downloadTextFile(formatLogs(logs), downloadName)}>
          Download log
        </button>
      </div>
      <pre className={styles.logBody}>{logs.length === 0 ? 'No log output yet.' : formatLogs(logs)}</pre>
    </details>
  );
}
