// The logs in fixtures/logs are real: documents with the mistakes people
// make, compiled with latexmk -f in non-stop mode, as Overleaf does.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose, toolErrors, type SourceContext } from "../src/compile/diagnose.js";

const log = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "logs", name), "latin1");
const summary = (d: ReturnType<typeof diagnose>) => d.errors.map((e) => `${e.file ?? "-"}:${e.lines.join(",")} ${e.message}${e.culprit ? ` [${e.culprit}]` : ""}`);

describe("diagnose", () => {
  it("lists each real error once, with where TeX stopped, and folds the errors that follow from it", () => {
    const ctx: SourceContext = { sources: () => [], similarFiles: (n) => (n === "figures/missing.png" ? ["figures/Missing.PNG"] : []) };
    const d = diagnose(log("overleaf-errors.log"), log("overleaf-errors.blg"), ctx);
    expect(summary(d)).toEqual([
      "main.tex:12 Undefined control sequence. [\\mycommand]",
      // The second "Missing $ inserted" (TeX ending the math it started at line 13) is folded.
      "main.tex:13 Missing $ inserted. [A formula without dollars: x^]",
      "chapters/one.tex:2 Undefined control sequence. [\\unknownmacro]",
      "chapters/one.tex:5 \\begin{center} on input line 3 ended by \\end{centre}.",
      "main.tex:16 File `figures/missing.png' not found: using draft setting.",
      "main.tex:20 Extra alignment tab has been changed to \\cr. [a & b &]",
      "main.tex:24 Something's wrong--perhaps a missing \\item.",
      "main.tex:30 Unicode character ★ (U+2605) not set up for use with LaTeX. [Unicode outside the font: ★]",
      "main.tex:30 Unicode character 中 (U+4E2D) not set up for use with LaTeX. [Unicode outside the font: ★ and 中]",
    ]);
    expect(d.errors[0].hint).toContain("`\\mycommand` is not defined");
    expect(d.errors[4].hint).toContain("but there is `figures/Missing.PNG`");
    // Only the last pass counts: knuth84 was undefined until Biber ran.
    expect(d.references).toEqual([{ key: "sec:missing", lines: [12] }]);
    expect(d.citations).toEqual([{ key: "nobody99", lines: [12], missing: true }]);
    expect(d.overfull).toBe(1);
    expect(d.warnings).toEqual(["No \\author given."]);
  });

  it("names the package a missing environment needs, and drops the errors inside it", () => {
    const d = diagnose(log("xelatex-glyphs.log"), log("bibtex-syntax.blg"));
    expect(summary(d)).toEqual([
      "main.tex:8 Undefined color `mycolour'.",
      "main.tex:8 Misplaced alignment tab character &. [\\textcolor{mycolour}{coloured} text, R&]",
      "main.tex:9 Environment align undefined.",
      "refs.bib:2 I was expecting a `,' or a `}' [@article{broken, author={B. Author}]",
    ]);
    expect(d.errors[2].hint).toContain("`\\usepackage{amsmath}`");
    expect(d.errors[3].source).toBe("BibTeX");
    // XeTeX breaks this line at 79 characters, which are 81 bytes.
    expect(d.glyphs).toEqual([{ char: "⌘ (U+2318)", font: "LibertinusSerif-Regular.otf", count: 3 }]);
    expect(d.warnings).toContain("Font LibertinusSerif-Regular.otf has no bold: the regular shape is used instead");
  });

  it("reports a font that cannot be found once, not the hundreds of characters it then lacks", () => {
    const d = diagnose(log("font-not-found.log"));
    expect(d.errors[0]).toMatchObject({ file: "main.tex", lines: [4], source: "fontspec", message: 'The font "Libertinus Serif" cannot be found.' });
    expect(d.errors.filter((e) => /cannot be found|not loadable/.test(e.message))).toHaveLength(1);
    expect(d.glyphs).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it("finds the line of a missing closing brace from the text TeX quotes", () => {
    const sources = () => [{ file: "main.tex", text: "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nSome \\textbf{bold text that never closes.\n" }];
    const d = diagnose(log("runaway.log"), "", { sources, similarFiles: () => [] });
    expect(d.errors).toHaveLength(1);
    expect(d.errors[0]).toMatchObject({ file: "main.tex", lines: [4], message: "File ended while scanning use of \\textbf." });
    expect(d.errors[0].hint).toContain("a closing brace `}` is missing");
  });

  it("reports dvipdfmx stopping on a font without a map entry, which the .log does not show", () => {
    // From a Japanese thesis built with upLaTeX before the kanji font maps were generated.
    const output = [
      'dvipdfmx:warning: Could not locate a virtual/physical font for TFM "upgbm-h".',
      "dvipdfmx:warning: >> There are no valid font mapping entry for this font.",
      'dvipdfmx:fatal: Cannot proceed without .vf or "physical" font for PDF output...',
      "No output PDF file written.",
      "Collected error summary (may duplicate other messages):",
      "  dvipdf: Command for 'dvipdf' gave return code 256",
    ].join("\n");
    const [e, ...rest] = toolErrors(output, 0);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ source: "dvipdfmx", culprit: "upgbm-h", message: 'Cannot proceed without .vf or "physical" font for PDF output...' });
    expect(e.hint).toContain("Japanese font maps");
    // Another failed rule, with no TeX error to explain it.
    expect(toolErrors("  makeindex main: Command for 'makeindex main' gave return code 1", 0)[0]).toMatchObject({ source: "makeindex", message: "makeindex main failed (exit code 1)" });
    expect(toolErrors("  makeindex main: Command for 'makeindex main' gave return code 1", 2)).toEqual([]);
  });

  it("reports a .latexmkrc that does not compile", () => {
    const output = ["Latexmk: Initialization file '/home/runner/repo/.latexmkrc' gave an error:", '     syntax error at (eval 9) line 29, near ""asy -o "$_"', "Latexmk: Stopping because of problem with rc file"].join("\n");
    const [e] = toolErrors(output, 0);
    expect(e).toMatchObject({ source: "latexmk", message: 'syntax error at (eval 9) line 29, near ""asy -o "$_"' });
    expect(e.hint).toContain(".latexmkrc has a Perl error");
  });
});
