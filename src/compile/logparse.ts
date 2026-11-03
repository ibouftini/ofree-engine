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
}

const uniq = <T>(items: T[], key: (t: T) => string) => {
  const seen = new Set<string>();
  return items.filter((t) => (seen.has(key(t)) ? false : (seen.add(key(t)), true)));
};

export function parseLog(output: string): LogFindings {
  const problems: Problem[] = [];
  const missing: Missing[] = [];

  for (const m of output.matchAll(/LaTeX Error: File [`'‘]([^'’]+)['’] not found/g)) missing.push({ kind: "file", name: m[1] });
  for (const m of output.matchAll(/! I can't find file [`'‘]([^'’]+)['’]/g)) missing.push({ kind: "file", name: m[1] });
  for (const m of output.matchAll(/I couldn't open style file (\S+\.bst)/g)) missing.push({ kind: "file", name: m[1] });
  // Packages that check for their dependencies themselves (isodate: "Package file substr.sty not found").
  for (const m of output.matchAll(/Package file (\S+\.(?:sty|cls|tex|def|cfg)) not found/g)) missing.push({ kind: "file", name: m[1] });
  // pdfTeX: "(file uhvb8a.pfb): cannot open Type 1 font file", "(file texnansi.enc): cannot open encoding file".
  for (const m of output.matchAll(/\(file ([^)\s]+)\): cannot open/g)) missing.push({ kind: "file", name: m[1] });
  for (const m of output.matchAll(/Package fontspec Error:\s*(?:\(fontspec\)\s*)?The font "([^"]+)" cannot be\s+(?:\(fontspec\)\s*)?found/g))
    missing.push({ kind: "font", name: m[1] });
  for (const m of output.matchAll(/luaotfload \| \w+ : [^\n]*?Font "([^"]+)" not found/g)) missing.push({ kind: "font", name: m[1] });
  // "! Font \T1/cmr/m/n/10=ecrm1000 at 10pt not loadable" (older) or "! Font OML/zplm/m/it/8=zplmr7m ..." (newer).
  for (const m of output.matchAll(/! Font \\?[^=\s]+=([^\s:]+?)(?: at [\d.]+pt| scaled \d+)? not loadable: Metric \(TFM\) file/g)) {
    missing.push({ kind: "file", name: m[1].replace(/\.tfm$/, "") + ".tfm" });
  }
  for (const m of output.matchAll(/kpathsea: Running mktextfm (\S+)/g)) missing.push({ kind: "file", name: `${m[1]}.tfm` });
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

  // file:line:message lines from -file-line-error.
  for (const m of output.matchAll(/^([^\s:][^:\n]*\.(?:tex|sty|cls|bib|ltx|def|cfg|bbx|cbx)):(\d+): (.+)$/gm)) {
    problems.push({ severity: "error", file: m[1].replace(/^\.\//, ""), line: Number(m[2]), message: m[3].trim() });
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
    outputFile,
    problems: uniq(problems, (p) => `${p.severity}|${p.file}|${p.line}|${p.message}`).slice(0, 50),
    missing: uniq(missing, (m) => `${m.kind}|${m.name}`),
    needsUnicodeEngine,
    needsShellEscape,
    pages,
  };
}
