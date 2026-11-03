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

  it("finds missing files in pdfTeX, isodate-style and newer font errors", () => {
    const f = parseLog(
      [
        "!pdfTeX error: pdflatex (file uhvb8a.pfb): cannot open Type 1 font file for reading",
        "! Package isodate.sty Error: Package file substr.sty not found.",
        "! Font OML/zplm/m/it/8=zplmr7m at 8.0pt not loadable: Metric (TFM) file not found.",
        'luaotfload | db : Reload initiated (formats: otf,ttf,ttc); reason: Font "Fira Sans Light" not found.',
      ].join("\n"),
    );
    expect(f.missing).toEqual(
      expect.arrayContaining([
        { kind: "file", name: "uhvb8a.pfb" },
        { kind: "file", name: "substr.sty" },
        { kind: "file", name: "zplmr7m.tfm" },
        { kind: "font", name: "Fira Sans Light" },
      ]),
    );
  });

  it("reads wrapped babel and fontenc messages", () => {
    const f = parseLog(
      [
        "./mthesis.cls:12: Package babel Error: Unknown option `russian'. Either you misspelled it",
        "(babel)                or the language definition file russian.ldf was not found.",
        "",
        "./mthesis.cls:14: Package fontenc Error: Encoding file `t2aenc.def' not found.",
        "(fontenc)                You might have misspelt the name of the encoding.",
      ].join("\n"),
    );
    expect(f.missing).toEqual(
      expect.arrayContaining([
        { kind: "file", name: "russian.ldf" },
        { kind: "file", name: "t2aenc.def" },
      ]),
    );
    expect(f.problems[0].message).toContain("language definition file russian.ldf was not found");
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
