import { describe, expect, it } from "vitest";
import { filesLoadedBy } from "../src/plan/deps.js";

describe("filesLoadedBy", () => {
  it("lists packages, classes and TikZ libraries a package file loads", () => {
    const source = [
      "\\RequirePackage{pgf,verbatim}",
      "\\RequirePackage[most]{tikzfill.image}",
      "% \\RequirePackage{commented}",
      "\\LoadClass[11pt]{article}",
      "\\usetikzlibrary{fill.image, calc}",
      "\\RequirePackage{#1}",
    ].join("\n");
    expect(filesLoadedBy(source).sort()).toEqual(
      [
        "article.cls",
        "pgf.sty",
        "tikzfill.image.sty",
        "tikzlibrarycalc.code.tex",
        "tikzlibraryfill.image.code.tex",
        "verbatim.sty",
      ].sort(),
    );
  });
});
