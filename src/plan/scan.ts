// Reads a project's LaTeX sources and works out, without compiling anything,
// which documents to build, with which engine, and which files they need.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

export type Engine = "pdflatex" | "xelatex" | "lualatex";

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
  /** Files the document needs from TeX Live, keyed by file name. */
  requires: Map<string, Ref>;
  /** Babel or polyglossia language names. */
  languages: Map<string, Ref>;
  /** Font names given to fontspec-style commands. */
  fonts: Map<string, Ref>;
  bibTool: "biber" | "bibtex" | null;
  shellEscape: Ref & { reason: string } | null;
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

const ENGINE_DIRECTIVE = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)/im;

function engineFromName(name: string): Engine | null {
  const n = name.toLowerCase();
  if (n.includes("xelatex") || n === "xetex") return "xelatex";
  if (n.includes("lualatex") || n === "luatex" || n === "luahblatex") return "lualatex";
  if (n.includes("pdflatex") || n === "pdftex" || n === "latex") return "pdflatex";
  return null;
}

/** Engine chosen by a .latexmkrc in `dir`, if any ($pdf_mode 4 = LuaLaTeX, 5 = XeLaTeX). */
export function latexmkrcEngine(dir: string): Engine | null {
  for (const name of [".latexmkrc", "latexmkrc"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").replace(/#.*$/gm, "");
    const mode = /\$pdf_mode\s*=\s*(\d)/.exec(text)?.[1];
    if (mode === "4") return "lualatex";
    if (mode === "5") return "xelatex";
    if (mode === "1") return "pdflatex";
    if (/\$pdflatex\s*=\s*['"]\s*xelatex/.test(text)) return "xelatex";
    if (/\$pdflatex\s*=\s*['"]\s*lualatex/.test(text)) return "lualatex";
  }
  return null;
}

// Packages and commands that decide the engine when nothing says so explicitly.
const LUA_SIGNALS = ["luacode", "luatexja", "luatexja-fontspec", "luatexja-preset", "luamplib", "lua-visual-debug", "luaotfload", "tikz-feynman", "emoji", "lua-ul", "pyluatex", "ltjsarticle", "ltjsbook", "ltjsreport", "ltjarticle", "ltjbook"];
const XE_SIGNALS = ["fontspec", "polyglossia", "unicode-math", "xunicode", "xltxtra", "xeCJK", "xepersian", "bidi", "mathspec", "arabxetex", "xgreek", "ctex", "ctexart", "ctexbook", "ctexrep", "ctexbeamer", "fontawesome5-xe"];

interface Accumulator {
  requires: Map<string, Ref>;
  languages: Map<string, Ref>;
  fonts: Map<string, Ref>;
  packages: Map<string, Ref>;
  directive: { engine: Engine; ref: Ref } | null;
  luaCommand: Ref | null;
  biblatex: { backend: string; ref: Ref } | null;
  bibtex: Ref | null;
  shellEscape: (Ref & { reason: string }) | null;
  hasEps: Ref | null;
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
        for (const opt of splitNames(options)) {
          const lang = opt.startsWith("main=") ? opt.slice(5) : opt;
          if (/^[A-Za-z]+$/.test(lang)) addOnce(acc.languages, lang.toLowerCase(), r);
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

  for (const m of text.matchAll(/\\usetikzlibrary\s*\{([^}]*)\}/g)) {
    for (const lib of splitNames(m[1].replace(/\s+/g, ""))) addOnce(acc.requires, `tikzlibrary${lib}.code.tex`, ref(m.index!));
  }
  // pgfplots libraries are TikZ libraries named "pgfplots.<lib>".
  for (const m of text.matchAll(/\\usepgfplotslibrary\s*\{([^}]*)\}/g)) {
    for (const lib of splitNames(m[1].replace(/\s+/g, ""))) addOnce(acc.requires, `tikzlibrarypgfplots.${lib}.code.tex`, ref(m.index!));
  }
  for (const m of text.matchAll(/\\usegdlibrary\s*\{/g)) {
    if (!acc.luaCommand) acc.luaCommand = ref(m.index!);
  }
  for (const m of text.matchAll(/\\directlua\s*\{/g)) {
    if (!acc.luaCommand) acc.luaCommand = ref(m.index!);
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
  const fontRes = [
    /\\set(?:CJK)?(?:main|sans|mono|math)font\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
    /\\newfont(?:family|face)\s*\{?\\[A-Za-z@]+\}?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
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
    if (w) acc.shellEscape = { ...ref(w.index), reason: "the document runs shell commands (\\write18)" };
  }
  if (!acc.hasEps) {
    const e = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{[^}]*\.eps\}/i.exec(text);
    if (e) acc.hasEps = ref(e.index);
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
    fonts: new Map(),
    packages: new Map(),
    directive: null,
    luaCommand: null,
    biblatex: null,
    bibtex: null,
    shellEscape: null,
    hasEps: null,
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
  const rcEngine = latexmkrcEngine(cwdAbs);
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
    engineReason = ".latexmkrc";
    engineFromLatexmkrc = true;
  } else if (lua) {
    engine = "lualatex";
    engineReason = `${lua} (${fmt(acc.packages.get(lua)!)})`;
  } else if (acc.luaCommand) {
    engine = "lualatex";
    engineReason = `Lua code (${fmt(acc.luaCommand)})`;
  } else if (xe) {
    engine = "xelatex";
    engineReason = `${xe} (${fmt(acc.packages.get(xe)!)})`;
  } else if (acc.fonts.size > 0) {
    const [font, r] = [...acc.fonts][0];
    engine = "xelatex";
    engineReason = `font "${font}" (${fmt(r)})`;
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
    requires: acc.requires,
    languages,
    fonts: acc.fonts,
    bibTool,
    shellEscape: acc.shellEscape,
    sources: acc.sources,
  };
}
