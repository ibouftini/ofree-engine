import { describe, expect, it } from "vitest";
import { parseLog } from "../src/compile/logparse.js";

describe("parseLog", () => {
  it("finds missing packages, styles and fonts", () => {
    const f = parseLog(
      [
        "! LaTeX Error: File `siunitx.sty' not found.",
        "I couldn't open style file ieeetr.bst",
        '! Package fontspec Error: The font "Amiri" cannot be found.',
        "! Font \\T1/cmr/m/n/10=ecrm1000 at 10.0pt not loadable: Metric (TFM) file not found.",
      ].join("\n"),
    );
    expect(f.missing).toEqual([
      { kind: "file", name: "siunitx.sty" },
      { kind: "file", name: "ieeetr.bst" },
      { kind: "font", name: "Amiri" },
      { kind: "file", name: "ecrm1000.tfm" },
    ]);
  });

  it("detects documents that need a Unicode engine", () => {
    expect(parseLog("! Fatal Package fontspec Error: The fontspec package requires either XeTeX or\n(fontspec) LuaTeX.").needsUnicodeEngine).toBe(
      "xelatex",
    );
    expect(parseLog("! Package luatexja Error: This package requires LuaTeX.").needsUnicodeEngine).toBe("lualatex");
  });

  it("reports errors with file and line, and the page count", () => {
    const f = parseLog(
      ["./chapters/intro.tex:12: Undefined control sequence.", "Output written on main.pdf (14 pages, 1234 bytes)."].join("\n"),
    );
    expect(f.problems[0]).toEqual({ severity: "error", file: "chapters/intro.tex", line: 12, message: "Undefined control sequence." });
    expect(f.pages).toBe(14);
  });

  it("asks for shell escape when minted says so", () => {
    expect(parseLog("Package minted Error: You must invoke LaTeX with the -shell-escape flag.").needsShellEscape).toBe(true);
  });
});
