// Reads LaTeX, latexmk, BibTeX and Biber output and extracts what the engine
// can act on (missing files, fonts, programs, engine mismatches) and what the
// user must fix (errors at a file and line).

export interface Problem {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
}

export type Missing =
  | { kind: "file"; name: string }
  | { kind: "font"; name: string }
  | { kind: "language"; name: string }
  | { kind: "program"; name: string };

export interface LogFindings {
  problems: Problem[];
  missing: Missing[];
  /** The document needs XeLaTeX or LuaLaTeX ("xelatex" when either works). */
  needsUnicodeEngine: "xelatex" | "lualatex" | null;
  needsShellEscape: boolean;
  pages: number | null;
  /** Last "Output written on X" path (may be in an -outdir), relative to the compile directory. */
  outputFile: string | null;
  /** Fonts METAFONT generated during the run; they exist for the next attempt. */
  generatedFonts: number;
}

const uniq = <T>(items: T[], key: (t: T) => string) => {
  const seen = new Set<string>();
  return items.filter((t) => (seen.has(key(t)) ? false : (seen.add(key(t)), true)));
};

export function parseLog(raw: string): LogFindings {
  const problems: Problem[] = [];
  const missing: Missing[] = [];
  // Package messages wrap onto lines that start with "(package)"; join them.
  const output = raw.replace(/\n\([A-Za-z0-9@.-]+\) {2,}/g, " ");

  for (const m of output.matchAll(/Encoding file [`'‘]([^'’]+)['’] not found/g)) missing.push({ kind: "file", name: m[1] });
  for (const m of output.matchAll(/language definition file\s+(\S+?\.ldf)\s+was\s+not\s+found/g)) missing.push({ kind: "file", name: m[1] });

  for (const m of output.matchAll(/LaTeX Error: File [`'‘]([^'’]+)['’] not found/g)) missing.push({ kind: "file", name: m[1] });
  // "! I can't find file `x'." or, with -file-line-error, "chemfig.tex:89: I can't find file `x'."
  for (const m of output.matchAll(/I can't find file [`'‘]([^'’]+)['’]/g)) missing.push({ kind: "file", name: m[1] });
  // Current babel: "Package babel Error: Unknown option 'russian'. Suggested actions: ..."
  for (const m of output.matchAll(/Package babel Error: Unknown option [`'‘]([A-Za-z]+)['’]/g)) missing.push({ kind: "language", name: m[1].toLowerCase() });
  for (const m of output.matchAll(/I couldn't open style file (\S+\.bst)/g)) missing.push({ kind: "file", name: m[1] });
  // Packages that check for their dependencies themselves (isodate: "Package file substr.sty not found").
  for (const m of output.matchAll(/Package file (\S+\.(?:sty|cls|tex|def|cfg)) not found/g)) missing.push({ kind: "file", name: m[1] });
  // Font definition files are only a warning ("No file LGRcmr.fd.") until NFSS gives up later.
  for (const m of output.matchAll(/^No file (\S+\.fd)\.$/gm)) missing.push({ kind: "file", name: m[1] });
  for (const m of output.matchAll(/Missing input file '(\S+\.(?:fd|sty|cls|def|cfg|clo|ldf))'/g)) missing.push({ kind: "file", name: m[1] });
  // pdfTeX: "(file uhvb8a.pfb): cannot open Type 1 font file", "(file texnansi.enc): cannot open encoding file".
  for (const m of output.matchAll(/\(file ([^)\s]+)\): cannot open/g)) missing.push({ kind: "file", name: m[1] });
  for (const m of output.matchAll(/Package fontspec Error:\s*(?:\(fontspec\)\s*)?The font "([^"]+)" cannot be\s+(?:\(fontspec\)\s*)?found/g))
    missing.push({ kind: "font", name: m[1] });
  for (const m of output.matchAll(/luaotfload \| \w+ : [^\n]*?Font "([^"]+)" not found/g)) missing.push({ kind: "font", name: m[1] });
  // "! Font \T1/cmr/m/n/10=ecrm1000 at 10pt not loadable" (older) or "! Font OML/zplm/m/it/8=zplmr7m ..." (newer).
  for (const m of output.matchAll(/! Font \\?[^=\s]+=([^\s:]+?)(?: at [\d.]+pt| scaled \d+)? not loadable: Metric \(TFM\) file/g)) {
    missing.push({ kind: "file", name: m[1].replace(/\.tfm$/, "") + ".tfm" });
  }
  // "kpathsea: Running mktextfm X" means TeX is generating a font, not that it is missing.
  const generatedFonts = [...output.matchAll(/mktex(?:tfm|pk|mf): \S+: successfully generated/g)].length;
  for (const m of output.matchAll(/(?:sh: \d+: |\/bin\/sh: )?(\S+): (?:command )?not found/g)) {
    if (/^[\w.-]+$/.test(m[1]) && !m[1].includes(".tex")) missing.push({ kind: "program", name: m[1] });
  }

  let needsUnicodeEngine: LogFindings["needsUnicodeEngine"] = null;
  if (/requires (?:either )?XeTeX or LuaTeX|must be (?:used|run) with (?:either )?XeTeX or LuaTeX|fontspec package requires/i.test(output))
    needsUnicodeEngine = "xelatex";
  if (/requires LuaTeX|needs to be run with LuaLaTeX|only works with LuaTeX|This package only runs with LuaTeX|luatexja.*requires LuaTeX/i.test(output))
    needsUnicodeEngine = "lualatex";
  else if (/requires XeTeX|must be used with XeTeX|only works with XeTeX/i.test(output) && !needsUnicodeEngine)
    needsUnicodeEngine = "xelatex";

  const needsShellEscape = /-shell-escape|shell escape is disabled|--enable-write18|You must invoke LaTeX with/i.test(output);

  // file:line:message lines from -file-line-error; TeX wraps long messages at
  // 79 characters, so keep reading until the message ends.
  const lines = output.split("\n");
  const stop = /^\s*$|^(See the |Type {2}H|Type H|l\.\d|! |\.\/|\S+\.(?:tex|sty|cls):\d+:|\(|Enter file name)/;
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\s:][^:\n]*\.(?:tex|sty|cls|bib|ltx|def|cfg|bbx|cbx)):(\d+): (.+)$/.exec(lines[i]);
    if (!m) continue;
    let message = m[3].trim();
    for (let j = i + 1; j < Math.min(i + 4, lines.length) && !stop.test(lines[j]) && lines[i].length >= 78; j++) {
      message += lines[j].trim();
      if (lines[j].length < 79) break;
    }
    problems.push({ severity: "error", file: m[1].replace(/^\.\//, ""), line: Number(m[2]), message });
  }
  // Errors without a location.
  for (const m of output.matchAll(/^! (.+)$/gm)) {
    if (!problems.some((p) => m[1].includes(p.message) || p.message.includes(m[1]))) problems.push({ severity: "error", message: m[1].trim() });
  }
  for (const m of output.matchAll(/^ERROR - (.+)$/gm)) problems.push({ severity: "error", message: `Biber: ${m[1].trim()}` });
  for (const m of output.matchAll(/LaTeX Warning: (Reference|Citation) [`'‘]([^'’]+)['’] (?:on page \d+ )?undefined(?: on input line (\d+))?/g)) {
    problems.push({ severity: "warning", message: `${m[1]} "${m[2]}" is undefined`, line: m[3] ? Number(m[3]) : undefined });
  }

  const pageMatches = [...output.matchAll(/Output written on [^(]+\((\d+) pages?/g)];
  const pages = pageMatches.length ? Number(pageMatches[pageMatches.length - 1][1]) : null;
  const written = [...output.matchAll(/Output written on "?([^"\n(]+?\.(?:pdf|xdv|dvi))"?\s*\(/g)];
  const outputFile = written.length ? written[written.length - 1][1].trim() : null;

  return {
    generatedFonts,
    outputFile,
    problems: uniq(problems, (p) => `${p.severity}|${p.file}|${p.line}|${p.message}`).slice(0, 50),
    missing: uniq(missing, (m) => `${m.kind}|${m.name}`),
    needsUnicodeEngine,
    needsShellEscape,
    pages,
  };
}
