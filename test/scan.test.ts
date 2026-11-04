import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseMain, findRoots, fontFileName, japaneseEngine, listTexFiles, liveText, offFlags, planDocument, stripComments } from "../src/plan/scan.js";

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

describe("chooseMain, with nothing marked", () => {
  it("does not let a standalone figure fail the build", () => {
    const ws = fx("roots-ambiguous-figure");
    const files = listTexFiles(ws);
    expect(chooseMain(ws, files, findRoots(ws, files))).toEqual({ main: ["a.tex", "b.tex"], others: ["fig.tex"], reason: "no main document is marked, so all count" });
  });

  it("counts every figure when there are only figures", () => {
    const ws = fx("roots-only-figures");
    const files = listTexFiles(ws);
    expect(chooseMain(ws, files, findRoots(ws, files))).toEqual({ main: ["one.tex", "two.tex"], others: [], reason: "no main document is marked, so all count" });
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

  it("knows the programs outside TeX Live a document runs, and turns on shell escape", () => {
    const d = planDocument(fx("programs"), "main.tex");
    expect([...d.systemPrograms.keys()].sort()).toEqual(["gnuplot", "gs", "inkscape", "libglut.so.3"]);
    expect(d.systemPrograms.get("gnuplot")?.reason).toBe("pgfplots computes this plot with gnuplot");
    expect(d.shellEscape).not.toBeNull();
    expect(planDocument(fx("eps"), "main.tex").systemPrograms.get("gs")?.reason).toBe("EPS images are converted with Ghostscript");
  });

  it("scans a local class and drops it from the TeX Live requirements", () => {
    const d = planDocument(fx("localcls"), "cv.tex");
    expect(d.requires.has("mycv.cls")).toBe(false);
    expect([...d.requires.keys()]).toEqual(expect.arrayContaining(["article.cls", "fontawesome5.sty", "fontspec.sty"]));
    expect(d.engine).toBe("xelatex");
    expect([...d.fonts.keys()]).toEqual(["Source Sans Pro"]);
  });
});

describe("conditionals", () => {
  const none = { off: new Set<string>(), engine: "any" as const };

  it("blanks branches that cannot run, keeping lines", () => {
    const text = "\\ifxetex\na\n\\else\nb\n\\fi\nc";
    expect(liveText(text, { ...none, engine: "xelatex" }).split("\n").map((l) => l.trim())).toEqual(["\\ifxetex", "a", "\\else", "", "\\fi", "c"]);
    expect(liveText(text, { ...none, engine: "pdflatex" }).split("\n").map((l) => l.trim())).toEqual(["\\ifxetex", "", "\\else", "b", "\\fi", "c"]);
    expect(liveText(text, { ...none, engine: "none" }).split("\n").map((l) => l.trim())).toEqual(["\\ifxetex", "", "", "", "\\fi", "c"]);
    expect(liveText(text, none)).toBe(text);
  });

  it("handles nesting, unknown tests, tests without \\fi, and definitions", () => {
    const nested = liveText("\\ifflag \\ifnum1=1 a\\else b\\fi \\else c\\fi d", { off: new Set(["flag"]), engine: "any" });
    expect(nested).not.toMatch(/[ab]\\/);
    expect(nested).toContain("c");
    expect(nested).toContain("d");
    const etoolbox = "\\ifbool{y}{a}{b}\\ifdef\\z{c}{d}\\ifflag e\\fi f";
    expect(liveText(etoolbox, { off: new Set(["flag"]), engine: "any" })).not.toContain(" e");
    // Flags followed by a group, unlike \\ifbool{y}{a}{b}.
    const group = { off: new Set(["flag"]), engine: "any" as const };
    expect(liveText("\\newif\\ifmine \\ifmine{a}\\fi \\ifflag e\\fi", group)).not.toContain(" e");
    expect(liveText("\\if@twoside{a}\\fi \\ifflag e\\fi", group)).not.toContain(" e");
    // A flag that only looks like an etoolbox test.
    expect(liveText("\\ifdefineAbstract x\\fi \\ifflag e\\fi", { off: new Set(["flag"]), engine: "any" })).toContain(" x");
    expect(liveText("\\ifdefineAbstract x\\fi \\ifflag e\\fi", { off: new Set(["flag"]), engine: "any" })).not.toContain(" e");
    const defined = "\\newif\\ifflag \\def\\ifother{} \\ifflag a\\fi b";
    expect(liveText(defined, { off: new Set(["flag"]), engine: "any" })).not.toContain(" a");
  });

  it("leaves text alone when its conditionals do not balance", () => {
    const off = { off: new Set(["flag"]), engine: "any" as const };
    expect(liveText("\\ifflag a", off)).toBe("\\ifflag a");
    expect(liveText("a\\fi \\ifflag b\\fi", off)).toBe("a\\fi \\ifflag b\\fi");
  });

  it("knows a flag is off only when nothing can turn it on", () => {
    const cls = "\\newif\\ifa\\afalse\\DeclareOption{a}{\\ifb\\else\\atrue\\fi}\\newif\\ifb\\btrue\\newif\\ifc\\DeclareOption{c}{\\ctrue}\\newif\\ifd\\newif\\ife\\let\\ife\\iftrue";
    expect([...offFlags([cls])].sort()).toEqual(["a", "c", "d"]);
    expect([...offFlags(["\\documentclass[c]{x}", cls])].sort()).toEqual(["a", "d"]);
    expect([...offFlags(["\\ExecuteOptions{a}", cls])].sort()).toEqual(["c", "d"]);
    // Options TeX has to expand could be anything.
    expect(offFlags(["\\documentclass[\\opts]{x}", cls]).size).toBe(0);
  });

  it("does not count what an unused class option loads", () => {
    const d = planDocument(fx("conditionals"), "main.tex");
    expect(d.bibTool).toBe("bibtex");
    expect(d.requires.has("biblatex.sty")).toBe(false);
    expect(d.requires.has("natbib.sty")).toBe(true);
    expect(d.requires.has("neverloaded.sty")).toBe(false);
    expect(d.requires.has("setsomewhere.sty")).toBe(true);
    expect(d.requires.has("commentedout.sty")).toBe(false);
  });

  it("counts it when the option is used", () => {
    const d = planDocument(fx("conditionals"), "withoption.tex");
    expect(d.bibTool).toBe("biber");
    expect(d.requires.has("biblatex.sty")).toBe(true);
  });

  it("says when the sources support several engines, and needs only the chosen one's packages", () => {
    const d = planDocument(fx("conditionals"), "main.tex");
    expect(d.engine).toBe("xelatex");
    expect(d.engineReason).toMatch(/^fontspec \(portable\.cls:\d+\); the sources support other engines too/);
    expect(d.requires.has("fontspec.sty")).toBe(true);
    expect(d.requires.has("mathptmx.sty")).toBe(false);
  });

  it("takes the other branch when the engine is named", () => {
    const d = planDocument(fx("conditionals"), "forced.tex");
    expect(d.engine).toBe("pdflatex");
    expect(d.requires.has("mathptmx.sty")).toBe(true);
    expect(d.requires.has("fontspec.sty")).toBe(false);
    expect(d.fonts.size).toBe(0);
  });

  it("chooses the engine whose branch needs it", () => {
    const d = planDocument(fx("conditionals"), "lua.tex");
    expect(d.engine).toBe("lualatex");
    expect(d.requires.has("inputenc.sty")).toBe(false);
  });

  it("adds what plautopatch loads, which the luatexja branch used to bring by accident", () => {
    const d = planDocument(fx("conditionals"), "uplatex.tex");
    expect(d.engine).toBe("uplatex");
    expect(d.requires.has("luatexja.sty")).toBe(false);
    expect(d.requires.has("pxjahyper.sty")).toBe(true);
    expect(d.requires.has("pxpgfmark.sty")).toBe(true);
  });

  it("reads font files from Extension and UprightFont, before or after the name", () => {
    const d = planDocument(fx("conditionals"), "main.tex");
    expect([...d.fonts.keys()].sort()).toEqual(["XITS-Regular.otf", "XITSMath-Regular.otf"]);
    expect(fontFileName("Roboto", "")).toBe("Roboto");
    expect(fontFileName("Foo", "Path=fonts/, Extension={.ttf}")).toBe("Foo.ttf");
    expect(fontFileName("Foo", "Extension=.otf,UprightFont=Foo-Book")).toBe("Foo-Book.otf");
  });
});
