import {useState, type ChangeEvent, type FormEvent, type ReactNode} from 'react';
import CodeBlock from '@theme/CodeBlock';
import {downloadTextFile} from './download';
import LogPanel from './LogPanel';
import type {ConvertResult, LogEntry, LogLevel} from './protocol';
import styles from './styles.module.css';

const SAMPLE_SPEC_2_0 = `swagger: '2.0'
info:
  title: Sample Pet Store
  version: 1.0.0
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: A list of pets
          schema:
            type: array
            items:
              $ref: '#/definitions/Pet'
definitions:
  Pet:
    type: object
    required: [id, name]
    properties:
      id:
        type: integer
      name:
        type: string
`;

const VERSIONS = ['2.0', '3.0', '3.1', '3.2'];

interface Props {
  request: <T>(req: Record<string, unknown>) => Promise<T>;
  cancel: () => void;
}

export default function ConvertTab({request, cancel}: Props): ReactNode {
  const [specText, setSpecText] = useState(SAMPLE_SPEC_2_0);
  const [fromVersion, setFromVersion] = useState('');
  const [toVersion, setToVersion] = useState('3.1');
  const [format, setFormat] = useState<'yaml' | 'json'>('yaml');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logLevel, setLogLevel] = useState<LogLevel>('info');

  async function onConvert() {
    setLoading(true);
    setError(null);
    setResult(null);
    setLogs([]);
    try {
      const res = await request<ConvertResult>({type: 'convert', spec: specText, fromVersion, toVersion, format, logLevel});
      setLogs(res.logs);
      if (res.ok) setResult(res);
      else setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function onCancel() {
    cancel();
    setLoading(false);
    setError('Cancelled.');
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onConvert();
  }

  async function onSpecFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setSpecText(await file.text());
  }

  return (
    <form onSubmit={onSubmit}>
      <div className={styles.field}>
        <label htmlFor="convert-spec">OpenAPI/Swagger spec (YAML or JSON)</label>
        <textarea
          id="convert-spec"
          className={styles.textarea}
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          spellCheck={false}
        />
        <p className={styles.hint}>
          or <input type="file" accept=".yaml,.yml,.json" onChange={onSpecFileSelected} />
        </p>
      </div>

      <div className={styles.varsGrid}>
        <div className={styles.field}>
          <label htmlFor="convert-from">From version</label>
          <select id="convert-from" className={styles.select} value={fromVersion} onChange={(e) => setFromVersion(e.target.value)}>
            <option value="">Auto-detect</option>
            {VERSIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="convert-to">To version</label>
          <select id="convert-to" className={styles.select} value={toVersion} onChange={(e) => setToVersion(e.target.value)}>
            {VERSIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="convert-format">Output format</label>
          <select id="convert-format" className={styles.select} value={format} onChange={(e) => setFormat(e.target.value as 'yaml' | 'json')}>
            <option value="yaml">YAML</option>
            <option value="json">JSON</option>
          </select>
        </div>
      </div>

      <div className={styles.actionsRow}>
        <button type="submit" className={styles.primaryButton} disabled={loading}>
          {loading ? 'Converting…' : 'Convert'}
        </button>
        {loading && (
          <button type="button" className={styles.secondaryButton} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {result?.ok && (
        <div className={styles.viewer}>
          <div className={styles.viewerHeader}>
            <span>Converted spec</span>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => downloadTextFile(result.text, `openapi.${format}`)}>
              Download
            </button>
          </div>
          <CodeBlock language={format} title={`openapi.${format}`}>
            {result.text}
          </CodeBlock>
        </div>
      )}

      <LogPanel logs={logs} level={logLevel} onLevelChange={setLogLevel} downloadName="convert.log" />
    </form>
  );
}
