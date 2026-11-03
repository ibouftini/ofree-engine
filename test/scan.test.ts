import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseMain, findRoots, japaneseEngine, listTexFiles, planDocument, stripComments } from "../src/plan/scan.js";

const fx = (name: string) => join(import.meta.dirname, "fixtures", name);

describe("stripComments", () => {
  it("keeps escaped percent signs", () => {
    expect(stripComments("50\\% done % comment")).toBe("50\\% done ");
    expect(stripComments("a\\\\% comment")).toBe("a\\\\");
  });
});

describe("findRoots", () => {
  it("skips included files and subfiles", () => {
    const ws = fx("thesis");
    expect(findRoots(ws, listTexFiles(ws))).toEqual(["main.tex"]);
  });
});

describe("chooseMain", () => {
  const roots = (name: string) => {
    const ws = fx(name);
    const files = listTexFiles(ws);
    return chooseMain(ws, files, findRoots(ws, files));
  };

  it("leaves out parts, and takes the file they name as the main document", () => {
    // chapters/appendix.tex is a subfiles part with its own \\documentclass; notes.tex is another document.
    expect(roots("roots-magic")).toEqual({ main: ["thesis.tex"], others: ["notes.tex"], reason: "named by % !TeX root" });
  });

  it("takes main.tex, and still builds the draft and the standalone figure", () => {
    expect(roots("roots-named")).toEqual({ main: ["main.tex"], others: ["draft.tex", "figures/fig.tex"], reason: "named main.tex" });
  });

  it("follows .latexmkrc @default_files", () => {
    expect(roots("roots-rc")).toMatchObject({ main: ["report.tex"], others: ["old-report.tex"] });
  });

  it("sets standalone figures aside", () => {
    expect(roots("roots-figure")).toEqual({ main: ["paper.tex"], others: ["plot.tex"], reason: "the only document that is not a standalone figure" });
  });

  it("counts every document when none is marked", () => {
    expect(roots("roots-ambiguous")).toEqual({ main: ["a.tex", "b.tex"], others: [], reason: "no main document is marked, so all count" });
  });
});

describe("planDocument", () => {
  it("collects packages, libraries, languages and bibliography from a multi-file thesis", () => {
    const d = planDocument(fx("thesis"), "main.tex");
    expect(d.engine).toBe("pdflatex");
    expect(d.sources).toEqual(["main.tex", "chapters/intro.tex", "chapters/results.tex"]);
    const req = [...d.requires.keys()];
    expect(req).toEqual(expect.arrayContaining([
      "report.cls", "babel.sty", "graphicx.sty", "subfiles.sty", "tikz.sty", "pgfplots.sty",
      "tikzlibraryarrows.meta.code.tex", "tikzlibrarypositioning.code.tex", "tikzlibrarycalc.code.tex",
      "tikzlibrarypgfplots.fillbetween.code.tex", "abbrvnat.bst", "epstopdf.sty",
    ]));
    expect(req).not.toContain("notloaded.sty");
    expect([...d.languages.keys()]).toEqual(["french"]);
    expect(d.bibTool).toBe("bibtex");
    expect(d.requires.get("tikz.sty")).toEqual({ file: "main.tex", line: 5 });
  });

  it("chooses XeLaTeX for polyglossia and records languages and fonts", () => {
    const d = planDocument(fx("arabic"), "paper.tex");
    expect(d.engine).toBe("xelatex");
    expect(d.engineReason).toBe("polyglossia (paper.tex:2)");
    expect([...d.languages.keys()]).toEqual(["arabic", "english"]);
    expect([...d.fonts.keys()].sort()).toEqual(["Amiri", "Libertinus Serif"]);
  });

  it("follows % !TeX program and biblatex styles", () => {
    const d = planDocument(fx("lua"), "doc.tex");
    expect(d.engine).toBe("lualatex");
    expect(d.engineReason).toBe("% !TeX program (doc.tex:1)");
    expect(d.bibTool).toBe("biber");
    expect([...d.requires.keys()]).toEqual(expect.arrayContaining(["ieee.bbx", "ieee.cbx", "biblatex.sty"]));
  });

  it("turns font encodings and brace-less \\input in local packages into requirements", () => {
    const d = planDocument(fx("cyrillic"), "main.tex");
    expect([...d.requires.keys()]).toEqual(expect.arrayContaining(["t2aenc.def", "cm-super-t2a.enc", "chemfig.tex"]));
    expect(d.requires.has("wrap.sty")).toBe(false);
    expect([...d.languages.keys()]).toEqual(["russian"]);
  });

  it("maps Beamer themes and a multi-chapter book's tools", () => {
    const samples = join(import.meta.dirname, "..", "bench", "samples");
    const beamer = planDocument(join(samples, "beamer"), "main.tex");
    expect([...beamer.requires.keys()]).toEqual(expect.arrayContaining(["beamer.cls", "beamerthememetropolis.sty", "tikz.sty"]));
    const book = planDocument(join(samples, "book"), "main.tex");
    expect(book.sources).toEqual(["main.tex", "chapters/introduction.tex", "chapters/methods.tex", "chapters/data.tex"]);
    expect(book.bibTool).toBe("bibtex");
    expect([...book.requires.keys()]).toEqual(expect.arrayContaining(["plainnat.bst", "makeidx.sty", "natbib.sty"]));
  });

  it("chooses LuaLaTeX for babel features only LuaTeX implements, and records .ini languages", () => {
    const samples = join(import.meta.dirname, "..", "bench", "samples");
    const bidi = planDocument(join(samples, "bidi"), "main.tex");
    expect(bidi.engine).toBe("lualatex");
    expect(bidi.engineReason).toBe("babel bidi=basic (main.tex:4)");
    expect([...bidi.languages.keys()]).toEqual(["english"]);
    expect([...bidi.locales.keys()]).toEqual(["hebrew", "arabic", "persian"]);
    // babel loads these itself for \babelfont and LuaTeX bidi.
    expect([...bidi.requires.keys()]).toEqual(expect.arrayContaining(["fontspec.sty", "luatexbase.sty"]));
    expect(bidi.requires.has("bidi.sty")).toBe(false);

    // provide+=* loads the non-main languages from .ini files; arabic is the main one.
    const d = planDocument(fx("babelini"), "main.tex");
    expect(d.engine).toBe("lualatex");
    expect(d.engineReason).toBe("\\babelposthyphenation (main.tex:4)");
    expect([...d.languages.keys()]).toEqual(["arabic"]);
    expect([...d.locales.keys()]).toEqual(["english", "greek-polytonic"]);
  });

  it("follows a .latexmkrc's DVI route and installs only the programs the document runs", () => {
    const d = planDocument(fx("japanese-rc"), "thesis.tex");
    expect(d.engine).toBe("uplatex");
    expect(d.engineReason).toBe(".latexmkrc");
    expect(d.engineFromLatexmkrc).toBe(true);
    // BibTeX, not Biber (25 MB) nor the index tool: the document has no biblatex and no index.
    expect([...d.programs.keys()]).toEqual(["uplatex", "dvipdfmx", "upbibtex"]);
  });

  it("chooses pLaTeX or upLaTeX from Japanese classes", () => {
    const d = planDocument(fx("japanese-class"), "report.tex");
    expect(d.engine).toBe("uplatex");
    expect(d.engineReason).toBe("jsarticle [uplatex] (report.tex:1)");
    expect(japaneseEngine("jsarticle", [])).toBe("platex");
    expect(japaneseEngine("jarticle", [])).toBe("platex");
    expect(japaneseEngine("ujbook", [])).toBe("uplatex");
    expect(japaneseEngine("jlreq", [])).toBe("lualatex");
    expect(japaneseEngine("jlreq", ["platex"])).toBe("platex");
    expect(japaneseEngine("bxjsarticle", ["autodetect-engine", "ja=standard"])).toBe("xelatex");
    expect(japaneseEngine("bxjsarticle", ["lualatex"])).toBe("lualatex");
    expect(japaneseEngine("article", [])).toBeNull();
  });

  it("finds EPS images without their extension, through \\graphicspath", () => {
    // photo has a PDF next to its EPS (used instead); plot has only an EPS, which needs Ghostscript.
    expect(planDocument(fx("eps"), "main.tex").eps).toEqual({ file: "main.tex", line: 6 });
  });

  it("scans a local class and drops it from the TeX Live requirements", () => {
    const d = planDocument(fx("localcls"), "cv.tex");
    expect(d.requires.has("mycv.cls")).toBe(false);
    expect([...d.requires.keys()]).toEqual(expect.arrayContaining(["article.cls", "fontawesome5.sty", "fontspec.sty"]));
    expect(d.engine).toBe("xelatex");
    expect([...d.fonts.keys()]).toEqual(["Source Sans Pro"]);
  });
});
