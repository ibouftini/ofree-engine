import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRA_LATEXMKRC, similarFiles, writeStub } from "../src/compile/compile.js";
import { missingFile } from "../src/compile/diagnose.js";

describe("files that exist nowhere", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "ofree-test-"));

  it("gets a stand-in package that accepts any option, or an empty input file", () => {
    const d = dir();
    expect(writeStub(d, "nosuch.sty")).toBe(true);
    expect(readFileSync(join(d, "nosuch.sty"), "utf8")).toContain("\\ProvidesPackage{nosuch}");
    expect(readFileSync(join(d, "nosuch.sty"), "utf8")).toContain("\\DeclareOption*{}");
    expect(writeStub(d, "chapters/one.tex")).toBe(true);
    expect(readFileSync(join(d, "chapters/one.tex"), "utf8")).toMatch(/^%/);
  });

  it("does not replace classes, other kinds of file, or write outside its folder", () => {
    const d = dir();
    for (const name of ["nosuch.cls", "figure.png", "nosuch.bst", "../outside.tex", "a/../../outside.sty", "/tmp/ofree-outside.tex"]) expect(writeStub(d, name)).toBe(false);
    expect(existsSync(join(d, "..", "outside.tex"))).toBe(false);
  });

  it("stays an error, at the line that loads it, saying the PDF lacks it", () => {
    const ctx = { sources: () => [], similarFiles: () => [], required: () => ({ file: "Preamble/preamble.tex", line: 19 }) };
    const i = missingFile("nosuch.sty", ctx);
    expect(i).toMatchObject({ message: "File `nosuch.sty' not found", file: "Preamble/preamble.tex", lines: [19] });
    expect(i.hint).toContain("No TeX Live package provides");
    expect(i.hint).toContain("built without it, so what it defines is listed as undefined");
    expect(missingFile("one.tex", ctx).hint).toContain("The PDF was built without this file.");
  });

  it("suggests a file with nearly the same name, after any better match", () => {
    const d = dir();
    mkdirSync(join(d, "Figs"));
    for (const f of ["Figs/minion.eps", "Figs/min.eps", "Figs/other.png"]) writeFileSync(join(d, f), "");
    expect(similarFiles(d, "minion_final")).toEqual(["Figs/minion.eps"]);
    writeFileSync(join(d, "Figs/minion_final.png"), "");
    expect(similarFiles(d, "minion_final")).toEqual(["Figs/minion_final.png"]);
    expect(similarFiles(d, "unrelated")).toEqual([]);
  });
});

describe("the latexmk rules this action adds", () => {
  it("are valid Perl: an error in them stops every build", () => {
    const r = spawnSync("perl", ["-c"], { input: EXTRA_LATEXMKRC, encoding: "utf8" });
    expect(r.stderr).toContain("syntax OK");
  });
});
