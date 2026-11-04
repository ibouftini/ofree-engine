// The build summary (what users read) and file/line annotations.

import * as core from "@actions/core";
import { posix } from "node:path";
import { ENGINE_NAME, type DocumentResult } from "./compile/compile.js";
import type { Issue, Place } from "./compile/diagnose.js";
import type { FontOutcome } from "./fonts.js";
import type { Resolution } from "./plan/resolve.js";

export interface RunFacts {
  /** The working directory relative to the repository ("" for its root). */
  prefix: string;
  results: DocumentResult[];
  phases: Record<string, number>;
  provisionedFrom: string;
  release: number;
  packageCount: number;
  downloadedPackages: number;
  downloadedMiB: number;
  mirror?: string;
  resolution?: Resolution;
  artifactUrl?: string;
  /** How the main documents were chosen. */
  mainReason?: string;
  /** Whether LaTeX errors fail the step. */
  onError?: "fail" | "warn";
  /** Fonts that are not in TeX Live, and where they came from. */
  fonts?: FontOutcome[];
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/</g, "&lt;");
/** Inline code that survives backticks in the text. */
const code = (s: string) => (s.includes("`") ? `\`\` ${s.replace(/\n/g, " ")} \`\`` : `\`${s.replace(/\n/g, " ")}\``);
const plain = (s: string) => s.replace(/\*\*/g, "");

/** Path of a file the log names (relative to the compile directory), relative to the repository. */
const repoPath = (r: DocumentResult, file: string, prefix: string) => posix.normalize(posix.join(prefix || ".", r.doc.cwd, file));

function sourceLink(path: string, line?: number): string {
  const label = code(line ? `${path}:${line}` : path);
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = process.env;
  return server && repo && sha ? `[${label}](${server}/${repo}/blob/${sha}/${path}${line ? `#L${line}` : ""})` : label;
}

/** TeX quotes as `name'; in Markdown the lone backtick would open a code span and swallow what follows. */
const texQuotes = (s: string) => s.replace(/`([^`'\n]*)'/g, "`$1`");

/** "Undefined control sequence: `\foo`" or "Missing $ inserted, near `x^`". */
function describe(e: Issue): string {
  const message = texQuotes(e.message.replace(/\.$/, ""));
  if (!e.culprit) return message;
  return /^Undefined control sequence|Environment/.test(e.message) ? `${message}: ${code(e.culprit)}` : `${message}, near ${code(e.culprit)}`;
}

/** Errors become workflow annotations on the file and line (warnings when the step is not to fail on them). */
export function annotate(results: DocumentResult[], onError: "fail" | "warn", prefix: string) {
  for (const r of results) {
    // Undefined keys print ?? or [?] in the PDF of an otherwise fine build, so they are marked on their lines too.
    const keys = r.doc.main ? [["reference", r.diagnosis.references], ["citation", r.diagnosis.citations]] as const : [];
    for (const [what, items] of keys) {
      for (const x of items.slice(0, 5)) {
        const at = x.places?.[0];
        if (at) core.warning(`Undefined ${what}: ${x.key}`, { title: `Undefined ${what}`, file: repoPath(r, at.file, prefix), startLine: at.line });
      }
    }
    if (r.status === "ok") continue;
    const report = !r.doc.main || (r.status === "errors" && onError === "warn") ? core.warning : core.error;
    const errors = r.diagnosis.errors.slice(0, 10);
    if (errors.length === 0) {
      report(`${r.doc.root} could not be built.${r.doc.main ? "" : " It is not the main document, so the build does not fail."} See the log of this step for details.`, { file: posix.join(prefix || ".", r.doc.root) });
      continue;
    }
    for (const e of errors) {
      const text = describe(e) + (e.hint ? `\n${plain(e.hint)}` : "");
      const file = e.file ? repoPath(r, e.file, prefix) : posix.join(prefix || ".", r.doc.root);
      report(text, { title: r.doc.main ? "LaTeX error" : `LaTeX error in ${r.doc.root} (not the main document)`, file, startLine: e.file ? e.lines[0] : undefined });
    }
  }
}

/** The same digest as the summary, as plain text for the step's log. */
export function digestText(r: DocumentResult, prefix: string): string {
  const d = r.diagnosis;
  const out: string[] = [];
  const head = r.status === "ok" ? "built" : r.status === "errors" ? `PDF built through ${d.errors.length} LaTeX error(s)` : "could not be built";
  out.push(`${r.doc.root}: ${head}`);
  for (const e of d.errors.slice(0, 15)) {
    const where = e.file ? `${repoPath(r, e.file, prefix)}:${e.lines.join(",")}` : e.source ? `(${e.source})` : "";
    out.push(`  ✗ ${where} ${describe(e)}`.trimEnd());
    if (e.hint) out.push(`      ${plain(e.hint)}`);
  }
  const at = (x: { places?: Place[] }) => (x.places?.length ? ` at ${x.places.map((p) => `${repoPath(r, p.file, prefix)}:${p.line}`).join(", ")}` : "");
  if (d.stoppedEarly) out.push(`  TeX stopped here, so the rest of the document was not checked.`);
  if (d.references.length) out.push(`  ! Undefined references: ${d.references.map((x) => x.key + at(x)).join(", ")}`);
  if (d.citations.length) out.push(`  ! Undefined citations: ${d.citations.map((x) => x.key + (x.missing ? " (not in the .bib files)" : "") + at(x)).join(", ")}`);
  for (const g of d.glyphs) out.push(`  ! The font ${g.font} has no ${g.char} (${g.count}×, blank in the PDF)`);
  return out.join("\n");
}

function documentSection(r: DocumentResult, prefix: string): string[] {
  const d = r.diagnosis;
  const lines: string[] = [];
  const n = d.errors.length;
  if (r.status !== "ok") {
    lines.push(`### ${code(r.doc.root)}${r.doc.main ? "" : " (not the main document)"}: ${r.status === "errors" ? `PDF built through ${n} error${n === 1 ? "" : "s"}` : "no PDF"}`, "");
    if (n === 0) lines.push("No LaTeX error message was found; see the log of this step.", "");
    d.errors.slice(0, 10).forEach((e, i) => {
      const where = e.file ? sourceLink(repoPath(r, e.file, prefix), e.lines[0]) + (e.lines.length > 1 ? ` (also line${e.lines.length > 2 ? "s" : ""} ${e.lines.slice(1, 6).join(", ")})` : "") : e.source ? `in ${code(e.source)}` : "";
      lines.push(`${i + 1}. ${where}${where ? " — " : ""}**${esc(describe(e))}**`);
      if (e.hint) lines.push(`   <br>${esc(e.hint)}`);
    });
    if (n > 10) lines.push(`\n…and ${n - 10} more in the log of this step.`);
    lines.push("");
    if (d.stoppedEarly) lines.push(`TeX stopped at this error, so the rest of the document was not checked. Fixing it may show more errors${r.status === "failed" ? ", and there is no PDF until then" : ""}.`, "");
  }
  const notes: string[] = [];
  const at = (x: { places?: Place[] }) => {
    if (!x.places?.length) return "";
    const [first, ...rest] = x.places;
    return ` at ${sourceLink(repoPath(r, first.file, prefix), first.line)}${rest.length ? ` and ${rest.length} more` : ""}`;
  };
  if (d.references.length) notes.push(`**Undefined references** (\`??\` in the PDF): ${d.references.slice(0, 10).map((x) => code(x.key) + at(x)).join(", ")}`);
  if (d.citations.length) {
    notes.push(`**Undefined citations**: ${d.citations.slice(0, 10).map((x) => code(x.key) + (x.missing ? " (not in the .bib files)" : "") + at(x)).join(", ")}`);
  }
  if (d.glyphs.length) notes.push(`**Characters the font lacks** (blank in the PDF): ${d.glyphs.slice(0, 8).map((g) => `${esc(g.char)} in ${esc(g.font)} (${g.count}×)`).join(", ")}`);
  if (notes.length) {
    if (r.status === "ok") lines.push(`### ${code(r.doc.root)}: built, with warnings`, "");
    lines.push(...notes.map((x) => `- ${x}`), "");
  }
  const other = d.warnings.map((w) => esc(texQuotes(w)));
  if (d.overfull + d.underfull) other.push(`${d.overfull} overfull and ${d.underfull} underfull boxes (text sticking out of, or spread across, a line)`);
  if (other.length) lines.push(`<details><summary>Other warnings in ${code(r.doc.root)} (${other.length})</summary>`, "", ...other.map((w) => `- ${w}`), "", "</details>", "");
  return lines;
}

/** The tool that ran, as latexmk reports it, or else the one the sources call for. */
function bibliographyTool(r: DocumentResult): string | null {
  return /^Running '(\S*bib\S*|biber)\b/m.exec(r.runOutput)?.[1] ?? r.doc.bibTool;
}

export function summaryMarkdown(f: RunFacts): string {
  // The headline is about the main documents; the others are listed below it.
  const mains = f.results.filter((r) => r.doc.main);
  const failed = mains.filter((r) => r.status === "failed");
  const withErrors = mains.filter((r) => r.status === "errors");
  const total = Object.values(f.phases).reduce((a, b) => a + b, 0);
  const lines: string[] = [];

  if (failed.length === mains.length) lines.push(`## ❌ ${mains.length > 1 ? "No document could be built" : `${mains[0].doc.root} could not be built`}`);
  else if (failed.length) lines.push(`## ❌ ${failed.length} of ${mains.length} documents could not be built`);
  else if (withErrors.length) lines.push(`## ⚠️ PDF${mains.length > 1 ? "s" : ""} built, with LaTeX errors to fix`);
  else lines.push(`## ✅ Your PDF${f.results.length > 1 ? "s are" : " is"} ready`);
  lines.push("");
  if (withErrors.length && !failed.length && f.onError === "fail") {
    lines.push("The step is marked as failed so that the errors get noticed. To let it pass while they remain, add `on_error: warn` to the workflow.", "");
  }
  const othersFailed = f.results.filter((r) => !r.doc.main && r.status !== "ok");
  if (othersFailed.length) {
    lines.push(`The main document${mains.length > 1 ? "s were" : " was"} chosen because ${f.mainReason ?? "it is marked"}. ${othersFailed.length} other document${othersFailed.length > 1 ? "s have" : " has"} problems, listed below; they do not fail the build.`, "");
  } else if (f.mainReason === "no main document is marked, so all count") {
    lines.push(`Several documents were found and none is marked as the main one, so each must build. To build only one, set \`root_file\`, or start the files it includes with \`% !TeX root = main.tex\`.`, "");
  }
  lines.push(`${failed.length === mains.length ? "Stopped after" : "Built in"} ${total.toFixed(1)} s (setting up TeX Live: ${(f.phases.provision ?? 0).toFixed(1)} s).` +
    (f.artifactUrl ? ` [Download the PDF${f.results.length > 1 ? "s" : ""}](${f.artifactUrl})` : ""));
  lines.push("");
  lines.push("| Document | Engine | Pages | Result | Time |");
  lines.push("|---|---|---:|---|---:|");
  for (const r of f.results) {
    const engine = `${ENGINE_NAME[r.engine]} <sub>${esc(r.engine === r.doc.engine ? r.doc.engineReason : "switched while compiling")}</sub>`;
    const n = r.diagnosis.errors.length;
    const result = r.status === "ok" ? `✅ ${esc(r.pdf ?? "")}` : r.status === "errors" ? `⚠️ ${esc(r.pdf ?? "")}, ${n} error${n === 1 ? "" : "s"}` : "❌ no PDF";
    const role = mains.length < f.results.length ? (r.doc.main ? " <sub>main</sub>" : " <sub>also built</sub>") : "";
    lines.push(`| \`${esc(r.doc.root)}\`${role} | ${engine} | ${r.pages ?? "—"} | ${result} | ${r.seconds.toFixed(1)} s |`);
  }
  lines.push("");
  const substituted = (f.fonts ?? []).filter((x) => x.source === "substitute");
  for (const x of substituted) {
    lines.push(`> [!WARNING]`, `> **${esc(x.name)}** cannot be downloaded, so **${esc(x.family ?? "")}** is used instead. ${esc(x.note ?? "")} To use ${esc(x.name)} itself, add its font files to the repository.`, "");
  }
  for (const r of f.results) lines.push(...documentSection(r, f.prefix));

  lines.push("<details><summary>How this was built</summary>", "");
  lines.push(`- TeX Live ${f.release || "?"}: ${f.provisionedFrom}; ${f.packageCount} packages in all.`);
  if (f.downloadedPackages) lines.push(`- Downloaded ${f.downloadedPackages} packages (${f.downloadedMiB.toFixed(1)} MiB) from \`${f.mirror ?? "?"}\`.`);
  lines.push(`- Time: ${Object.entries(f.phases).map(([k, v]) => `${k} ${v.toFixed(1)} s`).join(" · ")}.`);
  for (const r of f.results) {
    const extra = [
      bibliographyTool(r) ? `bibliography: ${bibliographyTool(r)}` : "",
      r.shellEscape ? `shell escape on${r.doc.shellEscape ? ` (${esc(r.doc.shellEscape.reason)}, ${r.doc.shellEscape.file}:${r.doc.shellEscape.line})` : ""}` : "",
      r.doc.languages.size + r.doc.locales.size ? `languages: ${[...new Set([...r.doc.languages.keys(), ...r.doc.locales.keys()])].join(", ")}` : "",
      r.attempts > 1 ? `${r.attempts} attempts` : "",
      ...r.notes.map(esc),
    ].filter(Boolean);
    lines.push(`- \`${esc(r.doc.root)}\`: ${extra.join("; ") || "nothing special"}.`);
  }
  const SOURCE: Record<FontOutcome["source"], string> = {
    repository: "from the repository",
    google: "downloaded from Google Fonts",
    microsoft: "downloaded from Microsoft (core fonts for the web, under Microsoft's licence)",
    substitute: "replaced by a metric-compatible font",
    missing: "",
  };
  // A name not found beforehand is no verdict: TeX may know it otherwise, and if it does not, the font is an error above.
  const fontsUsed = (f.fonts ?? []).filter((x) => x.source !== "missing").map((x) => `${esc(x.name)} (${SOURCE[x.source]}${x.family ? `: ${esc(x.family)}` : ""})`);
  if (fontsUsed.length) lines.push(`- Fonts not in TeX Live: ${fontsUsed.join(", ")}.`);
  const provided = new Set((f.fonts ?? []).filter((x) => x.source !== "missing").map((x) => `font "${x.name}"`));
  const unresolved = (f.resolution?.unresolved ?? []).filter((u) => !provided.has(u.what));
  if (unresolved.length) {
    lines.push(`- Not found in TeX Live (local files elsewhere, or fonts from the system): ${unresolved.slice(0, 15).map((u) => `${esc(u.what)} (${u.ref.file}:${u.ref.line})`).join(", ")}.`);
  }
  lines.push("", "</details>");
  return lines.join("\n");
}
