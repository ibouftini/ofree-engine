// Compiles documents in parallel. A failed attempt is retried only when the
// engine can fix the cause itself: something missing, the wrong engine, or a
// disabled shell escape the document requires.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { DocumentPlan, Engine } from "../plan/scan.js";
import { pool, run, seconds } from "../util/exec.js";
import { parseLog, type LogFindings, type Missing } from "./logparse.js";

export interface CompileOptions {
  compiler: string;
  args: string[];
  shellEscape: "auto" | "always" | "never";
  concurrency: number;
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
  output: string;
}

const ENGINE_FLAG: Record<Engine, string> = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" };
const ENGINE_NAME: Record<Engine, string> = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" };
const MAX_ROUNDS = 5;

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
    if (!doc.engineFromLatexmkrc || engine !== doc.engine) args.push(ENGINE_FLAG[engine]);
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
  let output = r.output;
  for (const ext of [".log", ".blg"]) {
    const path = join(cwd, job + ext);
    if (existsSync(path)) output += `\n==> ${job}${ext}\n` + readFileSync(path, "latin1");
  }
  const pdfAbs = join(cwd, job + ".pdf");
  return { code: r.code, output, pdf: existsSync(pdfAbs) ? relative(workspace, pdfAbs) : null };
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
  let last!: Awaited<ReturnType<typeof attempt>>;
  let findings!: LogFindings;
  let rounds = 0;

  while (rounds < MAX_ROUNDS) {
    rounds++;
    last = await attempt(workspace, doc, engine, shellEscape, force, opts, env());
    findings = parseLog(last.output);
    if (last.code === 0 && last.pdf) break;

    if (findings.missing.length > 0) {
      const got = await recovery.installMissing(findings.missing);
      if (got.length > 0) {
        installed.push(...got);
        notes.push(`Installed ${got.join(", ")}, found missing while compiling`);
        force = true;
        continue;
      }
    }
    if (findings.needsUnicodeEngine && engine === "pdflatex") {
      engine = findings.needsUnicodeEngine;
      notes.push(`Switched to ${ENGINE_NAME[engine]}: the document needs a Unicode engine`);
      await recovery.ensureEngine(engine);
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
  };
}

export function compileAll(
  workspace: string,
  docs: DocumentPlan[],
  opts: CompileOptions,
  env: () => NodeJS.ProcessEnv,
  recovery: Recovery,
): Promise<DocumentResult[]> {
  return pool(docs, opts.concurrency, (doc) => compileDocument(workspace, doc, opts, env, recovery));
}

export { ENGINE_NAME };
