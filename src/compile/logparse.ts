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
  for (const m of output.matchAll(/Package fontspec Error:\s*(?:\(fontspec\)\s*)?The font "([^"]+)" cannot be\s+(?:\(fontspec\)\s*)?found/g))
    missing.push({ kind: "font", name: m[1] });
  for (const m of output.matchAll(/not loadable: Metric \(TFM\) file(?: or installed font)? not found/g)) {
    const font = /! Font \\[^=]+=([^\s:]+)/.exec(output.slice(Math.max(0, m.index! - 300), m.index!))?.[1];
    if (font) missing.push({ kind: "file", name: font.replace(/\.tfm$/, "") + ".tfm" });
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

  return {
    problems: uniq(problems, (p) => `${p.severity}|${p.file}|${p.line}|${p.message}`).slice(0, 50),
    missing: uniq(missing, (m) => `${m.kind}|${m.name}`),
    needsUnicodeEngine,
    needsShellEscape,
    pages,
  };
}
