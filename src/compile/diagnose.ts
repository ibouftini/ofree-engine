// What the user must fix, read from the engine's final .log and the
// bibliography tool's .blg: the real errors, each with the command or text
// where TeX stopped and a plain-language hint; errors that only follow from an
// earlier one folded into it; and the warnings worth reading, grouped
// (undefined references and citations, characters a font lacks).

import { hintFor } from "./hints.js";
import { unbreakLines } from "./logparse.js";

export interface Issue {
  /** The message without its "LaTeX Error:" or "Package x Error:" prefix. */
  message: string;
  /** Package that reported it, if any. */
  source?: string;
  /** File relative to the compile directory; absent for errors inside TeX Live's own files. */
  file?: string;
  /** Every line where it occurred (one issue per message, file and culprit). */
  lines: number[];
  /** The undefined command or environment, or the text where TeX stopped. */
  culprit?: string;
  hint?: string;
}

export interface Diagnosis {
  errors: Issue[];
  /** Undefined \ref labels, with the lines that use them. */
  references: { key: string; lines: number[] }[];
  /** Undefined citations; `missing` when no .bib file has the key. */
  citations: { key: string; lines: number[]; missing: boolean }[];
  /** Characters a font has no glyph for (they are blank in the PDF). */
  glyphs: { char: string; font: string; count: number }[];
  /** Other warnings, without duplicates or rerun notices. */
  warnings: string[];
  overfull: number;
  underfull: number;
}

export interface SourceContext {
  /** Source files relative to the compile directory, for locating text TeX quotes without a line number. */
  sources: () => { file: string; text: string }[];
  /** Project files whose name differs only by case or extension, relative to the compile directory. */
  similarFiles: (name: string) => string[];
}

const NO_CONTEXT: SourceContext = { sources: () => [], similarFiles: () => [] };

/** The log as text: TeX's line breaks undone, UTF-8 decoded, package continuation lines ("(name)  ...") joined. */
export function readableLog(raw: string): string {
  // Package lines first: a message line may be exactly 79 columns long.
  return Buffer.from(unbreakLines(raw.replace(/\n\([A-Za-z0-9@.-]+\) {2,}/g, " ")), "latin1").toString("utf8");
}

const ERROR_AT = /^(\S.*?\.(?:tex|sty|cls|ltx|def|cfg|bbx|cbx|lbx|dtx|clo|fd|ldf|bib)):(\d+): (.*)$/;
/** Lines after an error that belong to TeX's explanation or context, not the message. */
const CONTEXT_START = /^(?:l\.\d+ |<[^>]+> |See the |Type {2}H|Type H|\s*\.\.\.\s*$|\*\*\*|$)/;
const NOT_ERRORS = /^(?:Emergency stop|==> Fatal error|\s*==> Fatal error|Interruption|Fatal error occurred|Job aborted)/;

interface RawError {
  message: string;
  source?: string;
  file?: string;
  line?: number;
  culprit?: string;
  external: boolean;
}

function shorten(message: string): { message: string; source?: string } {
  let source: string | undefined;
  let m = message.replace(/^LaTeX Error:\s*/, "");
  const pkg = /^(?:Package|Class) (\S+) Error:\s*(.*)$/.exec(m);
  if (pkg) [source, m] = [pkg[1], pkg[2]];
  m = m.replace(/\s+/g, " ").replace(/ \.$/, ".").trim();
  // Keep the first sentence of long package messages ("The font X cannot be found; this may be ...").
  if (m.length > 120) {
    const cut = /^(.{15,}?[.;])\s/.exec(m);
    if (cut) m = cut[1].replace(/;$/, ".");
  }
  return { message: m.length > 240 ? `${m.slice(0, 237)}…` : m, source };
}

/** Errors where the text TeX stopped at shows the mistake ("x^" for a missing $, "a & b &" for an extra column). */
const CONTEXT_HELPS =
  /^(?:Missing \$|Extra alignment|Misplaced alignment|Double (?:super|sub)script|Missing number|Illegal unit|Missing [{}] inserted|Extra \}|Too many \}|There's no line here|Unicode character|Display math|Bad math)/;

const lastCommand = (text: string) => /(\\[A-Za-z@]+\*?|\\.)\s*$/.exec(text)?.[1];

function readErrors(lines: string[], workspaceFile: (f: string) => string | undefined): RawError[] {
  const out: RawError[] = [];
  for (let i = 0; i < lines.length; i++) {
    let file: string | undefined;
    let line: number | undefined;
    let text: string;
    const at = ERROR_AT.exec(lines[i]);
    if (at) [file, line, text] = [at[1], Number(at[2]), at[3]];
    else if (lines[i].startsWith("! ")) text = lines[i].slice(2);
    else continue;
    if (NOT_ERRORS.test(text.trim())) continue;

    // Indented lines right after the message continue it ("Unicode character ★ (U+2605)\n   not set up ...").
    let j = i + 1;
    while (j < lines.length && /^\s{4,}\S/.test(lines[j]) && !CONTEXT_START.test(lines[j].trimStart())) text += " " + lines[j++].trim();

    // TeX's context: "<argument> ... \foo" and "l.12 We use \mycommand" (where it stopped).
    let argument: string | undefined;
    let stopped: string | undefined;
    for (let k = j; k < Math.min(j + 14, lines.length); k++) {
      if (ERROR_AT.test(lines[k]) || lines[k].startsWith("! ")) break;
      const arg = /^<argument> (.*)$/.exec(lines[k]);
      if (arg && argument === undefined) argument = arg[1];
      const l = /^l\.(\d+) (.*)$/.exec(lines[k]);
      if (l) {
        line ??= Number(l[1]);
        stopped = l[2];
        break;
      }
    }
    // "Runaway argument?" quotes the text whose closing brace is missing.
    let runaway: string | undefined;
    for (let k = Math.max(0, i - 3); k < i; k++) if (/^Runaway (?:argument|definition|text)\?/.test(lines[k])) runaway = lines[k + 1];

    const { message, source } = shorten(text);
    let culprit: string | undefined;
    if (/^Undefined control sequence/.test(message)) culprit = lastCommand(argument ?? "") ?? lastCommand(stopped ?? "");
    else if (runaway) culprit = runaway.replace(/^\{/, "").split(/\\par\b/)[0].trim().slice(0, 60);
    else if (stopped && CONTEXT_HELPS.test(message)) culprit = stopped.replace(/^\.\.\./, "").trim().slice(-50) || undefined;

    const rel = file ? workspaceFile(file) : undefined;
    out.push({ message, source, file: rel, line, culprit, external: file !== undefined && rel === undefined });
  }
  return out;
}

/** Drops errors that only follow from an earlier one. */
function foldConsequences(errors: RawError[]): RawError[] {
  const out: RawError[] = [];
  for (let i = 0; i < errors.length; i++) {
    const e = errors[i];
    out.push(e);
    // TeX reports "Missing $ inserted" twice: where math starts, and again where it ends it.
    if (/^Missing \$ inserted/.test(e.message) && /^Missing \$ inserted/.test(errors[i + 1]?.message ?? "")) i++;
    // An undefined environment: what follows up to its \end is noise ("Misplaced alignment tab", "ended by \end{align}").
    const env = /^Environment (\S+) undefined/.exec(e.message)?.[1];
    if (env) {
      const end = errors.findIndex((x, k) => k > i && k <= i + 12 && x.message.includes(`\\end{${env}}`));
      if (end > i) i = end;
    }
    // A font that cannot be found makes every later use of it fail.
    if (/cannot be found/.test(e.message) && e.source === "fontspec") {
      while (i + 1 < errors.length && /not loadable|cannot be found/.test(errors[i + 1].message)) i++;
    }
  }
  return out;
}

function locate(text: string, ctx: SourceContext): { file: string; line: number } | undefined {
  const needle = text.replace(/\s+/g, " ").slice(0, 30).trim();
  if (needle.length < 6) return undefined;
  for (const s of ctx.sources()) {
    const flat = s.text.replace(/[ \t]+/g, " ");
    const at = flat.indexOf(needle);
    if (at >= 0) return { file: s.file, line: flat.slice(0, at).split("\n").length };
  }
  return undefined;
}

function group<T extends { key: string; line?: number }>(items: T[]): Map<string, { first: T; lines: number[] }> {
  const map = new Map<string, { first: T; lines: number[] }>();
  for (const it of items) {
    const g = map.get(it.key) ?? { first: it, lines: [] };
    if (it.line !== undefined && !g.lines.includes(it.line)) g.lines.push(it.line);
    map.set(it.key, g);
  }
  return map;
}

const SERIES: Record<string, string> = { b: "bold", bx: "bold", sb: "semibold", eb: "extra bold", l: "light" };
const SHAPES: Record<string, string> = { it: "italic", sl: "slanted", sc: "small caps", scit: "italic small caps" };

/** "Font shape `TU/X(0)/b/n' undefined using `TU/X(0)/m/n' instead" -> "Font X has no bold: the regular shape is used instead". */
function fontShapeWarning(w: string): string {
  const m = /^Font shape [`'‘][^/]+\/([^/]+?)(?:\(\d+\))?\/([^/]+)\/([^'’]+)['’] undefined using [`'‘][^'’]+['’] instead/.exec(w);
  if (!m) return w;
  const what = [SERIES[m[2]], SHAPES[m[3]]].filter(Boolean).join(" ");
  return what ? `Font ${m[1]} has no ${what}: the regular shape is used instead` : w;
}

const WARNING_NOISE =
  /Label\(s\) may have changed|There were undefined references|There were undefined citations|Please \(?re\)?run|Rerun to get|has changed\.|float specifier changed|Size substitutions|Some font shapes were not available|The following entry could not be found|Citation [`'‘]|Reference [`'‘]|File [`'‘].*not found|Empty bibliography|Unused global option/;

const TEX_RULES = /^(?:latex|pdflatex|lualatex|xelatex|platex|uplatex)$/;

/**
 * Failures of the programs around TeX, which its .log does not show: dvipdfmx
 * stopping on a font without a map entry, or a rule latexmk reports as failed
 * (BibTeX, makeindex, ...). Read from latexmk's output.
 */
export function toolErrors(output: string, texErrors: number): Issue[] {
  const out: Issue[] = [];
  // latexmk stops before running anything when a .latexmkrc does not compile.
  const rc = /Latexmk: Initialization file '([^']+)' gave an error:\s*\n\s*(.+)/.exec(output);
  if (rc) {
    const file = rc[1].split("/").pop();
    return [{ message: rc[2].trim(), source: "latexmk", lines: [], hint: `${file} has a Perl error, so latexmk stopped before running anything.` }];
  }
  for (const m of output.matchAll(/^(x?dvipdfmx):fatal: (.+)$/gm)) {
    const before = output.slice(0, m.index);
    const font = [...before.matchAll(/Could not locate a virtual\/physical font for TFM "([^"]+)"/g)].pop()?.[1];
    const cmap = [...before.matchAll(/Could not read encoding file: (\S+)/g)].pop()?.[1];
    const issue: Issue = { message: m[2].trim(), source: m[1], lines: [], culprit: font };
    issue.hint = cmap ? `dvipdfmx cannot read the character map \`${cmap}\` it needs for \`${font ?? "this font"}\`.` : hintFor(issue, () => []);
    if (!out.some((o) => o.message === issue.message && o.culprit === issue.culprit)) out.push(issue);
  }
  if (out.length === 0 && texErrors === 0) {
    for (const m of output.matchAll(/^\s*(\w+)(?: [^:\n]*)?: Command for '([^']+)' gave return code (\d+)/gm)) {
      if (TEX_RULES.test(m[1])) continue;
      // A custom rule is named "cusdep asy pdf main-1": main-1.asy to main-1.pdf.
      const conv = /^cusdep (\S+) (\S+) (.+)$/.exec(m[2]);
      const message = conv ? `Converting ${conv[3]}.${conv[1]} to ${conv[3]}.${conv[2]} failed` : `${m[2]} failed (exit code ${m[3]})`;
      if (!out.some((o) => o.source === m[1] && o.message === message)) out.push({ message, source: conv ? conv[1] : m[1], lines: [], hint: "See this program's messages in the log of this step." });
    }
  }
  return out;
}

/**
 * Reads the final .log (and .blg) of a document. `log` and `blg` are read as
 * latin1, as TeX writes bytes; `workspaceFile` maps a file name in the log to
 * a path relative to the compile directory, or undefined for TeX Live's files.
 */
export function diagnose(
  log: string,
  blg = "",
  ctx: SourceContext = NO_CONTEXT,
  workspaceFile: (f: string) => string | undefined = (f) => (f.startsWith("/") ? undefined : f.replace(/^\.\//, "")),
): Diagnosis {
  const text = readableLog(log);
  const end = text.search(/^Here is how much of TeX's memory you used:/m);
  const lines = (end >= 0 ? text.slice(0, end) : text).split("\n");

  // Errors.
  const raw = foldConsequences(readErrors(lines, workspaceFile));
  for (const e of raw) {
    if (e.line === undefined && e.culprit && /^(?:File ended|Paragraph ended|Runaway)/.test(e.message)) {
      const at = locate(e.culprit, ctx);
      if (at) [e.file, e.line] = [at.file, at.line];
    }
  }
  const bib = readableLog(blg).split("\n");
  for (let i = 0; i < bib.length; i++) {
    // BibTeX: "I was expecting a `,' or a `}'---line 2 of file refs.bib", then " : " lines quoting the entry.
    const bt = /^(.*)---line (\d+) of file (.+)$/.exec(bib[i]);
    if (bt) {
      const quoted = bib[i + 1]?.startsWith(" : ") ? bib[i + 1].slice(3).trim() : undefined;
      raw.push({ message: bt[1].trim(), source: "BibTeX", file: bt[3].trim(), line: Number(bt[2]), culprit: quoted, external: false });
    }
    const bb = /ERROR - (?:BibTeX subsystem: )?(.*)$/.exec(bib[i]);
    if (bb) {
      const m = /^(\S+?)(?:_\d+\.utf8)?, line (\d+), (.*)$/.exec(bb[1]);
      raw.push(
        m
          ? { message: m[3], source: "Biber", file: m[1].split("/").pop(), line: Number(m[2]), external: false }
          : { message: bb[1].replace(/'\/tmp\/[^']*'/g, "a temporary file"), source: "Biber", external: false },
      );
    }
  }
  const grouped = group(raw.map((e) => ({ ...e, key: `${e.file}|${e.source}|${e.message}|${/^Undefined control|Environment/.test(e.message) ? e.culprit : ""}` })));
  const similar = (name: string) => ctx.similarFiles(name);
  const errors: Issue[] = [...grouped.values()].map(({ first, lines: ls }) => {
    const issue: Issue = { message: first.message, source: first.source, file: first.external ? undefined : first.file, lines: ls, culprit: first.culprit };
    issue.hint = hintFor(issue, similar);
    return issue;
  });

  // Undefined references and citations (natbib and biblatex use the same wording as LaTeX).
  const refs = group([...text.matchAll(/Reference [`'‘]([^'’]+)['’] on page \S+ undefined on input line (\d+)/g)].map((m) => ({ key: m[1], line: Number(m[2]) })));
  const cites = group([...text.matchAll(/Citation [`'‘]([^'’]+)['’] (?:on page \S+ )?undefined on input line (\d+)/g)].map((m) => ({ key: m[1], line: Number(m[2]) })));
  const notInBib = new Set<string>();
  for (const m of text.matchAll(/The following entry could not be found in the database: (\S+?)\s/g)) notInBib.add(m[1]);
  for (const m of bib.join("\n").matchAll(/I didn't find a database entry for ["'](\S+?)["']/g)) notInBib.add(m[1]);
  for (const k of notInBib) if (!cites.has(k)) cites.set(k, { first: { key: k, line: 0 }, lines: [] });

  // Characters missing from a font. "nullfont" means no font at all, which an error already explains.
  const glyphs = new Map<string, { char: string; font: string; count: number }>();
  for (const m of text.matchAll(/Missing character: There is no (\S+)(?: \((U\+[0-9A-F]+|"[0-9A-F]+)\))? in font ([^!\n]+)!/g)) {
    const font = m[3].replace(/^name:/, "").replace(/^\[([^\]]+)\].*$/, "$1").split(/[:/]/)[0].trim();
    if (font === "nullfont") continue;
    const char = m[2] ? `${m[1]} (${m[2].replace(/^"/, "U+")})` : m[1];
    const g = glyphs.get(char + font) ?? { char, font, count: 0 };
    g.count++;
    glyphs.set(char + font, g);
  }

  // Shapes of a font that was not found at all are not worth a warning.
  const lostFonts = errors.flatMap((e) => /The font "([^"]+)" cannot be found/.exec(e.message)?.[1].replace(/\s+/g, "") ?? []);
  const warnings = new Set<string>();
  for (const m of text.matchAll(/^(?:LaTeX|LaTeX Font|(?:Package|Class) (\S+)) Warning: (.*)$/gm)) {
    const w = fontShapeWarning(m[2].replace(/\s+/g, " ").replace(/ on input line \d+\.?$/, "").trim());
    if (!w || WARNING_NOISE.test(w) || lostFonts.some((f) => w.replace(/\s+/g, "").includes(f))) continue;
    warnings.add(m[1] ? `${m[1]}: ${w}` : w);
  }

  return {
    errors,
    references: [...refs].map(([key, g]) => ({ key, lines: g.lines })),
    citations: [...cites].map(([key, g]) => ({ key, lines: g.lines, missing: notInBib.has(key) })),
    glyphs: [...glyphs.values()],
    warnings: [...warnings].slice(0, 15),
    overfull: (text.match(/^Overfull \\[hv]box/gm) ?? []).length,
    underfull: (text.match(/^Underfull \\[hv]box/gm) ?? []).length,
  };
}
