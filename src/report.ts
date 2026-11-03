// The build summary (what users read) and file/line annotations.

import * as core from "@actions/core";
import { ENGINE_NAME, type DocumentResult } from "./compile/compile.js";
import { RENAMED_FONTS, type Resolution } from "./plan/resolve.js";

export interface RunFacts {
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
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/</g, "&lt;");

export function annotate(results: DocumentResult[]) {
  for (const r of results) {
    if (r.ok) continue;
    const errors = r.findings.problems.filter((p) => p.severity === "error").slice(0, 10);
    if (errors.length === 0) {
      core.error(`${r.doc.root} could not be built. See the log of this step for details.`, { file: r.doc.root });
      continue;
    }
    for (const p of errors) {
      const file = p.file ? (r.doc.cwd === "." ? p.file : `${r.doc.cwd}/${p.file}`) : r.doc.root;
      core.error(p.message, { title: `LaTeX error in ${r.doc.root}`, file, startLine: p.line });
    }
  }
}

export function summaryMarkdown(f: RunFacts): string {
  const ok = f.results.filter((r) => r.ok);
  const failed = f.results.filter((r) => !r.ok);
  const total = Object.values(f.phases).reduce((a, b) => a + b, 0);
  const lines: string[] = [];

  if (failed.length === 0) lines.push(`## ✅ Your PDFs are ready`);
  else if (ok.length === 0) lines.push(`## ❌ No document could be built`);
  else lines.push(`## ⚠️ ${failed.length} of ${f.results.length} documents could not be built`);
  lines.push("");
  lines.push(`Built in ${total.toFixed(1)} s (setting up TeX Live: ${(f.phases.provision ?? 0).toFixed(1)} s).` +
    (f.artifactUrl ? ` [Download the PDFs](${f.artifactUrl})` : ""));
  lines.push("");
  lines.push("| Document | Engine | Pages | Result | Time |");
  lines.push("|---|---|---:|---|---:|");
  for (const r of f.results) {
    const engine = `${ENGINE_NAME[r.engine]} <sub>${esc(r.engine === r.doc.engine ? r.doc.engineReason : "switched while compiling")}</sub>`;
    const result = r.ok ? `✅ ${esc(r.pdf ?? "")}` : "❌ failed";
    lines.push(`| \`${esc(r.doc.root)}\` | ${engine} | ${r.pages ?? "—"} | ${result} | ${r.seconds.toFixed(1)} s |`);
  }
  lines.push("");

  for (const r of failed) {
    const errors = r.findings.problems.filter((p) => p.severity === "error").slice(0, 5);
    lines.push(`**${esc(r.doc.root)}** — a problem in the document:`);
    if (errors.length === 0) lines.push("- No error message was found; see the log of this step.");
    for (const p of errors) lines.push(`- ${p.file ? `\`${esc(p.file)}:${p.line}\` ` : ""}${esc(p.message)}`);
    for (const m of r.findings.missing) {
      const renamed = m.kind === "font" ? RENAMED_FONTS[m.name.toLowerCase()] : undefined;
      if (renamed) lines.push(`- **Likely fix:** TeX Live now names the font "${esc(m.name)}" **"${renamed}"**. Use that name in your document.`);
      else if (m.kind === "font") lines.push(`- The font "${esc(m.name)}" is not part of TeX Live. Add its files to the repository and list them in \`extra_fonts\`.`);
    }
    lines.push("");
  }
  for (const r of ok) {
    const warnings = r.findings.problems.filter((p) => p.severity === "warning").slice(0, 5);
    if (warnings.length) {
      lines.push(`⚠️ **${esc(r.doc.root)}**: ${warnings.map((w) => esc(w.message)).join("; ")}`);
      lines.push("");
    }
  }

  lines.push("<details><summary>How this was built</summary>", "");
  lines.push(`- TeX Live ${f.release || "?"}: ${f.provisionedFrom}; ${f.packageCount} packages installed.`);
  if (f.downloadedPackages) lines.push(`- Downloaded ${f.downloadedPackages} packages (${f.downloadedMiB.toFixed(1)} MiB) from \`${f.mirror ?? "?"}\`.`);
  lines.push(`- Time: ${Object.entries(f.phases).map(([k, v]) => `${k} ${v.toFixed(1)} s`).join(" · ")}.`);
  for (const r of f.results) {
    const extra = [
      r.doc.bibTool ? `bibliography: ${r.doc.bibTool}` : "",
      r.shellEscape ? `shell escape on${r.doc.shellEscape ? ` (${esc(r.doc.shellEscape.reason)}, ${r.doc.shellEscape.file}:${r.doc.shellEscape.line})` : ""}` : "",
      r.doc.languages.size + r.doc.locales.size ? `languages: ${[...new Set([...r.doc.languages.keys(), ...r.doc.locales.keys()])].join(", ")}` : "",
      r.attempts > 1 ? `${r.attempts} attempts` : "",
      ...r.notes.map(esc),
    ].filter(Boolean);
    lines.push(`- \`${esc(r.doc.root)}\`: ${extra.join("; ") || "nothing special"}.`);
  }
  const unresolved = f.resolution?.unresolved ?? [];
  if (unresolved.length) {
    lines.push(`- Not found in TeX Live (local files elsewhere, or fonts from the system): ${unresolved.slice(0, 15).map((u) => `${esc(u.what)} (${u.ref.file}:${u.ref.line})`).join(", ")}.`);
  }
  lines.push("", "</details>");
  return lines.join("\n");
}
