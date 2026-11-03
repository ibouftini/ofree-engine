// Runs against a real texlive.tlpdb when TLPDB points to one (CI downloads it);
// otherwise only the small inline sample is checked.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fontPackage, resolvePackages } from "../src/plan/resolve.js";
import { planDocument } from "../src/plan/scan.js";
import { buildFileIndex, closure, parseTlpdb } from "../src/tl/tlpdb.js";

const SAMPLE = `name 00texlive.config
category TLCore
depend release/2026

name foo
category Package
revision 7
depend bar
depend foo.ARCH
containersize 100
containerchecksum abc
runfiles size=2
 RELOC/tex/latex/foo/foo.sty
 RELOC/tex/latex/foo/foo-extra.def details="x"
docfiles size=1
 RELOC/doc/latex/foo/README

name foo.x86_64-linux
category Package
binfiles arch=x86_64-linux size=1
 bin/x86_64-linux/foo

name bar
category Package
runfiles size=1
 RELOC/tex/latex/bar/bar.sty
`;

describe("parseTlpdb (inline sample)", () => {
  const db = parseTlpdb(SAMPLE);
  it("parses records, files and the release year", () => {
    expect(db.release).toBe(2026);
    const foo = db.packages.get("foo")!;
    expect(foo.runfiles).toEqual(["texmf-dist/tex/latex/foo/foo.sty", "texmf-dist/tex/latex/foo/foo-extra.def"]);
    expect(foo.containerSize).toBe(100);
  });
  it("closes over depends, resolving .ARCH", () => {
    expect([...closure(db, "x86_64-linux", ["foo"])].sort()).toEqual(["bar", "foo", "foo.x86_64-linux"]);
  });
  it("indexes run and binary files, not docs", () => {
    const index = buildFileIndex(db, "x86_64-linux");
    expect(index.get("foo.sty")).toBe("foo");
    expect(index.get("foo")).toBe("foo.x86_64-linux");
    expect(index.has("README")).toBe(false);
  });
});

const real = process.env.TLPDB;
describe.skipIf(!real || !existsSync(real))("real texlive.tlpdb", () => {
  const db = parseTlpdb(readFileSync(real!, "utf8"));
  const arch = "x86_64-linux";
  const index = buildFileIndex(db, arch);

  it("maps common files to their packages", () => {
    expect(index.get("hyperref.sty")).toBe("hyperref");
    expect(index.get("tikz.sty")).toBe("pgf");
    expect(index.get("graphicx.sty")).toBe("graphics");
    // arrows.meta exists only as a pgflibrary file; \usetikzlibrary falls back to it.
    expect(index.get("pgflibraryarrows.meta.code.tex")).toBe("pgf");
    expect(index.get("tikzlibrarypgfplots.fillbetween.code.tex")).toBe("pgfplots");
    expect(fontPackage(db, index, "Amiri")).toBe("amiri");
    expect(fontPackage(db, index, "Libertinus Serif")).toBe("libertinus-fonts");
    expect(fontPackage(db, index, "TeX Gyre Pagella")).toBe("tex-gyre");
  });

  it("resolves the fixture thesis without leftovers", () => {
    const doc = planDocument(join(import.meta.dirname, "fixtures", "thesis"), "main.tex");
    const r = resolvePackages(db, index, arch, [doc]);
    expect(r.unresolved).toEqual([]);
    for (const p of ["pgf", "pgfplots", "babel-french", "hyphen-french", "natbib", "subfiles", "epstopdf-pkg"]) {
      expect(r.packages.has(p), p).toBe(true);
    }
  });
});
