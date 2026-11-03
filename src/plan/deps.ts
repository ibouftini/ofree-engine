// Files a TeX Live package's own sources load. TeX Live's `depend` lines
// rarely list LaTeX-level dependencies (tcolorbox -> tikzfill.image -> pdfcol),
// so after installing a package the engine reads its files and installs what
// they need, instead of discovering one missing file per compile.

import { stripComments } from "./scan.js";

const splitNames = (list: string) =>
  list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9@_.-]+$/.test(s));

/** File names (with extension) that a .sty/.cls/.def/.code.tex file loads. */
export function filesLoadedBy(source: string): string[] {
  const text = stripComments(source);
  const out = new Set<string>();
  for (const m of text.matchAll(/\\(?:usepackage|RequirePackage|RequirePackageWithOptions)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const n of splitNames(m[1])) out.add(`${n}.sty`);
  }
  for (const m of text.matchAll(/\\(?:LoadClass|LoadClassWithOptions)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const n of splitNames(m[1])) out.add(`${n}.cls`);
  }
  for (const m of text.matchAll(/\\usetikzlibrary\s*\{([^}]*)\}/g)) {
    for (const n of splitNames(m[1].replace(/\s+/g, ""))) out.add(`tikzlibrary${n}.code.tex`);
  }
  return [...out];
}
