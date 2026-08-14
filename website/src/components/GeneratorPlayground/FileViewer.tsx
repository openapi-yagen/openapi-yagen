import {useEffect, useMemo, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import CodeBlock from '@theme/CodeBlock';
import {buildFileTree, languageForPath, type TreeNode} from './fileTree';
import {downloadFilesAsZip} from './download';
import type {GeneratedFile} from './protocol';
import styles from './styles.module.css';

function TreeNodes({
  nodes,
  selectedPath,
  onSelect,
}: {
  nodes: TreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}): ReactNode {
  return (
    <ul>
      {nodes.map((node) => (
        <li key={node.path}>
          {node.isFile ? (
            <button
              type="button"
              className={clsx(styles.treeFile, node.path === selectedPath && styles.treeFileSelected)}
              onClick={() => onSelect(node.path)}>
              {node.name}
            </button>
          ) : (
            <>
              <div className={styles.treeDir}>{node.name}/</div>
              <TreeNodes nodes={node.children ?? []} selectedPath={selectedPath} onSelect={onSelect} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function FileViewer({
  files,
  downloadName,
}: {
  files: readonly GeneratedFile[];
  downloadName: string;
}): ReactNode {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [selectedPath, setSelectedPath] = useState<string | null>(files[0]?.path ?? null);

  useEffect(() => {
    if (!files.some((f) => f.path === selectedPath)) setSelectedPath(files[0]?.path ?? null);
    // Only re-run when the file list itself changes, not on every selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const selectedFile = files.find((f) => f.path === selectedPath);

  return (
    <div className={styles.viewer}>
      <div className={styles.viewerHeader}>
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} generated
        </span>
        <button type="button" className={styles.secondaryButton} onClick={() => downloadFilesAsZip(files, downloadName)}>
          Download .zip
        </button>
      </div>
      <div className={styles.viewerBody}>
        <div className={styles.tree}>
          <TreeNodes nodes={tree} selectedPath={selectedPath} onSelect={setSelectedPath} />
        </div>
        <div className={styles.fileContent}>
          {selectedFile ? (
            <CodeBlock language={languageForPath(selectedFile.path)} title={selectedFile.path}>
              {selectedFile.content}
            </CodeBlock>
          ) : (
            <p className={styles.hint}>No file selected.</p>
          )}
        </div>
      </div>
    </div>
  );
}
