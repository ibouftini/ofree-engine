import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentResult } from "../src/compile/compile.js";
import { digestText, fatalMarkdown, summaryMarkdown, type RunFacts } from "../src/report.js";

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
  diagnosis: { errors: [], stoppedEarly: false, references: [], citations: [], glyphs: [], warnings: [], overfull: 0, underfull: 0 },
  output: runOutput,
  runOutput,
} as unknown as DocumentResult);

const facts = (r: DocumentResult, fonts: RunFacts["fonts"] = []): RunFacts => ({
  prefix: "", results: [r], phases: { compile: 1 }, provisionedFrom: "cache", release: 2026, packageCount: 1, downloadedPackages: 0, downloadedMiB: 0, fonts,
});

describe("summary", () => {
  // On a runner these turn file names into links.
  beforeEach(() => {
    vi.stubEnv("GITHUB_SERVER_URL", "");
    vi.stubEnv("GITHUB_REPOSITORY", "");
    vi.stubEnv("GITHUB_SHA", "");
  });

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

  it("says where undefined keys are used, and when TeX stopped early", () => {
    const r = result("", null);
    r.diagnosis = { ...r.diagnosis, stoppedEarly: true, references: [{ key: "sec:x", lines: [49], places: [{ file: "Ch/c.tex", line: 49 }] }], citations: [{ key: "Smith", lines: [42], missing: true, places: [{ file: "Ch/c.tex", line: 42 }, { file: "Ch/d.tex", line: 7 }] }] };
    r.status = "failed";
    const s = summaryMarkdown(facts(r));
    expect(s).toContain("`sec:x` at `Ch/c.tex:49`");
    expect(s).toContain("`Smith` (not in the .bib files) at `Ch/c.tex:42` and 1 more");
    expect(s).toContain("TeX stopped at this error, so the rest of the document was not checked. Fixing it may show more errors, and there is no PDF until then.");
    expect(s).toContain("Stopped after 1.0 s");
    expect(digestText(r, "")).toContain("Smith (not in the .bib files) at Ch/c.tex:42, Ch/d.tex:7");
  });

  it("links those places on a runner", () => {
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
    vi.stubEnv("GITHUB_REPOSITORY", "o/r");
    vi.stubEnv("GITHUB_SHA", "abc");
    const r = result("", null);
    r.diagnosis = { ...r.diagnosis, references: [{ key: "sec:x", lines: [49], places: [{ file: "Ch/c.tex", line: 49 }] }] };
    expect(summaryMarkdown(facts(r))).toContain("`sec:x` at [`Ch/c.tex:49`](https://github.com/o/r/blob/abc/Ch/c.tex#L49)");
  });

  it("explains the red mark on a build that gave a PDF, unless on_error lets it pass", () => {
    const r = result("", null);
    r.status = "errors";
    expect(summaryMarkdown({ ...facts(r), onError: "fail" })).toContain("add `on_error: warn`");
    expect(summaryMarkdown({ ...facts(r), onError: "warn" })).not.toContain("on_error");
  });

  it("turns TeX's quotes into code, so that a backtick does not swallow what follows", () => {
    const r = result("", null);
    r.status = "errors";
    r.diagnosis = {
      ...r.diagnosis,
      errors: [{ message: "File `nosuch.sty' not found.", lines: [1], file: "main.tex", hint: "No package provides `nosuch.sty`." }, { message: "Undefined control sequence.", culprit: "\\foo", lines: [2], file: "main.tex" }],
      warnings: ["Font `x' is odd"],
    };
    const s = summaryMarkdown(facts(r));
    expect(s).toContain("**File `nosuch.sty` not found**");
    expect(s).toContain("**Undefined control sequence: `\\foo`**");
    expect(s).toContain("Font `x` is odd");
    expect(digestText(r, "")).toContain("File `nosuch.sty` not found");
  });

  it("uses the singular for one PDF", () => {
    expect(summaryMarkdown(facts(result("", null)))).toContain("## ✅ Your PDF is ready");
  });
});

describe("fatalMarkdown", () => {
  it("states the problem and what to try", () => {
    const text = fatalMarkdown("No TeX Live repository answered: a (ENOTFOUND)", "Re-run the job.");
    expect(text).toContain("## ❌ The build stopped");
    expect(text).toContain("**No TeX Live repository answered: a (ENOTFOUND)**");
    expect(text).toContain("Re-run the job.");
  });
});
