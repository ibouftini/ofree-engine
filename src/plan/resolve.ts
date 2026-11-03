// Turns what the scanner found into TeX Live packages, and into the
// requirement fingerprint that names the cached environment.

import { createHash } from "node:crypto";
import { closure, type Tlpdb } from "../tl/tlpdb.js";
import type { DocumentPlan, Ref } from "./scan.js";

/** Bump when the layout of a cached TeX Live changes incompatibly. */
export const LAYOUT_VERSION = "1";

/** Packages every build gets, whatever the document. */
const BASE = ["scheme-basic", "latexmk"];

/**
 * Stable description of what the documents need. Two runs with the same
 * fingerprint can share one cached TeX Live; nothing here needs the network.
 */
export function requirementTokens(docs: DocumentPlan[], extraPackages: string[] = []): string[] {
  const tokens = new Set<string>();
  for (const d of docs) {
    tokens.add(`engine:${d.engine}`);
    if (d.bibTool) tokens.add(`bib:${d.bibTool}`);
    for (const f of d.requires.keys()) tokens.add(`file:${f}`);
    for (const l of d.languages.keys()) tokens.add(`lang:${l}`);
    for (const f of d.fonts.keys()) tokens.add(`font:${f}`);
  }
  for (const p of extraPackages) tokens.add(`pkg:${p}`);
  return [...tokens].sort();
}

export function fingerprint(tokens: string[]): string {
  return createHash("sha256").update(LAYOUT_VERSION + "\n" + tokens.join("\n")).digest("hex").slice(0, 20);
}

// Babel/polyglossia names that differ from TeX Live's hyphen-* package names.
const HYPHEN_ALIASES: Record<string, string> = {
  ngerman: "german", austrian: "german", naustrian: "german", swissgerman: "german", nswissgerman: "german",
  british: "english", ukenglish: "english", english: "english", american: "",
  brazil: "portuguese", brazilian: "portuguese", portuges: "portuguese", portuguese: "portuguese",
  francais: "french", frenchb: "french", acadian: "french", canadien: "french",
  magyar: "hungarian", farsi: "persian", polutonikogreek: "greek", bahasa: "indonesian",
  serbianc: "serbian", nynorsk: "norwegian", norsk: "norwegian", lowersorbian: "lowersorbian",
};

// Font family names whose files do not follow the family name.
const FONT_ALIASES: Record<string, string> = {
  "latin modern roman": "lm", "latin modern sans": "lm", "latin modern mono": "lm", "latin modern math": "lm-math",
  "new computer modern": "newcomputermodern", "newcomputermodern": "newcomputermodern",
  "new computer modern math": "newcomputermodern", "linux libertine o": "libertine", "linux biolinum o": "libertine",
  "stix two text": "stix2-otf", "stix two math": "stix2-otf", "xits": "xits", "xits math": "xits",
  "tex gyre termes math": "tex-gyre-math", "tex gyre pagella math": "tex-gyre-math",
  "tex gyre bonum math": "tex-gyre-math", "tex gyre schola math": "tex-gyre-math", "tex gyre dejavu math": "tex-gyre-math",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The TeX Live package that ships a font, from its family name or file name. */
export function fontPackage(db: Tlpdb, fileIndex: Map<string, string>, font: string): string | undefined {
  const alias = FONT_ALIASES[font.toLowerCase()];
  if (alias && db.packages.has(alias)) return alias;
  const direct = fileIndex.get(font);
  if (direct) return direct;
  const n = norm(font.replace(/\.(otf|ttf|ttc)$/i, ""));
  if (n.length < 3) return undefined;
  let best: [string, string] | undefined;
  for (const [base, pkg] of fileIndex) {
    if (!/\.(otf|ttf|ttc)$/i.test(base)) continue;
    const stem = norm(base.replace(/\.[^.]+$/, ""));
    if (stem.startsWith(n) && (!best || stem.length < best[0].length)) best = [stem, pkg];
  }
  return best?.[1];
}

export interface Resolution {
  /** Every package to install (closure over `depend`). */
  packages: Set<string>;
  /** Why each directly required package is there, e.g. "hyperref.sty (main.tex:9)". */
  reasons: Map<string, string>;
  /** Files no package provides (local files elsewhere, typos, or fonts outside TeX Live). */
  unresolved: { what: string; ref: Ref }[];
}

export function resolvePackages(
  db: Tlpdb,
  fileIndex: Map<string, string>,
  arch: string,
  docs: DocumentPlan[],
  extraPackages: string[] = [],
): Resolution {
  const roots = new Set<string>(BASE);
  const reasons = new Map<string, string>();
  const unresolved: Resolution["unresolved"] = [];
  const want = (pkg: string, why: string) => {
    roots.add(pkg);
    if (!reasons.has(pkg)) reasons.set(pkg, why);
  };
  const at = (r: Ref) => `${r.file}:${r.line}`;

  for (const p of extraPackages) want(p, "extra_packages input");
  for (const d of docs) {
    if (d.engine === "xelatex") want("xetex", `XeLaTeX: ${d.engineReason}`);
    if (d.bibTool === "biber") want("biber", "biblatex with Biber");
    if (d.bibTool === "bibtex") want("bibtex", "BibTeX");

    for (const [file, ref] of d.requires) {
      let pkg = fileIndex.get(file);
      if (!pkg && file.startsWith("tikzlibrary")) pkg = fileIndex.get(file.replace(/^tikzlibrary/, "pgflibrary"));
      if (pkg) want(pkg, `${file} (${at(ref)})`);
      else unresolved.push({ what: file, ref });
    }

    for (const [lang, ref] of d.languages) {
      const ldf = fileIndex.get(`${lang}.ldf`) ?? fileIndex.get(`gloss-${lang}.ldf`);
      if (ldf) want(ldf, `language ${lang} (${at(ref)})`);
      const alias = HYPHEN_ALIASES[lang] ?? lang;
      if (alias && db.packages.has(`hyphen-${alias}`)) want(`hyphen-${alias}`, `hyphenation for ${lang} (${at(ref)})`);
    }

    for (const [font, ref] of d.fonts) {
      const pkg = fontPackage(db, fileIndex, font);
      if (pkg) want(pkg, `font "${font}" (${at(ref)})`);
      else unresolved.push({ what: `font "${font}"`, ref });
    }
  }

  return { packages: closure(db, arch, roots), reasons, unresolved };
}
