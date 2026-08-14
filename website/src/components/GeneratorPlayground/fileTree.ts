import type {GeneratedFile} from './protocol';

export interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  children?: TreeNode[];
  file?: GeneratedFile;
}

// Groups a flat {path, content}[] (as returned by generate) into a directory tree for the file
// browser - generator output paths always use '/' (see MemoryFileWriter/OpenApiGenerator, which
// never touch a real OS path separator).
export function buildFileTree(files: readonly GeneratedFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let level = root;
    let pathSoFar = '';
    parts.forEach((part, i) => {
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      const isFile = i === parts.length - 1;
      let node = level.find((n) => n.name === part && n.isFile === isFile);
      if (!node) {
        node = {name: part, path: pathSoFar, isFile, children: isFile ? undefined : [], file: isFile ? file : undefined};
        level.push(node);
      }
      if (!isFile) level = node.children!;
    });
  }
  sortTree(root);
  return root;
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => (a.isFile !== b.isFile ? (a.isFile ? 1 : -1) : a.name.localeCompare(b.name)));
  for (const node of nodes) if (node.children) sortTree(node.children);
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  kt: 'kotlin',
  kts: 'kotlin',
  ts: 'typescript',
  tsx: 'tsx',
  rb: 'ruby',
  java: 'java',
  py: 'python',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  xml: 'xml',
  js: 'javascript',
  gradle: 'groovy',
  toml: 'toml',
};

export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? 'text';
}
