import { describe, expect, it } from "vitest";
import { parseLog, unbreakLines } from "../src/compile/logparse.js";

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
  });

  it("finds missing font definition files reported as warnings", () => {
    const f = parseLog(["No file LGRcmr.fd.", "Latexmk: Missing input file 'LGRcmr.fd' message in .log file:", "No file main.toc."].join("\n"));
    expect(f.missing).toEqual([{ kind: "file", name: "LGRcmr.fd" }]);
  });

  it("reads font errors in -file-line-error form", () => {
    const f = parseLog("./main.tex:3: Font T1/ptm/m/n/10=ptmr8t at 10.0pt not loadable: Metric (TFM) file not found.<to be read again>");
    expect(f.missing).toEqual([{ kind: "file", name: "ptmr8t.tfm" }]);
  });

  it("detects documents that need a Unicode engine", () => {
    expect(parseLog("! Fatal Package fontspec Error: The fontspec package requires either XeTeX or\n(fontspec) LuaTeX.").needsUnicodeEngine).toBe(
      "either",
    );
    expect(parseLog("! Package luatexja Error: This package requires LuaTeX.").needsUnicodeEngine).toBe("lualatex");
    expect(parseLog("! Package xeCJK Error: The xeCJK package requires XeTeX to function.").needsUnicodeEngine).toBe("xelatex");
  });

  it("reads babel's LuaTeX-only error, wrapped over continuation lines", () => {
    const log = [
      "./main.tex:4: Package babel Error: The bidi method 'basic' is available only in",
      "(babel)                luatex. I'll continue with 'bidi=default', so",
      "(babel)                expect wrong results.",
    ].join("\n");
    expect(parseLog(log).needsUnicodeEngine).toBe("lualatex");
    // In the .log, TeX breaks the first line at 79 characters, inside "Error".
    const wrapped = [
      "/usr/share/texlive/texmf-dist/tex/generic/babel/babel.sty:3981: Package babel E",
      "rror: The bidi method 'basic' is available only in",
      "(babel)                luatex. I'll continue with 'bidi=default', so",
    ].join("\n");
    expect(parseLog(wrapped).needsUnicodeEngine).toBe("lualatex");
  });

  it("ignores engine requirements mentioned in warnings", () => {
    expect(parseLog("Package foo Warning: Feature bar is only available in LuaTeX; ignored.").needsUnicodeEngine).toBeNull();
  });

  it("reads the page count and the output file", () => {
    const f = parseLog("Output written on main.pdf (14 pages, 1234 bytes).");
    expect(f.pages).toBe(14);
    expect(f.outputFile).toBe("main.pdf");
  });

  it("joins lines TeX broke at 79 columns, counting bytes (pdfTeX) or characters (XeTeX)", () => {
    const bytes = "x".repeat(79);
    expect(unbreakLines(`${bytes}\nrest`)).toBe(`${bytes}rest`);
    // 79 characters but 81 bytes: XeTeX's break inside a message with ⌘ (3 bytes in UTF-8).
    const chars = Buffer.from("⌘" + "y".repeat(78), "utf8").toString("latin1");
    expect(unbreakLines(`${chars}\nrest`)).toBe(`${chars}rest`);
    expect(unbreakLines("short\nline")).toBe("short\nline");
  });

  it("asks for Ghostscript when an EPS image cannot be converted", () => {
    const f = parseLog('dvipdfmx:warning: Could not open conversion result "/tmp/dvipdfm-x.a06b" for image "./javassist.eps". Why?\ndvipdfmx:fatal: Image inclusion failed for "javassist.eps" (page=1).');
    expect(f.missing).toContainEqual({ kind: "program", name: "gs" });
  });

  it("asks for an update when a package expects newer installed ones", () => {
    expect(parseLog("! LaTeX Error: Mismatched LaTeX support files detected.").needsUpdate).toBe(true);
    expect(parseLog("LaTeX Warning: You have requested release `2025-11-01' of LaTeX,\n               but only release `2024-06-01' is available.").needsUpdate).toBe(true);
    expect(parseLog("! Package expl3 Error: Support package l3kernel too old.").needsUpdate).toBe(true);
    expect(parseLog("! Undefined control sequence.").needsUpdate).toBe(false);
  });

  it("reports a CMap dvipdfmx cannot read as a missing file", () => {
    expect(parseLog("dvipdfmx:warning: Could not read encoding file: UniJIS2004-UTF16-H").missing).toContainEqual({ kind: "file", name: "UniJIS2004-UTF16-H" });
  });

  it("reports a shared library a program needs", () => {
    const f = parseLog("asy: error while loading shared libraries: libglut.so.3: cannot open shared object file: No such file or directory");
    expect(f.missing).toContainEqual({ kind: "program", name: "libglut.so.3" });
  });

  it("asks for shell escape when minted says so", () => {
    expect(parseLog("Package minted Error: You must invoke LaTeX with the -shell-escape flag.").needsShellEscape).toBe(true);
  });
});
