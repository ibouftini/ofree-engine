// Turns what the scanner found into TeX Live packages, and into the
// requirement fingerprint that names the cached environment.

import { createHash } from "node:crypto";
import { closure, type Tlpdb } from "../tl/tlpdb.js";
import type { DocumentPlan, Ref } from "./scan.js";

/** Bump when the layout of a cached TeX Live changes incompatibly. */
export const LAYOUT_VERSION = "3";

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
    for (const l of d.locales.keys()) tokens.add(`locale:${l}`);
    for (const f of d.fonts.keys()) tokens.add(`font:${f}`);
    for (const p of d.programs.keys()) tokens.add(`program:${p}`);
  }
  for (const p of extraPackages) tokens.add(`pkg:${p}`);
  return [...tokens].sort();
}

/** Names one project's documents (where they are, not what they need), so its cache entries form one line. */
export function lineage(workingDirectory: string, roots: string[]): string {
  return createHash("sha256").update([workingDirectory, ...[...roots].sort()].join("\n")).digest("hex").slice(0, 10);
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
  // Not in TeX Live; IPAex, which is, stands in (see fonts.ts).
  ipamincho: "ipaex", ipapmincho: "ipaex", ipagothic: "ipaex", ipapgothic: "ipaex",
};

/** Families TeX Live ships under a new name; documents using the old one cannot find them. */
export const RENAMED_FONTS: Record<string, string> = {
  "source sans pro": "Source Sans 3",
  "source serif pro": "Source Serif 4",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The TeX Live package that ships a font, from its family name or file name. */
export function fontPackage(db: Tlpdb, fileIndex: Map<string, string>, font: string): string | undefined {
  const renamed = RENAMED_FONTS[font.toLowerCase()];
  if (renamed) return fontPackage(db, fileIndex, renamed);
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

/** TeX Live's hyphenation patterns for a language; babel locale names may add a variant ("greek-polytonic"). */
export function hyphenationPackage(db: Tlpdb, lang: string): string | undefined {
  for (const name of new Set([lang, lang.split("-")[0]])) {
    const alias = HYPHEN_ALIASES[name] ?? name;
    if (alias && db.packages.has(`hyphen-${alias}`)) return `hyphen-${alias}`;
  }
  return undefined;
}

/** Packages for a babel/polyglossia language: its definition file and its hyphenation patterns. */
export function languagePackages(db: Tlpdb, fileIndex: Map<string, string>, lang: string): string[] {
  const out: string[] = [];
  // Some babel languages use a "b" suffix (russianb.ldf, ukraineb.ldf).
  // polyglossia documents load polyglossia.sty, which ships every gloss-*.ldf,
  // so babel's own package comes first.
  const ldf =
    [`${lang}.ldf`, `${lang}b.ldf`].map((f) => fileIndex.get(f)).find(Boolean) ??
    (db.packages.has(`babel-${lang}`) ? `babel-${lang}` : undefined) ??
    fileIndex.get(`gloss-${lang}.ldf`);
  if (ldf) out.push(ldf);
  const hyphen = hyphenationPackage(db, lang);
  if (hyphen) out.push(hyphen);
  return out;
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
    // Japanese: the engine, the kanji font maps dvipdfmx reads, and the HaranoAji fonts they and LuaTeX-ja name.
    if (d.engine === "platex" || d.engine === "uplatex") {
      for (const p of [d.engine, "ptex-fontmaps", "haranoaji"]) want(p, `${d.engine === "platex" ? "pLaTeX" : "upLaTeX"}: ${d.engineReason}`);
      if (["makeidx.sty", "imakeidx.sty", "index.sty"].some((f) => d.requires.has(f))) want(d.engine === "platex" ? "mendexk" : "upmendex", "index (Japanese)");
    }
    const japaneseLua = [...d.requires.keys()].find((f) => /^(luatexja.*\.sty|ltj\w+\.cls|jlreq\.cls|bxjs\w+\.cls)$/.test(f));
    if (japaneseLua && d.engine !== "platex" && d.engine !== "uplatex") want("haranoaji", `Japanese fonts for ${japaneseLua}`);
    // Programs a .latexmkrc runs; binaries belong to "<package>.<arch>", installed through "<package>".
    for (const [program, ref] of d.programs) {
      const pkg = fileIndex.get(program)?.replace(new RegExp(`\\.${arch.replace(/[.-]/g, "\\$&")}$`), "");
      if (pkg && db.packages.has(pkg)) want(pkg, `${program} (${at(ref)})`);
    }

    for (const [file, ref] of d.requires) {
      let pkg = fileIndex.get(file);
      if (!pkg && file.startsWith("tikzlibrary")) pkg = fileIndex.get(file.replace(/^tikzlibrary/, "pgflibrary"));
      if (pkg) want(pkg, `${file} (${at(ref)})`);
      else unresolved.push({ what: file, ref });
    }

    for (const [lang, ref] of d.languages) {
      for (const pkg of languagePackages(db, fileIndex, lang)) want(pkg, `language ${lang} (${at(ref)})`);
    }
    // babel ships the .ini files itself; many languages have no patterns at all.
    for (const [lang, ref] of d.locales) {
      const pkg = hyphenationPackage(db, lang);
      if (pkg) want(pkg, `language ${lang} (${at(ref)})`);
    }

    for (const [font, ref] of d.fonts) {
      const pkg = fontPackage(db, fileIndex, font);
      if (pkg) want(pkg, `font "${font}" (${at(ref)})`);
      else unresolved.push({ what: `font "${font}"`, ref });
    }
  }

  return { packages: closure(db, arch, roots), reasons, unresolved };
}
