import {useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode} from 'react';
import FileViewer from './FileViewer';
import InfoPopover from './InfoPopover';
import LogPanel from './LogPanel';
import type {BuiltinGeneratorSummary, GenerateResult, GeneratorInfo, GeneratorSource, LogEntry, LogLevel} from './protocol';
import styles from './styles.module.css';

const SAMPLE_SPEC = `openapi: 3.0.3
info:
  title: Sample Pet Store
  version: 1.0.0
paths:
  /pets:
    get:
      operationId: listPets
      summary: List pets
      responses:
        '200':
          description: A list of pets
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Pet'
components:
  schemas:
    Pet:
      type: object
      required: [id, name]
      properties:
        id:
          type: integer
        name:
          type: string
          minLength: 1
        tag:
          type: string
`;

async function readFileAsText(file: File): Promise<string> {
  return file.text();
}

async function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

interface Props {
  request: <T>(req: Record<string, unknown>) => Promise<T>;
  cancel: () => void;
}

export default function GenerateTab({request, cancel}: Props): ReactNode {
  const [specText, setSpecText] = useState(SAMPLE_SPEC);
  const [sourceKind, setSourceKind] = useState<'builtin' | 'zip'>('builtin');
  const [builtins, setBuiltins] = useState<BuiltinGeneratorSummary[] | null>(null);
  const [builtinName, setBuiltinName] = useState<string>('');
  const [zip, setZip] = useState<{name: string; bytes: Uint8Array} | null>(null);
  const [info, setInfo] = useState<GeneratorInfo | null>(null);
  const [varsValues, setVarsValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logLevel, setLogLevel] = useState<LogLevel>('info');

  // Load the built-in generator list once.
  useEffect(() => {
    request<BuiltinGeneratorSummary[]>({type: 'listBuiltinGenerators'})
      .then((list) => {
        setBuiltins(list);
        if (list.length > 0) setBuiltinName(list[0].name);
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const source: GeneratorSource | null =
    sourceKind === 'builtin' ? (builtinName ? {kind: 'builtin', name: builtinName} : null) : zip ? {kind: 'zip', bytes: zip.bytes} : null;

  // Re-fetch the generator's declared variables whenever the selected source changes, and reset
  // the vars form to its defaults.
  useEffect(() => {
    if (!source) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    request<GeneratorInfo>({type: 'getGeneratorInfo', source})
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error);
          setInfo(null);
          return;
        }
        setInfo(result);
        const defaults: Record<string, string> = {};
        for (const v of result.variables) defaults[v.name] = v.defaultValue;
        setVarsValues(defaults);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKind, builtinName, zip]);

  async function onZipSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setZip({name: file.name, bytes: await readFileAsBytes(file)});
  }

  async function onSpecFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setSpecText(await readFileAsText(file));
  }

  async function onGenerate() {
    if (!source) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setLogs([]);
    try {
      const vars = Object.entries(varsValues).map(([name, value]) => `${name}=${value}`);
      const res = await request<GenerateResult>({type: 'generate', spec: specText, source, vars, logLevel});
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
    void onGenerate();
  }

  return (
    // A real <form> (not just a styled div with an onClick'd button) so the required-field markers
    // (*) on the vars form actually do something - the browser's own constraint validation blocks
    // submission and focuses the first empty required field, which a plain button's onClick can't
    // do (HTML's `required` attribute only applies at form-submit time).
    <form onSubmit={onSubmit}>
      <div className={styles.field}>
        <label htmlFor="playground-spec">OpenAPI spec (YAML or JSON)</label>
        <textarea
          id="playground-spec"
          className={styles.textarea}
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          spellCheck={false}
        />
        <p className={styles.hint}>
          or <input type="file" accept=".yaml,.yml,.json" onChange={onSpecFileSelected} />
        </p>
      </div>

      <div className={styles.sourceRow}>
        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="generatorSourceKind"
            checked={sourceKind === 'builtin'}
            onChange={() => setSourceKind('builtin')}
          />
          Built-in generator
        </label>
        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="generatorSourceKind"
            checked={sourceKind === 'zip'}
            onChange={() => setSourceKind('zip')}
          />
          Upload generator .zip
        </label>
      </div>

      {sourceKind === 'builtin' ? (
        <div className={styles.field}>
          <div className={styles.labelRow}>
            <label htmlFor="playground-generator">Generator</label>
            <InfoPopover text={builtins?.find((g) => g.name === builtinName)?.description} />
          </div>
          <select id="playground-generator" className={styles.select} value={builtinName} onChange={(e) => setBuiltinName(e.target.value)}>
            {builtins === null && <option>Loading…</option>}
            {builtins?.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className={styles.field}>
          <input type="file" accept=".zip" onChange={onZipSelected} />
          {zip && <p className={styles.hint}>{zip.name}</p>}
        </div>
      )}

      {info && info.variables.length > 0 && (
        <div className={styles.varsGrid}>
          {info.variables.map((v) => (
            <div key={v.name} className={styles.field}>
              <div className={styles.labelRow}>
                <label htmlFor={`var-${v.name}`}>
                  {v.name}
                  {v.required ? ' *' : ''}
                </label>
                <InfoPopover text={v.description} />
              </div>
              <input
                id={`var-${v.name}`}
                className={styles.textInput}
                value={varsValues[v.name] ?? ''}
                required={v.required}
                onChange={(e) => setVarsValues((prev) => ({...prev, [v.name]: e.target.value}))}
              />
            </div>
          ))}
        </div>
      )}

      <div className={styles.actionsRow}>
        <button type="submit" className={styles.primaryButton} disabled={!source || loading}>
          {loading ? 'Generating…' : 'Generate'}
        </button>
        {loading && (
          <button type="button" className={styles.secondaryButton} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {result?.ok && <FileViewer files={result.files} downloadName={`${builtinName || zip?.name || 'generated'}.zip`} />}

      <LogPanel logs={logs} level={logLevel} onLevelChange={setLogLevel} downloadName="generate.log" />
    </form>
  );
}
