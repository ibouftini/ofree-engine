// Compiles documents in parallel. A failed attempt is retried only when the
// engine can fix the cause itself: something missing, the wrong engine, or a
// disabled shell escape the document requires.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { DocumentPlan, Engine } from "../plan/scan.js";
import { pool, run, seconds } from "../util/exec.js";
import { parseLog, type LogFindings, type Missing } from "./logparse.js";

export interface CompileOptions {
  compiler: string;
  args: string[];
  shellEscape: "auto" | "always" | "never";
  concurrency: number;
  log?: (message: string) => void;
  /** Extra latexmk rc file (EXTRA_LATEXMKRC written to disk), loaded with -r. */
  extraRc?: string;
}

/**
 * Build steps latexmk does not know by itself. Each runs only when a document
 * produces the matching file, so the rules are safe for every build.
 */
export const EXTRA_LATEXMKRC = `# Added by ofree-engine.
# glossaries: makeglossaries for .glo (main), .acn (acronyms), .slo (symbols).
add_cus_dep('glo', 'gls', 0, 'ofree_makeglossaries');
add_cus_dep('acn', 'acr', 0, 'ofree_makeglossaries');
add_cus_dep('slo', 'sls', 0, 'ofree_makeglossaries');
sub ofree_makeglossaries {
  my ($base_name, $path) = fileparse($_[0]);
  my @args = ('-q', $base_name);
  push @args, '-d', $path if $path ne './';
  return system('makeglossaries', @args);
}
# glossaries-extra with the record option: bib2gls writes .glstex files.
add_cus_dep('aux', 'glstex', 0, 'ofree_bib2gls');
sub ofree_bib2gls {
  my ($base_name, $path) = fileparse($_[0]);
  my @args = ('--group', $base_name);
  push @args, '--dir', $path if $path ne './';
  return system('bib2gls', @args);
}
# nomencl: makeindex with the nomencl style.
add_cus_dep('nlo', 'nls', 0, 'ofree_makenomenclature');
sub ofree_makenomenclature {
  return system('makeindex', "$_[0].nlo", '-s', 'nomencl.ist', '-o', "$_[0].nls", '-t', "$_[0].nlg");
}
push @generated_exts, qw(glo gls glg acn acr alg slo sls slg glstex nlo nls nlg ist xdy);
`;

/** latexmk options that choose the output route themselves (DVI, PostScript). */
const MODE_FLAGS = /^-(pdf|pdfdvi|pdfps|pdflua|pdfxe|xelatex|lualatex|dvi|ps)$/;

/** Output directory set by -outdir/-output-directory arguments or by $out_dir in a .latexmkrc. */
export function outputDirectory(cwd: string, args: string[]): string | null {
  for (const a of args) {
    const m = /^--?(?:outdir|out-dir|output-directory)=(.+)$/.exec(a);
    if (m) return m[1];
  }
  for (const name of [".latexmkrc", "latexmkrc"]) {
    const rc = join(cwd, name);
    if (!existsSync(rc)) continue;
    const m = /^\s*\$out_dir\s*=\s*['"]([^'"]+)['"]/m.exec(readFileSync(rc, "utf8"));
    if (m) return m[1];
  }
  return null;
}

export interface Recovery {
  /** Installs what is missing; returns the packages it installed (empty if it found nothing to install). */
  installMissing(missing: Missing[]): Promise<string[]>;
  /** Makes an engine usable (binaries and format). */
  ensureEngine(engine: Engine): Promise<void>;
}

export interface DocumentResult {
  doc: DocumentPlan;
  ok: boolean;
  engine: Engine;
  shellEscape: boolean;
  /** PDF path relative to the workspace. */
  pdf: string | null;
  pages: number | null;
  seconds: number;
  attempts: number;
  installed: string[];
  notes: string[];
  findings: LogFindings;
  /** Build program output followed by the engine's .log (and .blg). */
  output: string;
  /** Build program output only. */
  runOutput: string;
}

const ENGINE_FLAG: Record<Engine, string> = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" };
const ENGINE_NAME: Record<Engine, string> = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" };
const MAX_ROUNDS = 8;

async function attempt(
  workspace: string,
  doc: DocumentPlan,
  engine: Engine,
  shellEscape: boolean,
  force: boolean,
  opts: CompileOptions,
  env: NodeJS.ProcessEnv,
) {
  const cwd = resolve(workspace, doc.cwd);
  let r;
  if (opts.compiler === "latexmk") {
    const args: string[] = [];
    if (opts.extraRc) args.push("-r", opts.extraRc);
    // Respect a route the user chose (-pdfdvi, -pdfps for PSTricks), and a .latexmkrc's engine.
    const userMode = opts.args.some((a) => MODE_FLAGS.test(a));
    if (!userMode && (!doc.engineFromLatexmkrc || engine !== doc.engine)) args.push(ENGINE_FLAG[engine]);
    args.push(...opts.args);
    if (shellEscape) args.push("-shell-escape");
    if (force) args.push("-g");
    args.push(doc.target);
    r = await run("latexmk", args, { cwd, env });
  } else {
    r = await run(opts.compiler, [...opts.args, doc.target], { cwd, env });
  }
  // The engine's own .log and BibTeX's .blg hold details latexmk does not repeat.
  const job = basename(doc.target).replace(/\.tex$/, "");
  const outDir = outputDirectory(cwd, opts.args);
  const dirs = [...new Set([outDir ? resolve(cwd, outDir) : cwd, cwd, resolve(cwd, dirname(doc.target))])];
  let output = r.output;
  for (const ext of [".log", ".blg"]) {
    const path = dirs.map((d) => join(d, job + ext)).find((p) => existsSync(p));
    if (path) output += `\n==> ${job}${ext}\n` + readFileSync(path, "latin1");
  }
  const written = /Output written on "?([^"\n(]+?)\.(?:pdf|xdv|dvi)"?\s*\(/g;
  const fromLog = [...r.output.matchAll(written)].map((m) => resolve(cwd, m[1].trim() + ".pdf"));
  const pdfAbs = [...fromLog.reverse(), ...dirs.map((d) => join(d, job + ".pdf"))].find((p) => existsSync(p));
  return { code: r.code, output, runOutput: r.output, pdf: pdfAbs ? relative(workspace, pdfAbs) : null };
}

export async function compileDocument(
  workspace: string,
  doc: DocumentPlan,
  opts: CompileOptions,
  env: () => NodeJS.ProcessEnv,
  recovery: Recovery,
): Promise<DocumentResult> {
  const start = performance.now();
  let engine = doc.engine;
  let shellEscape = opts.shellEscape === "always" || (opts.shellEscape === "auto" && doc.shellEscape !== null);
  const installed: string[] = [];
  const notes: string[] = [];
  let force = false;
  let retriedAfterFonts = false;
  const triedEngines = new Set<Engine>([engine]);
  let last!: Awaited<ReturnType<typeof attempt>>;
  let findings!: LogFindings;
  let rounds = 0;

  while (rounds < MAX_ROUNDS) {
    rounds++;
    last = await attempt(workspace, doc, engine, shellEscape, force, opts, env());
    findings = parseLog(last.output);
    opts.log?.(
      `${doc.root}: attempt ${rounds} with ${ENGINE_NAME[engine]}${shellEscape ? " (shell escape)" : ""}: exit ${last.code}, ` +
        `pdf ${last.pdf ?? "none"}; missing [${findings.missing.map((m) => `${m.kind}:${m.name}`).join(", ")}]` +
        (findings.needsUnicodeEngine ? `; needs ${findings.needsUnicodeEngine}` : "") +
        (findings.needsShellEscape ? "; asks for shell escape" : ""),
    );
    if (last.code === 0 && last.pdf) break;

    if (findings.missing.length > 0) {
      const got = await recovery.installMissing(findings.missing);
      opts.log?.(`${doc.root}: installed for missing files: [${got.join(", ")}]`);
      if (got.length > 0) {
        installed.push(...got);
        notes.push(`Installed ${got.join(", ")}, found missing while compiling`);
        force = true;
        continue;
      }
    }
    const needed = findings.needsUnicodeEngine;
    const next: Engine | null = needed === "either" ? (engine === "pdflatex" ? "xelatex" : null) : needed !== engine ? needed : null;
    if (next && !triedEngines.has(next)) {
      triedEngines.add(next);
      engine = next;
      notes.push(`Switched to ${ENGINE_NAME[engine]}: ${needed === "either" ? "the document needs a Unicode engine" : `the document works only with ${ENGINE_NAME[engine]}`}`);
      await recovery.ensureEngine(engine);
      force = true;
      continue;
    }
    if (findings.generatedFonts > 0 && !retriedAfterFonts) {
      retriedAfterFonts = true;
      notes.push(`Generated ${findings.generatedFonts} font file(s) with METAFONT, then compiled again`);
      force = true;
      continue;
    }
    if (findings.needsShellEscape && !shellEscape && opts.shellEscape === "auto") {
      shellEscape = true;
      notes.push("Enabled shell escape: the document asked for it");
      force = true;
      continue;
    }
    break;
  }

  return {
    doc,
    ok: last.code === 0 && last.pdf !== null,
    engine,
    shellEscape,
    pdf: last.pdf,
    pages: findings.pages,
    seconds: seconds(start),
    attempts: rounds,
    installed,
    notes,
    findings,
    output: last.output,
    runOutput: last.runOutput,
  };
}

export async function compileAll(
  workspace: string,
  docs: DocumentPlan[],
  opts: CompileOptions,
  env: () => NodeJS.ProcessEnv,
  recovery: Recovery,
): Promise<DocumentResult[]> {
  const results = await pool(docs, opts.concurrency, (doc) => compileDocument(workspace, doc, opts, env, recovery));
  // A document may use another's output (a figure built as its own document).
  // Built in parallel it can start too early, so retry failures one by one, in
  // order, once everything else is done.
  if (results.some((r) => r.ok) && results.some((r) => !r.ok)) {
    for (let i = 0; i < results.length; i++) {
      if (results[i].ok) continue;
      opts.log?.(`${docs[i].root}: building again after the other documents`);
      const again = await compileDocument(workspace, docs[i], opts, env, recovery);
      if (again.ok) {
        again.notes.unshift("Built after the other documents, whose output it uses");
        results[i] = again;
      }
    }
  }
  return results;
}

export { ENGINE_NAME };
