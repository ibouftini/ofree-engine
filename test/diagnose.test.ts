// The logs in fixtures/logs are real: documents with the mistakes people
// make, compiled with latexmk -f in non-stop mode, as Overleaf does.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose, toolErrors, type SourceContext } from "../src/compile/diagnose.js";

const log = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "logs", name), "latin1");
const summary = (d: ReturnType<typeof diagnose>) => d.errors.map((e) => `${e.file ?? "-"}:${e.lines.join(",")} ${e.message}${e.culprit ? ` [${e.culprit}]` : ""}`);

describe("diagnose", () => {
  // Real log excerpts from a thesis class with mistakes planted in it.
  const source = (file: string, text: string): SourceContext => ({ sources: () => [{ file, text }], similarFiles: () => [] });

  it("places a missing package where the sources load it, and says TeX stopped there", () => {
    const text = [
      ") (./Preamble/preamble.tex", "", "! LaTeX Error: File `nosuchpackage.sty' not found.", "",
      "Type X to quit or <RETURN> to proceed,", "or enter new name. (Default extension: sty)", "", "Enter file name: ",
      "./Preamble/preamble.tex:22: Emergency stop.", "<read *> ", "         ", "l.22 ^^M", "        ", "No pages of output.",
    ].join("\n");
    const ctx: SourceContext = { ...source("x.tex", ""), required: (n) => (n === "nosuchpackage.sty" ? { file: "Preamble/preamble.tex", line: 19 } : undefined) };
    const d = diagnose(text, "", ctx);
    expect(summary(d)).toEqual(["Preamble/preamble.tex:19 File `nosuchpackage.sty' not found."]);
    expect(d.errors[0].hint).toContain("No TeX Live package provides");
    expect(d.stoppedEarly).toBe(true);
    expect(diagnose("./main.tex:3: Undefined control sequence.\nl.3 \\foo\n").stoppedEarly).toBe(false);
  });

  const unclosed = [
    "./A/a.tex:30: LaTeX Error: Command \\item invalid in math mode.", "",
    "See the LaTeX manual or LaTeX Companion for explanation.", "Type  H <return>  for immediate help.",
    " ...  LaTeX Error: Command \\protect \\item  invalid in math mode.^^J", "       ",
    "l.30 \\item", "          ^^ITo add a new package go to Start",
    "./A/a.tex:30: Missing $ inserted.", "<inserted text> ", "                $", "l.30 \\item^^IT", "              o add a new package",
  ].join("\n");

  it("reports math left open once, on the line that opens it", () => {
    const lines = Array.from({ length: 28 }, () => "x");
    const d = diagnose(unclosed, "", source("A/a.tex", [...lines, "\\item\tRun the installer and pay $5 for it", "\\item\tTo add a new package"].join("\n")));
    expect(summary(d)).toEqual(["A/a.tex:29 Math opened with `$` is never closed [\\item Run the installer and pay $5 for it]"]);
    expect(d.errors[0].hint).toContain("`\\$` for a dollar sign");
  });

  it("does not blame an escaped or closed $, or cross a blank line", () => {
    const at = (text: string) => summary(diagnose(unclosed, "", source("A/a.tex", `${"x\n".repeat(27)}${text}\n\\item b`)));
    expect(at("a $5\n\n\\item")).toHaveLength(1);
    for (const text of ["cost \\$5 here\nmore", "$x$ and $y$\nmore", "$5\n\nmore", "% $5 in a comment\nmore"]) {
      const s = at(text);
      expect(s).toEqual(["A/a.tex:30 Command \\item invalid in math mode."]);
    }
    expect(diagnose(unclosed).errors[0].hint).toContain("`\\item` cannot be used in math");
  });

  it("tells math outside $ from math left open", () => {
    const missing = (stopped: string, text: string) => diagnose(`./m.tex:2: Missing $ inserted.\n<inserted text> \n     $\nl.2 ${stopped}\n   rest\n`, "", source("m.tex", text)).errors[0];
    expect(missing("The error scales with x^", "a\nThe error scales with x^2").hint).toContain("outside math mode");
    expect(missing("\\end{itemize}", "pay $5\n\\end{itemize}").message).toBe("Math opened with `$` is never closed");
    expect(missing("\\end{itemize}", "pay 5\n\\end{itemize}").hint).toContain("still in math");
  });

  it("finds where undefined keys are used, in the file that has them", () => {
    const text = [
      "Package natbib Warning: Citation `Smith2099' on page 12 undefined on input line 42.", "",
      "LaTeX Warning: Reference `sec:nosuch' on page 12 undefined on input line 49.", "",
      "LaTeX Warning: Reference `multi' on page 12 undefined on input line 5.", "",
      "LaTeX Warning: Reference `elsewhere' on page 1 undefined on input line 900.", "",
    ].join("\n");
    const chapter = Array.from({ length: 60 }, () => "x");
    chapter[41] = "see \\cite{Smith2099}";
    chapter[48] = "% \\ref{sec:nosuch} old\nsee \\ref{sec:nosuch}".split("\n")[1];
    chapter[3] = "\\ref{multi}";
    chapter[10] = "\\ref{elsewhere}";
    chapter[20] = "not sec:nosuch2 or xSmith2099";
    const ctx: SourceContext = {
      sources: () => [{ file: "main.tex", text: "\\documentclass{x}\n" }, { file: "Ch/c.tex", text: chapter.join("\n") }],
      similarFiles: () => [],
    };
    const d = diagnose(text, "", ctx);
    expect(d.citations[0].places).toEqual([{ file: "Ch/c.tex", line: 42 }]);
    expect(d.references.map((r) => r.places)).toEqual([[{ file: "Ch/c.tex", line: 49 }], [{ file: "Ch/c.tex", line: 4 }], [{ file: "Ch/c.tex", line: 11 }]]);
    expect(diagnose(text).references[0].places).toBeUndefined();
  });

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

  it("names a failed conversion by its files", () => {
    expect(toolErrors("  cusdep asy pdf main-1: Command for 'cusdep asy pdf main-1' gave return code 32512", 0)[0]).toMatchObject({ source: "asy", message: "Converting main-1.asy to main-1.pdf failed" });
  });
});
