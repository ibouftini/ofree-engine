// Reads a project's LaTeX sources and works out, without compiling anything,
// which documents to build, with which engine, and which files they need.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

/** pLaTeX and upLaTeX (Japanese) write DVI, which dvipdfmx turns into PDF. */
export type Engine = "pdflatex" | "xelatex" | "lualatex" | "platex" | "uplatex";

/** Where something was found, for messages such as "fontspec (main.tex:4)". */
export interface Ref {
  file: string;
  line: number;
}

export interface DocumentPlan {
  /** Root file, relative to the workspace. */
  root: string;
  /** Directory latexmk runs in, relative to the workspace. */
  cwd: string;
  /** Path of the root file as passed to latexmk (relative to cwd). */
  target: string;
  engine: Engine;
  /** Why this engine, e.g. "% !TeX program (main.tex:1)" or "fontspec (main.tex:4)". */
  engineReason: string;
  /** True when a .latexmkrc chooses the engine; latexmk then gets no engine flag. */
  engineFromLatexmkrc: boolean;
  /** Programs a .latexmkrc runs (upbibtex, mendex, ...), installed with the document's packages. */
  programs: Map<string, Ref>;
  /** Files the document needs from TeX Live, keyed by file name. */
  requires: Map<string, Ref>;
  /** Babel or polyglossia language names. */
  languages: Map<string, Ref>;
  /** Languages babel loads from its own .ini files (\babelprovide, provide=*); TeX Live adds only their hyphenation patterns. */
  locales: Map<string, Ref>;
  /** Font names given to fontspec-style commands. */
  fonts: Map<string, Ref>;
  bibTool: "biber" | "bibtex" | null;
  shellEscape: Ref & { reason: string } | null;
  /** An EPS image: converting it needs Ghostscript, whatever the engine. */
  eps: Ref | null;
  /** ctex with fontset=windows, which names Windows fonts (SimSun, SimHei, ...) that Linux does not have. */
  ctexWindows: Ref | null;
  /** Programs outside TeX Live the document runs (gs, inkscape, gnuplot), with why. */
  systemPrograms: Map<string, Ref & { reason: string }>;
  /** False for documents built alongside the main ones (drafts, figures): their failures are warnings. */
  main: boolean;
  /** Every source file read for this document, relative to the workspace. */
  sources: string[];
}

const SKIP_DIRS = new Set([".git", "node_modules", ".github", "_minted", "dist", "build"]);

/** Strips TeX comments (unescaped % to end of line), keeping line structure. */
export function stripComments(text: string): string {
  return text.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, "$1$2");
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function splitNames(list: string): string[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.includes("\\") && !s.includes("#"));
}

export function listTexFiles(workspace: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith("_minted")) walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".tex")) {
        out.push(relative(workspace, full));
      }
    }
  };
  walk(workspace);
  return out.sort();
}

const INCLUDE_RE =
  /\\(?:input|include|subfile|InputIfFileExists|includestandalone|subfileinclude)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const IMPORT_RE = /\\(?:sub)?(?:import|inputfrom|includefrom)\*?\s*\{([^}]*)\}\s*\{([^}]+)\}/g;

function withTex(name: string): string[] {
  const n = name.trim();
  return extname(n) ? [n, n + ".tex"] : [n + ".tex", n];
}

/** Include targets of a file, as candidate paths relative to `base` (absolute). */
function includeTargets(text: string, base: string, fileDir: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(INCLUDE_RE)) {
    for (const cand of withTex(m[1])) out.push(resolve(base, cand), resolve(fileDir, cand));
  }
  for (const m of text.matchAll(IMPORT_RE)) {
    for (const cand of withTex(m[2])) out.push(resolve(base, m[1], cand), resolve(fileDir, m[1], cand));
  }
  return out;
}

/**
 * Root documents: files with \documentclass that no other file includes.
 * Subfiles (\documentclass[..]{subfiles}) and standalone figures that are
 * included elsewhere are therefore not roots.
 */
export function findRoots(workspace: string, files: string[]): string[] {
  const texts = new Map<string, string>();
  for (const f of files) texts.set(f, stripComments(readFileSync(join(workspace, f), "utf8")));
  const included = new Set<string>();
  for (const [f, text] of texts) {
    const fileDir = dirname(join(workspace, f));
    // Includes may be relative to the file's own directory or any ancestor.
    let base = fileDir;
    const bases: string[] = [];
    while (base.startsWith(workspace)) {
      bases.push(base);
      if (base === workspace) break;
      base = dirname(base);
    }
    for (const b of bases) {
      for (const t of includeTargets(text, b, fileDir)) included.add(relative(workspace, t));
    }
  }
  return files.filter((f) => /\\documentclass\s*[[{]/.test(texts.get(f)!) && !included.has(f));
}

const ROOT_DIRECTIVE = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im;

export interface Roots {
  /** Documents that decide whether the build passes. */
  main: string[];
  /** Other documents, built too; their failures are warnings. */
  others: string[];
  /** How the main documents were chosen, for the log and the summary. */
  reason: string;
}

/**
 * Splits the candidate documents (findRoots) into main documents and others,
 * the way editors find a project's main file:
 *   - parts are not documents: a file whose "% !TeX root" names another file,
 *     or a \documentclass{subfiles} part;
 *   - the main documents are the targets of "% !TeX root" comments, else the
 *     files a .latexmkrc lists in @default_files, else main.tex, else the only
 *     document left once standalone figures are set aside;
 *   - with no such sign, every document is a main one: guessing could let a
 *     broken main document pass as a draft.
 */
export function chooseMain(workspace: string, files: string[], candidates: string[]): Roots {
  const head = (f: string) => readFileSync(join(workspace, f), "utf8").split("\n").slice(0, 30).join("\n");
  const rootTargets = new Set<string>();
  const parts = new Set<string>();
  for (const f of files) {
    const m = ROOT_DIRECTIVE.exec(head(f));
    if (!m) continue;
    const target = relative(workspace, resolve(workspace, dirname(f), withTex(m[1])[0]));
    if (target !== f) {
      rootTargets.add(target);
      parts.add(f);
    }
  }
  const isSubfile = (f: string) => /\\documentclass\s*(?:\[[^\]]*\])?\s*\{subfiles\}/.test(stripComments(head(f)));
  const docs = candidates.filter((f) => !parts.has(f) && !isSubfile(f));
  const pool = docs.length ? docs : candidates;
  const pick = (main: string[], reason: string): Roots => ({ main, others: pool.filter((f) => !main.includes(f)), reason });

  const targeted = pool.filter((f) => rootTargets.has(f));
  if (targeted.length) return pick(targeted, "named by % !TeX root");
  const defaults = new Set<string>();
  for (const dir of new Set(["", ...pool.map((f) => dirname(f))])) {
    for (const name of [".latexmkrc", "latexmkrc"]) {
      const rc = join(workspace, dir, name);
      if (!existsSync(rc)) continue;
      const m = /@default_files\s*=\s*\(([^)]*)\)/.exec(readFileSync(rc, "utf8").replace(/(^|\s)#.*$/gm, "$1"));
      for (const q of m?.[1].matchAll(/['"]([^'"*?]+)['"]/g) ?? []) defaults.add(relative(workspace, resolve(workspace, dir, withTex(q[1])[0])));
    }
  }
  const listed = pool.filter((f) => defaults.has(f));
  if (listed.length) return pick(listed, "listed in .latexmkrc @default_files");
  const named = pool.filter((f) => basename(f) === "main.tex");
  if (named.length) return pick(named, "named main.tex");
  const isFigure = (f: string) => /\\documentclass\s*(?:\[[^\]]*\])?\s*\{standalone\}/.test(stripComments(head(f)));
  const documents = pool.filter((f) => !isFigure(f));
  if (documents.length === 1) return pick(documents, pool.length > 1 ? "the only document that is not a standalone figure" : "the only document");
  return { main: pool, others: [], reason: pool.length > 1 ? "no main document is marked, so all count" : "the only document" };
}

const ENGINE_DIRECTIVE = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)/im;

function engineFromName(name: string): Engine | null {
  const n = name.toLowerCase();
  if (n.includes("uplatex") || n === "uptex") return "uplatex";
  if (n.includes("platex") || n === "ptex") return "platex";
  if (n.includes("xelatex") || n === "xetex") return "xelatex";
  if (n.includes("lualatex") || n === "luatex" || n === "luahblatex") return "lualatex";
  if (n.includes("pdflatex") || n === "pdftex" || n === "latex") return "pdflatex";
  return null;
}

export interface Latexmkrc {
  /** The engine it chooses, if any. */
  engine: Engine | null;
  /** Programs each of its commands runs ($bibtex = 'upbibtex %O %S' -> bibtex: [upbibtex]). */
  programs: Map<string, string[]>;
  file: string;
}

/**
 * Reads a .latexmkrc in `dir`. $pdf_mode chooses the route: 1 pdfLaTeX,
 * 4 LuaLaTeX, 5 XeLaTeX, 3 (DVI, then dvipdfmx) or 2 (PostScript) with the
 * engine named in $latex, which is how Japanese projects use pLaTeX and upLaTeX.
 */
export function readLatexmkrc(dir: string): Latexmkrc | null {
  for (const name of [".latexmkrc", "latexmkrc"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").replace(/(^|\s)#.*$/gm, "$1");
    const commands = new Map<string, string>();
    for (const m of text.matchAll(/\$(latex|pdflatex|lualatex|xelatex|bibtex|biber|makeindex|dvipdf|dvips|ps2pdf)\s*=\s*(['"])(.*?)\2/g)) commands.set(m[1], m[3]);
    // Every command word: "uplatex -synctex=1 %O %S", or several joined by ; | &&.
    const words = (c: string) => c.split(/[;|&]+/).map((part) => /^\s*([\w.-]+)/.exec(part)?.[1]).filter((w): w is string => !!w);
    const programs = new Map([...commands].map(([role, c]) => [role, words(c)]));
    const mode = /\$pdf_mode\s*=\s*(\d)/.exec(text)?.[1];
    const dviEngine = (): Engine | null => {
      const latex = commands.get("latex")?.split(/[;|&]+/).map((p) => /^\s*([\w.-]+)/.exec(p)?.[1] ?? "").find((w) => /latex$|tex$/.test(w));
      return latex ? (engineFromName(latex) ?? "pdflatex") : "pdflatex";
    };
    let engine: Engine | null = null;
    if (mode === "4") engine = "lualatex";
    else if (mode === "5") engine = "xelatex";
    else if (mode === "1") engine = "pdflatex";
    else if (mode === "2" || mode === "3") engine = dviEngine();
    else if (/^\s*xelatex/.test(commands.get("pdflatex") ?? "")) engine = "xelatex";
    else if (/^\s*lualatex/.test(commands.get("pdflatex") ?? "")) engine = "lualatex";
    else if (/^\s*u?platex/.test(commands.get("latex") ?? "")) engine = dviEngine();
    return { engine, programs, file: name };
  }
  return null;
}

/** Engine chosen by a .latexmkrc in `dir`, if any. */
export function latexmkrcEngine(dir: string): Engine | null {
  return readLatexmkrc(dir)?.engine ?? null;
}

/**
 * The engine a Japanese class asks for: upLaTeX for ujarticle and friends or
 * an [uplatex] option, pLaTeX for jarticle and jsarticle, LuaLaTeX for jlreq
 * without an engine option (its recommended engine).
 */
export function japaneseEngine(cls: string, options: string[]): Engine | null {
  const opt = (o: string) => options.includes(o);
  const named = (["uplatex", "platex", "lualatex", "xelatex", "pdflatex"] as const).find(opt);
  if (/^u[jt](article|book|report)$/.test(cls)) return "uplatex";
  if (/^(js(article|book|report)|bxjs\w+|jlreq|tlreq)$/.test(cls) && named) return named;
  // bxjs classes work with every engine (autodetect-engine); XeLaTeX is the quickest Unicode one.
  if (/^bxjs\w+$/.test(cls)) return "xelatex";
  if (/^([jt]|js)(article|book|report)$/.test(cls)) return "platex";
  if (/^(jlreq|tlreq)$/.test(cls)) return "lualatex";
  return null;
}

// Packages and commands that decide the engine when nothing says so explicitly.
const LUA_SIGNALS = ["luacode", "luatexja", "luatexja-fontspec", "luatexja-preset", "luamplib", "lua-visual-debug", "luaotfload", "tikz-feynman", "emoji", "lua-ul", "pyluatex", "ltjsarticle", "ltjsbook", "ltjsreport", "ltjarticle", "ltjbook"];
const XE_SIGNALS = ["fontspec", "polyglossia", "unicode-math", "xunicode", "xltxtra", "xeCJK", "xepersian", "bidi", "mathspec", "arabxetex", "xgreek", "ctex", "ctexart", "ctexbook", "ctexrep", "ctexbeamer", "fontawesome5-xe"];

interface Accumulator {
  requires: Map<string, Ref>;
  languages: Map<string, Ref>;
  locales: Map<string, Ref>;
  fonts: Map<string, Ref>;
  packages: Map<string, Ref>;
  directive: { engine: Engine; ref: Ref } | null;
  /** Classes loaded (the document's and those local classes load), with their options. */
  classes: { name: string; options: string[]; ref: Ref }[];
  /** Something only LuaTeX runs: Lua code, or a babel feature implemented in Lua. */
  luaFeature: { reason: string; ref: Ref } | null;
  /** babel's bidi= option. */
  babelBidi: { mode: string; ref: Ref } | null;
  babelFont: Ref | null;
  biblatex: { backend: string; ref: Ref } | null;
  bibtex: Ref | null;
  shellEscape: (Ref & { reason: string }) | null;
  hasEps: Ref | null;
  systemPrograms: Map<string, Ref & { reason: string }>;
  ctexWindows: Ref | null;
  /** Folders from \graphicspath, relative to the compile directory. */
  graphicsPaths: string[];
  /** Font encodings that use cm-super with Computer Modern (t1, t2a, ...). */
  encodings: Map<string, Ref>;
  sources: string[];
  visited: Set<string>;
}

// Font packages that replace Computer Modern, so cm-super is not needed for them.
const CM_REPLACEMENTS = new Set([
  "lmodern", "times", "mathptmx", "newtxtext", "newpxtext", "libertine", "libertinus", "palatino", "mathpazo",
  "tgtermes", "tgpagella", "tgheros", "tgschola", "tgbonum", "charter", "XCharter", "fourier", "kpfonts", "ebgaramond",
  "garamondx", "baskervillef", "stix", "stix2", "utopia", "erewhon", "helvet", "avant", "bookman", "newcent", "fontspec",
]);

function addOnce(map: Map<string, Ref>, key: string, ref: Ref) {
  if (!map.has(key)) map.set(key, ref);
}

/** Packages that run a program TeX Live does not ship (installed from the system's packages). */
const SYSTEM_PROGRAM_PACKAGES: Record<string, [string, string]> = {
  svg: ["inkscape", "the svg package converts SVG files with Inkscape"],
  gnuplottex: ["gnuplot", "gnuplottex runs gnuplot"],
  asymptote: ["gs", "Asymptote converts its figures with Ghostscript"],
  "auto-pst-pdf": ["gs", "auto-pst-pdf converts PostScript with Ghostscript"],
};

const SHELL_ESCAPE_PACKAGES: Record<string, string> = {
  minted: "minted runs Python to highlight code",
  svg: "svg runs Inkscape to convert SVG files",
  gnuplottex: "gnuplottex runs gnuplot",
  "auto-pst-pdf": "auto-pst-pdf runs latex and dvips",
  pythontex: "pythontex runs Python",
  sagetex: "sagetex runs Sage",
  "epstopdf-base": "",
};

// biblatex style options name .bbx/.cbx files.
const BIBLATEX_STANDARD_STYLES = new Set([
  "numeric", "numeric-comp", "numeric-verb", "alphabetic", "alphabetic-verb", "authoryear", "authoryear-comp",
  "authoryear-ibid", "authoryear-icomp", "authortitle", "authortitle-comp", "authortitle-ibid", "authortitle-icomp",
  "authortitle-terse", "authortitle-tcomp", "authortitle-ticomp", "verbose", "verbose-ibid", "verbose-note",
  "verbose-inote", "verbose-trad1", "verbose-trad2", "verbose-trad3", "reading", "draft", "debug", "standard",
]);

function scanText(
  acc: Accumulator,
  workspace: string,
  cwdAbs: string,
  fileRel: string,
  raw: string,
  isLocalPackage: boolean,
) {
  const directive = ENGINE_DIRECTIVE.exec(raw.split("\n").slice(0, 30).join("\n"));
  if (directive && !acc.directive && !isLocalPackage) {
    const engine = engineFromName(directive[1]);
    if (engine) acc.directive = { engine, ref: { file: fileRel, line: lineOf(raw, directive.index) } };
  }
  const text = stripComments(raw);
  const ref = (index: number): Ref => ({ file: fileRel, line: lineOf(text, index) });

  const pkgRe = /\\(?:usepackage|RequirePackage|RequirePackageWithOptions)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
  for (const m of text.matchAll(pkgRe)) {
    const options = m[1] ?? "";
    for (const name of splitNames(m[2])) {
      const r = ref(m.index!);
      addOnce(acc.packages, name, r);
      addOnce(acc.requires, name + ".sty", r);
      if (name === "babel") {
        const opts = splitNames(options);
        const langs = opts.map((o) => (o.startsWith("main=") ? o.slice(5) : o)).filter((l) => /^[A-Za-z]+$/.test(l)).map((l) => l.toLowerCase());
        const main = (opts.find((o) => o.startsWith("main="))?.slice(5) ?? langs.at(-1))?.toLowerCase();
        // provide=* (main language), provide+=* (the others), provide*=* (all) load languages from .ini files.
        const provide = opts.map((o) => /^provide([*+]?)=\*$/.exec(o)?.[1]).find((f) => f !== undefined);
        for (const lang of langs) {
          const ini = provide === "*" || (provide === "" && lang === main) || (provide === "+" && lang !== main);
          addOnce(ini ? acc.locales : acc.languages, lang, r);
        }
      }
      if (name === "biblatex") {
        const backend = /backend\s*=\s*(\w+)/.exec(options)?.[1] ?? "biber";
        if (!acc.biblatex) acc.biblatex = { backend, ref: r };
        for (const sm of options.matchAll(/(?:^|,)\s*(style|bibstyle|citestyle)\s*=\s*([\w-]+)/g)) {
          const style = sm[2];
          if (BIBLATEX_STANDARD_STYLES.has(style)) continue;
          if (sm[1] !== "citestyle") addOnce(acc.requires, style + ".bbx", r);
          if (sm[1] !== "bibstyle") addOnce(acc.requires, style + ".cbx", r);
        }
      }
      if (/^ctex/.test(name) && /\bfontset\s*=\s*windows\b/.test(options)) acc.ctexWindows ??= r;
      if (name === "fontenc") {
        // Each encoding needs its definition file; Computer Modern in T1 or
        // Cyrillic encodings needs cm-super for vector (not bitmap) fonts.
        for (const enc of splitNames(options)) {
          if (!/^[A-Z][A-Z0-9]*$/i.test(enc)) continue;
          const e = enc.toLowerCase();
          if (e !== "ot1" && e !== "t1") addOnce(acc.requires, `${e}enc.def`, r);
          if (/^(t1|ts1|t2a|t2b|t2c|x2)$/.test(e)) acc.encodings.set(e, r);
        }
      }
      if (name in SYSTEM_PROGRAM_PACKAGES) {
        const [program, reason] = SYSTEM_PROGRAM_PACKAGES[name];
        if (!acc.systemPrograms.has(program)) acc.systemPrograms.set(program, { ...r, reason });
      }
      if (name in SHELL_ESCAPE_PACKAGES && SHELL_ESCAPE_PACKAGES[name] && !acc.shellEscape) {
        acc.shellEscape = { ...r, reason: SHELL_ESCAPE_PACKAGES[name] };
      }
    }
  }

  const classRe = /\\(?:documentclass|LoadClass|LoadClassWithOptions)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
  for (const m of text.matchAll(classRe)) {
    const name = m[2].trim();
    if (!name || name.includes("\\")) continue;
    const r = ref(m.index!);
    addOnce(acc.packages, name, r);
    addOnce(acc.requires, name + ".cls", r);
    acc.classes.push({ name, options: splitNames(m[1] ?? "").map((o) => o.toLowerCase()), ref: r });
    if (/^ctex/.test(name) && /\bfontset\s*=\s*windows\b/.test(m[1] ?? "")) acc.ctexWindows ??= r;
    // Global class options are passed to babel as languages; keep plausible ones.
    for (const opt of splitNames(m[1] ?? "")) {
      if (/^[a-z]{4,}$/.test(opt) && !/^(draft|final|twoside|oneside|landscape|portrait|onecolumn|twocolumn|titlepage|notitlepage|openright|openany|fleqn|leqno|handout|aspectratio|compress|serif|sans|journal|conference|letterpaper|legalpaper|executivepaper|english|american|british)$/.test(opt)) {
        // Only counted as languages if babel is loaded; filtered later.
        addOnce(acc.languages, "?" + opt, r);
      } else if (/^(english|american|british)$/.test(opt)) {
        addOnce(acc.languages, "?" + opt, r);
      }
    }
  }

  // Beamer themes are files named beamer[color|font|inner|outer]theme<name>.sty.
  for (const m of text.matchAll(/\\use(color|font|inner|outer)?theme\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    for (const name of splitNames(m[2])) addOnce(acc.requires, `beamer${m[1] ?? ""}theme${name}.sty`, ref(m.index!));
  }
  // glossaries-extra in record mode is built with bib2gls.
  const record = /\\usepackage\s*\[[^\]]*\brecord\b[^\]]*\]\s*\{glossaries-extra\}|\\GlsXtrLoadResources/.exec(text);
  if (record) addOnce(acc.requires, "bib2gls.jar", ref(record.index));
  for (const m of text.matchAll(/\\usetikzlibrary\s*\{([^}]*)\}/g)) {
    for (const lib of splitNames(m[1].replace(/\s+/g, ""))) addOnce(acc.requires, `tikzlibrary${lib}.code.tex`, ref(m.index!));
  }
  // pgfplots libraries are TikZ libraries named "pgfplots.<lib>".
  for (const m of text.matchAll(/\\usepgfplotslibrary\s*\{([^}]*)\}/g)) {
    for (const lib of splitNames(m[1].replace(/\s+/g, ""))) addOnce(acc.requires, `tikzlibrarypgfplots.${lib}.code.tex`, ref(m.index!));
  }
  if (!acc.luaFeature) {
    const lua = /\\(?:usegdlibrary|directlua)\s*\{/.exec(text);
    if (lua) acc.luaFeature = { reason: "Lua code", ref: ref(lua.index) };
  }
  // babel implements these only for LuaTeX; with XeTeX it stops with an error.
  if (!acc.babelBidi) {
    const b = /\bbidi\s*=\s*(default|basic-r|basic|bidi-r|bidi-l|bidi)\b/.exec(text);
    if (b) acc.babelBidi = { mode: b[1], ref: ref(b.index) };
    if (b && b[1].startsWith("basic") && !acc.luaFeature) acc.luaFeature = { reason: `babel bidi=${b[1]}`, ref: ref(b.index) };
  }
  if (!acc.luaFeature) {
    const h = /\\babel(?:pre|post)hyphenation\b/.exec(text);
    if (h) acc.luaFeature = { reason: h[0], ref: ref(h.index) };
  }
  if (!acc.babelFont) {
    const f = /\\babelfont\b/.exec(text);
    if (f) acc.babelFont = ref(f.index);
  }
  for (const m of text.matchAll(/\\bibliographystyle\s*\{([^}]+)\}/g)) {
    const style = m[1].trim();
    if (style && !style.includes("\\")) addOnce(acc.requires, style + ".bst", ref(m.index!));
    if (!acc.bibtex) acc.bibtex = ref(m.index!);
  }
  for (const m of text.matchAll(/\\bibliography\s*\{/g)) {
    if (!acc.bibtex) acc.bibtex = ref(m.index!);
  }
  for (const m of text.matchAll(/\\(?:setdefaultlanguage|setmainlanguage|setotherlanguages?)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    for (const lang of splitNames(m[1])) addOnce(acc.languages, lang.toLowerCase(), ref(m.index!));
  }
  for (const m of text.matchAll(/\\babelprovide\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    for (const lang of splitNames(m[1])) if (/^[A-Za-z-]+$/.test(lang)) addOnce(acc.locales, lang.toLowerCase(), ref(m.index!));
  }
  const fontRes = [
    /\\set(?:CJK)?(?:main|sans|mono|math)font\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
    /\\(?:new|renew|provide|set)font(?:family|face)\s*\{?\\[A-Za-z@]+\}?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
    /\\fontspec\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
    /\\babelfont\s*(?:\[[^\]]*\])?\s*\{[^}]+\}\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
  ];
  for (const re of fontRes) {
    for (const m of text.matchAll(re)) {
      const font = m[1].trim();
      if (font && !font.includes("\\")) addOnce(acc.fonts, font, ref(m.index!));
    }
  }
  if (!acc.shellEscape) {
    const w = /\\(?:immediate\s*)?\\write18\b|\\ShellEscape\b/.exec(text);
    const ext = /\\tikzexternalize\b/.exec(text);
    if (ext && !w) acc.shellEscape = { ...ref(ext.index), reason: "TikZ externalization compiles each picture on its own" };
    if (w) acc.shellEscape = { ...ref(w.index), reason: "the document runs shell commands (\\write18)" };
  }
  // pgfplots plots computed by gnuplot ("\addplot gnuplot {...}", "contour gnuplot") need it and shell escape.
  const gp = /\\addplot3?\+?\s*(?:\[[^\]]*\])?\s*gnuplot\b|\bcontour gnuplot\b|\braw gnuplot\b/.exec(text);
  if (gp) {
    if (!acc.systemPrograms.has("gnuplot")) acc.systemPrograms.set("gnuplot", { ...ref(gp.index), reason: "pgfplots computes this plot with gnuplot" });
    if (!acc.shellEscape) acc.shellEscape = { ...ref(gp.index), reason: "pgfplots runs gnuplot" };
  }
  for (const m of text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/g)) {
    for (const d of m[1].matchAll(/\{([^}]*)\}/g)) acc.graphicsPaths.push(d[1]);
  }
  // EPS images, named with their extension or found as the only file for a name without one.
  for (const m of text.matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    if (acc.hasEps) break;
    const name = m[1].trim();
    const dirs = [cwdAbs, dirname(join(workspace, fileRel)), ...acc.graphicsPaths.map((p) => resolve(cwdAbs, p))];
    const eps = /\.e?ps$/i.test(name) ||
      (!extname(name) && dirs.some((d) => existsSync(join(d, `${name}.eps`)) && !["pdf", "png", "jpg", "jpeg"].some((e) => existsSync(join(d, `${name}.${e}`)))));
    if (eps) acc.hasEps = ref(m.index!);
  }

  // Follow includes (relative to the compile directory, then to the file's directory).
  // An \input that is not a local file is a file from TeX Live (\input chemfig, \input{xy}).
  const fileDir = dirname(join(workspace, fileRel));
  const inputs: { cmd: string; name: string; index: number; candidates: string[] }[] = [];
  for (const m of text.matchAll(INCLUDE_RE)) {
    const name = m[1].trim();
    const cmd = /^\\(\w+)/.exec(m[0])![1];
    inputs.push({ cmd, name, index: m.index!, candidates: withTex(name).flatMap((c) => [resolve(cwdAbs, c), resolve(fileDir, c)]) });
  }
  for (const m of text.matchAll(/\\input\s+([A-Za-z0-9_./-]+)/g)) {
    const name = m[1].replace(/\.$/, "");
    inputs.push({ cmd: "input", name, index: m.index!, candidates: withTex(name).flatMap((c) => [resolve(cwdAbs, c), resolve(fileDir, c)]) });
  }
  for (const m of text.matchAll(IMPORT_RE)) {
    const name = m[2].trim();
    inputs.push({ cmd: "import", name, index: m.index!, candidates: withTex(name).flatMap((c) => [resolve(cwdAbs, m[1], c), resolve(fileDir, m[1], c)]) });
  }
  for (const inc of inputs) {
    const found = inc.candidates.find((c) => existsSync(c) && statSync(c).isFile());
    if (found) {
      const rel = relative(workspace, found);
      if (!rel.startsWith("..") && !acc.visited.has(rel)) visit(acc, workspace, cwdAbs, rel, false);
    } else if ((inc.cmd === "input" || inc.cmd === "InputIfFileExists") && /^[A-Za-z][\w.-]*$/.test(inc.name)) {
      addOnce(acc.requires, extname(inc.name) ? inc.name : `${inc.name}.tex`, ref(inc.index));
    }
  }
}

function visit(acc: Accumulator, workspace: string, cwdAbs: string, fileRel: string, isLocalPackage: boolean) {
  if (acc.visited.has(fileRel)) return;
  acc.visited.add(fileRel);
  acc.sources.push(fileRel);
  const raw = readFileSync(join(workspace, fileRel), "utf8");
  scanText(acc, workspace, cwdAbs, fileRel, raw, isLocalPackage);
}

/** Local .sty/.cls/.bst/.bbx/.cbx files next to the document satisfy requirements and are scanned too. */
function absorbLocalFiles(acc: Accumulator, workspace: string, cwdAbs: string) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of [...acc.requires.keys()]) {
      const local = join(cwdAbs, file);
      if (!existsSync(local)) continue;
      acc.requires.delete(file);
      const rel = relative(workspace, local);
      if (/\.(sty|cls)$/.test(file) && !acc.visited.has(rel)) {
        visit(acc, workspace, cwdAbs, rel, true);
        changed = true;
      }
    }
  }
}

/**
 * The programs of a .latexmkrc this document will run: its engine's command,
 * dvipdfmx on the DVI route, the bibliography tool it uses, and the index
 * tool if it has an index. Commands for other routes are left out, as their
 * programs can be large (Biber is 25 MB).
 */
function rcPrograms(rc: Latexmkrc | null, engine: Engine, bibTool: DocumentPlan["bibTool"], requires: Map<string, Ref>, file: string): Map<string, Ref> {
  const out = new Map<string, Ref>();
  if (!rc) return out;
  const roles = [engine === "platex" || engine === "uplatex" ? "latex" : engine];
  if (engine === "platex" || engine === "uplatex") roles.push("dvipdf");
  if (bibTool) roles.push(bibTool);
  if (["makeidx.sty", "imakeidx.sty", "index.sty"].some((f) => requires.has(f))) roles.push("makeindex");
  for (const role of roles) for (const p of rc.programs.get(role) ?? []) if (!out.has(p)) out.set(p, { file, line: 1 });
  return out;
}

export interface PlanOptions {
  /** Force an engine for every document (compatibility inputs). */
  engine?: Engine;
  /** Compile from this directory (relative to workspace) instead of each root's own directory. */
  cwd?: string;
}

export function planDocument(workspace: string, root: string, opts: PlanOptions = {}): DocumentPlan {
  const cwdRel = opts.cwd ?? dirname(root);
  const cwdAbs = resolve(workspace, cwdRel);
  const acc: Accumulator = {
    requires: new Map(),
    languages: new Map(),
    locales: new Map(),
    fonts: new Map(),
    packages: new Map(),
    directive: null,
    classes: [],
    luaFeature: null,
    babelBidi: null,
    babelFont: null,
    biblatex: null,
    bibtex: null,
    shellEscape: null,
    hasEps: null,
    systemPrograms: new Map(),
    ctexWindows: null,
    graphicsPaths: [],
    encodings: new Map(),
    sources: [],
    visited: new Set(),
  };
  visit(acc, workspace, cwdAbs, root, false);
  absorbLocalFiles(acc, workspace, cwdAbs);
  if (![...CM_REPLACEMENTS].some((p) => acc.packages.has(p))) {
    for (const [enc, r] of acc.encodings) addOnce(acc.requires, enc === "ts1" ? "cm-super-ts1.enc" : `cm-super-${enc}.enc`, r);
  }

  // Engine: explicit input > % !TeX program > .latexmkrc > packages and commands > pdfLaTeX.
  let engine: Engine = "pdflatex";
  let engineReason = "default";
  let engineFromLatexmkrc = false;
  const rc = readLatexmkrc(cwdAbs);
  const rcEngine = rc?.engine ?? null;
  const ja = acc.classes.map((c) => ({ c, engine: japaneseEngine(c.name, c.options) })).find((x) => x.engine);
  const lua = LUA_SIGNALS.find((p) => acc.packages.has(p));
  const xe = XE_SIGNALS.find((p) => acc.packages.has(p));
  const fmt = (r: Ref) => `${r.file}:${r.line}`;
  if (opts.engine) {
    engine = opts.engine;
    engineReason = "set in the workflow";
  } else if (acc.directive) {
    engine = acc.directive.engine;
    engineReason = `% !TeX program (${fmt(acc.directive.ref)})`;
  } else if (rcEngine) {
    engine = rcEngine;
    engineReason = rc!.file;
    engineFromLatexmkrc = true;
  } else if (lua) {
    engine = "lualatex";
    engineReason = `${lua} (${fmt(acc.packages.get(lua)!)})`;
  } else if (acc.luaFeature) {
    engine = "lualatex";
    engineReason = `${acc.luaFeature.reason} (${fmt(acc.luaFeature.ref)})`;
  } else if (ja) {
    engine = ja.engine!;
    engineReason = `${ja.c.name}${ja.c.options.includes(ja.engine!) ? ` [${ja.engine}]` : ""} (${fmt(ja.c.ref)})`;
  } else if (xe) {
    engine = "xelatex";
    engineReason = `${xe} (${fmt(acc.packages.get(xe)!)})`;
  } else if (acc.fonts.size > 0) {
    const [font, r] = [...acc.fonts][0];
    engine = "xelatex";
    engineReason = `font "${font}" (${fmt(r)})`;
  }

  // Packages babel loads itself, depending on the engine. babel is in
  // scheme-basic, whose files are not scanned for what they load.
  if (acc.babelFont && engine !== "pdflatex") addOnce(acc.requires, "fontspec.sty", acc.babelFont);
  if (acc.babelBidi && acc.babelBidi.mode !== "default") {
    if (engine === "lualatex") addOnce(acc.requires, "luatexbase.sty", acc.babelBidi.ref);
    if (engine === "xelatex" && acc.babelBidi.mode.startsWith("bidi")) {
      addOnce(acc.requires, "fontspec.sty", acc.babelBidi.ref);
      addOnce(acc.requires, "bidi.sty", acc.babelBidi.ref);
    }
  }

  // Languages from class options count only when babel is loaded.
  const languages = new Map<string, Ref>();
  for (const [lang, r] of acc.languages) {
    if (lang.startsWith("?")) {
      if (acc.packages.has("babel")) addOnce(languages, lang.slice(1), r);
    } else addOnce(languages, lang, r);
  }

  let bibTool: DocumentPlan["bibTool"] = null;
  if (acc.biblatex) bibTool = acc.biblatex.backend.startsWith("bibtex") ? "bibtex" : "biber";
  else if (acc.bibtex) bibTool = "bibtex";
  if (acc.hasEps && engine === "pdflatex") addOnce(acc.requires, "epstopdf.sty", acc.hasEps);

  return {
    root,
    cwd: cwdRel,
    target: relative(cwdAbs, resolve(workspace, root)),
    engine,
    engineReason,
    engineFromLatexmkrc,
    programs: rcPrograms(rc, engine, bibTool, acc.requires, join(cwdRel, rc?.file ?? "")),
    requires: acc.requires,
    languages,
    locales: acc.locales,
    fonts: acc.fonts,
    bibTool,
    shellEscape: acc.shellEscape,
    eps: acc.hasEps,
    ctexWindows: acc.ctexWindows,
    systemPrograms: acc.hasEps && !acc.systemPrograms.has("gs")
      ? new Map([...acc.systemPrograms, ["gs", { ...acc.hasEps, reason: "EPS images are converted with Ghostscript" }]])
      : acc.systemPrograms,
    sources: acc.sources,
    main: true,
  };
}
