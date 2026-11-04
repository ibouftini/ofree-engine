import { describe, expect, it } from "vitest";
import type { DocumentResult } from "../src/compile/compile.js";
import { summaryMarkdown, type RunFacts } from "../src/report.js";

const result = (runOutput: string, bibTool: "biber" | "bibtex" | null): DocumentResult => ({
  doc: { root: "main.tex", cwd: ".", engine: "pdflatex", engineReason: "default", main: true, bibTool, shellEscape: null, languages: new Map(), locales: new Map() },
  status: "ok",
  ok: true,
  engine: "pdflatex",
  shellEscape: false,
  pdf: "main.pdf",
  pages: 1,
  seconds: 1,
  attempts: 1,
  installed: [],
  notes: [],
  findings: {},
  diagnosis: { errors: [], references: [], citations: [], glyphs: [], warnings: [], overfull: 0, underfull: 0 },
  output: runOutput,
  runOutput,
} as unknown as DocumentResult);

const facts = (r: DocumentResult, fonts: RunFacts["fonts"] = []): RunFacts => ({
  prefix: "", results: [r], phases: { compile: 1 }, provisionedFrom: "cache", release: 2026, packageCount: 1, downloadedPackages: 0, downloadedMiB: 0, fonts,
});

describe("summary", () => {
  it("names the bibliography tool that ran, not only the one the sources suggest", () => {
    expect(summaryMarkdown(facts(result("Latexmk: stuff\nRunning 'bibtex  \"main.aux\"'\n", "biber")))).toContain("bibliography: bibtex");
    expect(summaryMarkdown(facts(result("Running 'upbibtex  \"main\"'\n", "bibtex")))).toContain("bibliography: upbibtex");
    expect(summaryMarkdown(facts(result("nothing ran\n", "biber")))).toContain("bibliography: biber");
    expect(summaryMarkdown(facts(result("nothing ran\n", null)))).not.toContain("bibliography:");
  });

  it("does not call a font missing because its name was not found beforehand", () => {
    const s = summaryMarkdown(facts(result("", null), [{ name: "XITSMath-Regular", source: "missing" }, { name: "Roboto", source: "google" }]));
    expect(s).not.toContain("XITSMath");
    expect(s).toContain("Roboto (downloaded from Google Fonts)");
  });

  it("uses the singular for one PDF", () => {
    expect(summaryMarkdown(facts(result("", null)))).toContain("## ✅ Your PDF is ready");
  });
});
