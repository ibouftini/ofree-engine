// Parser and queries for TeX Live's package database (tlpkg/texlive.tlpdb).
//
// The database is a list of blank-line-separated records. Each record starts
// with "name <pkg>" and has "key value" lines; file lists ("runfiles",
// "binfiles arch=...") are followed by lines that start with a space.

export interface TlPackage {
  name: string;
  category: string;
  revision: number;
  depends: string[];
  /** Run files relative to TEXDIR ("RELOC/" already mapped to "texmf-dist/"). */
  runfiles: string[];
  /** Binary files per architecture, relative to TEXDIR. */
  binfiles: Map<string, string[]>;
  containerSize: number;
  containerChecksum: string;
  executes: string[];
}

export interface Tlpdb {
  packages: Map<string, TlPackage>;
  /** TeX Live release year, from 00texlive.config ("release/2026"). */
  release: number;
}

type FileList = { kind: "run" } | { kind: "bin"; arch: string } | { kind: "skip" } | null;

export function parseTlpdb(text: string): Tlpdb {
  const packages = new Map<string, TlPackage>();
  let release = 0;
  let cur: TlPackage | null = null;
  let list: FileList = null;

  for (const line of text.split("\n")) {
    if (line.length === 0) {
      cur = null;
      list = null;
      continue;
    }
    if (line[0] === " ") {
      if (!cur || !list || list.kind === "skip") continue;
      // File lines may carry " details=..." or " language=..." attributes.
      let path = line.trim().split(" ")[0];
      if (path.startsWith("RELOC/")) path = "texmf-dist/" + path.slice(6);
      if (list.kind === "run") cur.runfiles.push(path);
      else {
        const files = cur.binfiles.get(list.arch) ?? [];
        files.push(path);
        cur.binfiles.set(list.arch, files);
      }
      continue;
    }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (key === "name") {
      cur = {
        name: value,
        category: "",
        revision: 0,
        depends: [],
        runfiles: [],
        binfiles: new Map(),
        containerSize: 0,
        containerChecksum: "",
        executes: [],
      };
      packages.set(value, cur);
      list = null;
      continue;
    }
    if (!cur) continue;
    list = null;
    switch (key) {
      case "category":
        cur.category = value;
        break;
      case "revision":
        cur.revision = Number(value);
        break;
      case "depend":
        cur.depends.push(value);
        if (cur.name === "00texlive.config" && value.startsWith("release/")) {
          release = Number(value.slice(8));
        }
        break;
      case "containersize":
        cur.containerSize = Number(value);
        break;
      case "containerchecksum":
        cur.containerChecksum = value;
        break;
      case "execute":
        cur.executes.push(value);
        break;
      case "runfiles":
        list = { kind: "run" };
        break;
      case "binfiles": {
        const arch = /arch=(\S+)/.exec(value)?.[1] ?? "";
        list = { kind: "bin", arch };
        break;
      }
      case "docfiles":
      case "srcfiles":
        list = { kind: "skip" };
        break;
    }
  }
  return { packages, release };
}

/** All packages reachable from `roots` through `depend` lines (".ARCH" resolved). */
export function closure(db: Tlpdb, arch: string, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop()!.replace(/\.ARCH$/, "." + arch);
    if (seen.has(name)) continue;
    const pkg = db.packages.get(name);
    if (!pkg) continue;
    seen.add(name);
    stack.push(...pkg.depends);
  }
  return seen;
}

/**
 * Maps a file's base name (e.g. "hyperref.sty") to the package that ships it.
 * When several packages ship the same name, the one whose name matches the
 * file stem wins, then the first in database order.
 */
export function buildFileIndex(db: Tlpdb, arch: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const pkg of db.packages.values()) {
    if (pkg.category === "Collection" || pkg.category === "Scheme") continue;
    const files = [...pkg.runfiles, ...(pkg.binfiles.get(arch) ?? [])];
    for (const file of files) {
      const base = file.slice(file.lastIndexOf("/") + 1);
      const owner = index.get(base);
      if (owner === undefined) index.set(base, pkg.name);
      else if (owner !== pkg.name && pkg.name === base.replace(/\.[^.]+$/, "")) index.set(base, pkg.name);
    }
  }
  return index;
}

/** Total compressed size in bytes of the given packages' containers. */
export function containerBytes(db: Tlpdb, names: Iterable<string>): number {
  let total = 0;
  for (const name of names) total += db.packages.get(name)?.containerSize ?? 0;
  return total;
}
