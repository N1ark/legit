// The files of a diff as a directory tree, for jumping between them.

export interface TreeDir {
  kind: 'dir';
  /** Shown name: a folder holding only one folder is merged into it ("src/ui"). */
  name: string;
  /** Full path, which identifies it when collapsed. */
  path: string;
  children: TreeNode[];
}

export interface TreeFile {
  kind: 'file';
  name: string;
  /** Position of the file in the list it was built from. */
  index: number;
}

export type TreeNode = TreeDir | TreeFile;

/** A row of the tree as shown, with collapsed folders' contents left out. */
export type TreeRow = (TreeDir | TreeFile) & { depth: number };

/**
 * The tree of `paths`, in their order: git lists a folder's files together, so the tree reads
 * top to bottom like the diff does.
 */
export function fileTree(paths: string[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [] };
  const dirs = new Map<string, TreeDir>();
  paths.forEach((path, index) => {
    const parts = path.split('/');
    let dir = root;
    for (let k = 0; k < parts.length - 1; k++) {
      const sub = parts.slice(0, k + 1).join('/');
      let next = dirs.get(sub);
      if (!next) {
        next = { kind: 'dir', name: parts[k], path: sub, children: [] };
        dirs.set(sub, next);
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: 'file', name: parts.at(-1)!, index });
  });
  return root.children.map(merge);
}

function merge(node: TreeNode): TreeNode {
  if (node.kind === 'file') return node;
  let dir = node;
  let name = dir.name;
  while (dir.children.length === 1 && dir.children[0].kind === 'dir') {
    dir = dir.children[0];
    name += '/' + dir.name;
  }
  return { ...dir, name, children: dir.children.map(merge) };
}

/** The rows to show, depth first, skipping what's inside collapsed folders. */
export function treeRows(nodes: TreeNode[], collapsed: Record<string, boolean>, depth = 0): TreeRow[] {
  const out: TreeRow[] = [];
  for (const n of nodes) {
    out.push({ ...n, depth });
    if (n.kind === 'dir' && !collapsed[n.path]) out.push(...treeRows(n.children, collapsed, depth + 1));
  }
  return out;
}
