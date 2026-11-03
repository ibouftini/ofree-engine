// Reads LaTeX, latexmk, BibTeX and Biber output and extracts what the engine
// can act on itself: missing files, fonts and programs, engine mismatches.
// What the user must fix is read by diagnose.ts.

export type Missing =
  | { kind: "file"; name: string }
  | { kind: "font"; name: string }
  | { kind: "language"; name: string }
  | { kind: "program"; name: string };

export interface LogFindings {
  missing: Missing[];
  /** The document needs a Unicode engine: one of them in particular, or "either". */
  needsUnicodeEngine: "either" | "xelatex" | "lualatex" | null;
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

/**
 * Undoes TeX's line breaking in a log read as latin1. TeX breaks lines at 79
 * columns, even inside a word: pdfTeX counts bytes (and may split a UTF-8
 * character), XeTeX and LuaTeX count characters.
 */
export function unbreakLines(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const full = l.length === 79 || (l.length > 79 && Buffer.from(l, "latin1").toString("utf8").length === 79);
    out += l + (full || i === lines.length - 1 ? "" : "\n");
  }
  return out;
}

export function parseLog(raw: string): LogFindings {
  const missing: Missing[] = [];
  // Package messages continue on lines that start with "(package)", and TeX breaks lines at 79 columns.
  // Join the package lines first: a message line may be exactly 79 columns long.
  const output = unbreakLines(raw.replace(/\n\([A-Za-z0-9@.-]+\) {2,}/g, " "));

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
  for (const m of output.matchAll(/Font \\?[^=\s]+=([^\s:]+?)(?: at [\d.]+pt| scaled \d+)? not loadable: Metric \(TFM\) file/g)) {
    missing.push({ kind: "file", name: m[1].replace(/\.tfm$/, "") + ".tfm" });
  }
  // EPS images are converted by Ghostscript (dvipdfmx through rungs, pdfLaTeX through epstopdf).
  if (/Image inclusion failed for "[^"]+\.e?ps"|Could not open conversion result .* for image "[^"]+\.e?ps"|epstopdf.*(?:GPL Ghostscript|\bgs\b).*(?:not found|failed)/i.test(output))
    missing.push({ kind: "program", name: "gs" });
  // "kpathsea: Running mktextfm X" means TeX is generating a font, not that it is missing.
  const generatedFonts = [...output.matchAll(/mktex(?:tfm|pk|mf): \S+: successfully generated/g)].length;
  for (const m of output.matchAll(/(?:sh: \d+: |\/bin\/sh: )?(\S+): (?:command )?not found/g)) {
    if (/^[\w.-]+$/.test(m[1]) && !m[1].includes(".tex")) missing.push({ kind: "program", name: m[1] });
  }

  // Wordings vary ("requires LuaTeX", "only works with LuaTeX", babel's "is
  // available only in luatex"), and TeX may wrap a message between any words.
  const only = (engine: string) =>
    new RegExp(
      `requires\\s+${engine}\\b(?!\\s+or)|must\\s+be\\s+(?:used|run)\\s+with\\s+${engine}\\b(?!\\s+or)|needs\\s+to\\s+be\\s+run\\s+with\\s+${engine}|` +
        `only\\s+(?:works|runs|available|supported)\\s+(?:in|with|under)\\s+${engine}|(?:available|works|runs|supported)\\s+only\\s+(?:in|with|under)\\s+${engine}`,
      "i",
    );
  let needsUnicodeEngine: LogFindings["needsUnicodeEngine"] = null;
  if (/requires\s+(?:either\s+)?XeTeX\s+or\s+LuaTeX|must\s+be\s+(?:used|run)\s+with\s+(?:either\s+)?XeTeX\s+or\s+LuaTeX|fontspec\s+package\s+requires/i.test(output))
    needsUnicodeEngine = "either";
  // Only errors count: warnings and banners also mention engines ("... only in LuaTeX; ignored").
  const rawLines = output.split("\n");
  const errorText = rawLines.flatMap((l, i) => (/Error|^! /.test(l) ? [rawLines.slice(i, i + 3).join(" ")] : [])).join("\n");
  if (only("Lua(?:La)?TeX").test(errorText)) needsUnicodeEngine = "lualatex";
  else if (only("Xe(?:La)?TeX").test(errorText)) needsUnicodeEngine = "xelatex";

  const needsShellEscape = /-shell-escape|shell escape is disabled|--enable-write18|You must invoke LaTeX with/i.test(output);

  const pageMatches = [...output.matchAll(/Output written on [^(]+\((\d+) pages?/g)];
  const pages = pageMatches.length ? Number(pageMatches[pageMatches.length - 1][1]) : null;
  const written = [...output.matchAll(/Output written on "?([^"\n(]+?\.(?:pdf|xdv|dvi))"?\s*\(/g)];
  const outputFile = written.length ? written[written.length - 1][1].trim() : null;

  return {
    generatedFonts,
    outputFile,
    missing: uniq(missing, (m) => `${m.kind}|${m.name}`),
    needsUnicodeEngine,
    needsShellEscape,
    pages,
  };
}
