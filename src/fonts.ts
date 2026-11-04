// Fonts a document names that TeX Live does not have. In order:
//   1. font files in the repository (registered for fontconfig and LuaTeX);
//   2. Google Fonts, by family name;
//   3. Microsoft's core fonts for the web (Arial, Times New Roman, ...), from
//      Microsoft's own installers, which anyone may download and use under
//      Microsoft's licence; Ubuntu's ttf-mscorefonts-installer does the same;
//   4. a metric-compatible substitute (Calibri -> Carlito): same character
//      widths, so the same line breaks and page count. A <Name>.fontspec file
//      makes fontspec load it under the name the document uses.
// Downloaded fonts go into the TeX Live tree, so the cache keeps them.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { run } from "./util/exec.js";

export interface FontOutcome {
  /** The name the document uses. */
  name: string;
  source: "repository" | "google" | "microsoft" | "substitute" | "missing";
  /** For a substitute: the font used instead. */
  family?: string;
  /** For a substitute: how it differs from the original. */
  note?: string;
}

const METRIC_NOTE = "It has the same character widths, so lines and pages break the same way, but the letters look slightly different.";

const IPA_NOTE = "IPAex has the same Japanese characters as the IPA fonts; only Latin letters are spaced proportionally.";
const FANDOL_NOTE = "Fandol fonts are of the same styles (Song, Hei, Kai, Fang) and cover the same Chinese characters, but the letters look different.";
const gyre = (family: string, stem: string) => ({
  family,
  files: { Regular: `${stem}-regular.otf`, Bold: `${stem}-bold.otf`, Italic: `${stem}-italic.otf`, BoldItalic: `${stem}-bolditalic.otf` },
  note: METRIC_NOTE,
});
const fandol = (style: string, bold = false) => ({
  family: `Fandol${style}`,
  files: { Regular: `Fandol${style}-Regular.otf`, ...(bold ? { Bold: `Fandol${style}-Bold.otf` } : {}) },
  note: FANDOL_NOTE,
});
const ipaex = (style: "Mincho" | "Gothic") => ({ family: `IPAex ${style}`, files: { Regular: style === "Mincho" ? "ipaexm.ttf" : "ipaexg.ttf" }, note: IPA_NOTE });

/**
 * Fonts TeX Live does not have, with a TeX Live font that stands in for them:
 * the IPA fonts (IPAex), and the Windows Chinese fonts ctex's fontset=windows
 * names, by family and by file (Fandol).
 */
const TEXLIVE_SUBSTITUTES: Record<string, { family: string; files: Record<string, string>; note: string }> = {
  ipamincho: ipaex("Mincho"), ipapmincho: ipaex("Mincho"), ipagothic: ipaex("Gothic"), ipapgothic: ipaex("Gothic"),
  simsun: fandol("Song", true), nsimsun: fandol("Song", true), "simsun.ttc": fandol("Song", true),
  simhei: fandol("Hei", true), "simhei.ttf": fandol("Hei", true), microsoftyahei: fandol("Hei", true), "msyh.ttc": fandol("Hei", true), "msyh.ttf": fandol("Hei", true),
  kaiti: fandol("Kai"), "simkai.ttf": fandol("Kai"), fangsong: fandol("Fang"), "simfang.ttf": fandol("Fang"),
  // Clones of the classic PostScript fonts, in TeX Live, with the same widths.
  palatino: gyre("TeX Gyre Pagella", "texgyrepagella"), palatinolinotype: gyre("TeX Gyre Pagella", "texgyrepagella"), bookantiqua: gyre("TeX Gyre Pagella", "texgyrepagella"),
  bookman: gyre("TeX Gyre Bonum", "texgyrebonum"), bookmanoldstyle: gyre("TeX Gyre Bonum", "texgyrebonum"),
  centuryschoolbook: gyre("TeX Gyre Schola", "texgyreschola"), helvetica: gyre("TeX Gyre Heros", "texgyreheros"), helveticaneue: gyre("TeX Gyre Heros", "texgyreheros"),
  times: gyre("TeX Gyre Termes", "texgyretermes"), courier: gyre("TeX Gyre Cursor", "texgyrecursor"), avantgarde: gyre("TeX Gyre Adventor", "texgyreadventor"),
};

/** Selawik, Microsoft's open font with the widths of Segoe UI. It is not on Google Fonts, and covers Latin only. */
const SELAWIK = {
  url: "https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip",
  sha256: "3f62c51e05e3b5a1e6241cf92a371f0be2ea1183aa87b30718bbd40832a8d423",
  files: { Regular: "selawk.ttf", Bold: "selawkb.ttf" },
};

/** The Latin Modern shapes that stand in for a font found nowhere, by the style its name suggests. */
export function lastResortFiles(name: string): { family: string; files: Record<string, string> } {
  if (/mono|code|consol|courier|typewriter|console/i.test(name)) return { family: "Latin Modern Mono", files: { Regular: "lmmono10-regular.otf", Italic: "lmmono10-italic.otf" } };
  if (/sans|gothic|grotesk|ui\b|arial|helvet|verdana|tahoma/i.test(name)) return { family: "Latin Modern Sans", files: { Regular: "lmsans10-regular.otf", Bold: "lmsans10-bold.otf", Italic: "lmsans10-oblique.otf", BoldItalic: "lmsans10-boldoblique.otf" } };
  return { family: "Latin Modern Roman", files: { Regular: "lmroman10-regular.otf", Bold: "lmroman10-bold.otf", Italic: "lmroman10-italic.otf", BoldItalic: "lmroman10-bolditalic.otf" } };
}


/** Microsoft's core fonts for the web: installer name and the SHA-256 that Ubuntu's ttf-mscorefonts-installer checks. */
const MICROSOFT: Record<string, [string, string]> = {
  "andale mono": ["andale32", "0524fe42951adc3a7eb870e32f0920313c71f170c859b5f770d82b4ee111e970"],
  arial: ["arial32", "85297a4d146e9c87ac6f74822734bdee5f4b2a722d7eaa584b7f2cbf76f478f6"],
  "arial black": ["arialb32", "a425f0ffb6a1a5ede5b979ed6177f4f4f4fdef6ae7c302a7b7720ef332fec0a8"],
  "comic sans ms": ["comic32", "9c6df3feefde26d4e41d4a4fe5db2a89f9123a772594d7f59afd062625cd204e"],
  "courier new": ["courie32", "bb511d861655dde879ae552eb86b134d6fae67cb58502e6ff73ec5d9151f3384"],
  georgia: ["georgi32", "2c2c7dcda6606ea5cf08918fb7cd3f3359e9e84338dc690013f20cd42e930301"],
  impact: ["impact32", "6061ef3b7401d9642f5dfdb5f2b376aa14663f6275e60a51207ad4facf2fccfb"],
  "times new roman": ["times32", "db56595ec6ef5d3de5c24994f001f03b2a13e37cee27bc25c58f6f43e8f807ab"],
  "trebuchet ms": ["trebuc32", "5a690d9bb8510be1b8b4fe49f1f2319651fe51bbe54775ddddd8ef0bd07fdac9"],
  verdana: ["verdan32", "c1cb61255e363166794e47664e2f21af8e3a26cb6346eb8d2ae2fa85dd5aad96"],
  webdings: ["webdin32", "64595b5abc1080fba8610c5c34fab5863408e806aafe84653ca8575bed17d75a"],
};

/** Metric-compatible fonts on Google Fonts for Microsoft fonts that cannot be downloaded (or when that is turned off). */
export const SUBSTITUTES: Record<string, string> = {
  calibri: "Carlito",
  cambria: "Caladea",
  "times new roman": "Tinos",
  arial: "Arimo",
  "courier new": "Cousine",
  georgia: "Gelasio",
};

/**
 * Fonts with no download and no metric-compatible match, with a free font of a
 * similar style. Line and page breaks may change, and the warning says so.
 */
export const CLOSE_MATCHES: Record<string, string> = {
  consolas: "Inconsolata", aptos: "Inter", "aptos display": "Inter", "arial narrow": "Archivo Narrow",
  garamond: "EB Garamond", "century gothic": "Questrial", tahoma: "Open Sans", "lucida sans": "Open Sans",
  "lucida console": "Cousine", menlo: "Cousine", monaco: "Cousine", "segoe ui light": "Open Sans",
};
const CLOSE_NOTE = "It has a similar style, but different character widths, so lines and pages may break differently.";

const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i;
const SHAPES = [
  ["UprightFont", "Regular"],
  ["BoldFont", "Bold"],
  ["ItalicFont", "Italic"],
  ["BoldItalicFont", "BoldItalic"],
] as const;

/**
 * The Google Fonts family for a name as documents write it: a family
 * ("Roboto"), a file ("NotoNastaliqUrdu-Regular.ttf"), or the CJK names of
 * the system packages ("Noto Sans CJK SC" is "Noto Sans SC" there).
 */
export function googleFamily(name: string): string {
  let n = name.trim();
  if (FONT_FILE.test(n) || /^[A-Za-z0-9]+-[A-Za-z]+$/.test(n)) {
    n = n.replace(FONT_FILE, "").replace(/-[A-Za-z]+$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  }
  const cjk = /^Noto (Sans|Serif) CJK (SC|TC|HK|JP|KR)$/i.exec(n);
  return cjk ? `Noto ${cjk[1]} ${cjk[2].toUpperCase()}` : n;
}

/** Styles of a family from the Google Fonts CSS API (plain requests get TTF files, one per style). */
export function parseGoogleCss(css: string): { style: string; url: string }[] {
  const out: { style: string; url: string }[] = [];
  for (const block of css.split("@font-face").slice(1)) {
    const italic = /font-style:\s*italic/.test(block);
    const bold = Number(/font-weight:\s*(\d+)/.exec(block)?.[1] ?? 400) >= 600;
    const url = /url\((https:[^)]+\.ttf)\)/.exec(block)?.[1];
    const style = (bold ? "Bold" : "") + (italic ? "Italic" : "") || "Regular";
    if (url && !out.some((o) => o.style === style)) out.push({ style, url });
  }
  return out;
}

/** The feature file that makes fontspec load other files for `name` (fontspec looks for it without spaces). */
export function fontspecAlias(name: string, files: Record<string, string>): { file: string; text: string } {
  const shapes = SHAPES.filter(([, style]) => files[style]).map(([key, style]) => `  ${key} = ${files[style]},`);
  return { file: `${name.replace(/\s+/g, "")}.fontspec`, text: `\\defaultfontfeatures[${name}]{\n${shapes.join("\n")}\n}\n` };
}

export class Fonts {
  /** Downloaded fonts and feature files, inside TeX Live (cached with it). */
  private readonly downloads: string;
  private readonly aliases: string;
  private known?: Set<string>;
  /** True once anything was downloaded: TeX's file index and fontconfig need refreshing. */
  changed = false;

  constructor(
    texdir: string,
    /** The repository's font files are copied here (not cached: they change with the repository). */
    readonly repositoryDir: string,
    private readonly work: string,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.downloads = join(texdir, "texmf-dist", "fonts", "truetype", "ofree");
    this.aliases = join(texdir, "texmf-dist", "tex", "latex", "ofree-fonts");
  }

  /** Copies the repository's font files (and extra ones) where fontconfig and LuaTeX look. Returns how many. */
  async registerRepository(workspace: string, extra: string[] = []): Promise<number> {
    rmSync(this.repositoryDir, { recursive: true, force: true });
    mkdirSync(this.repositoryDir, { recursive: true });
    const files: string[] = [...extra];
    let seen = 0;
    const walk = (dir: string, depth: number) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (++seen > 50_000) return;
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = join(dir, e.name);
        if (e.isDirectory() && depth < 8) walk(full, depth + 1);
        else if (e.isFile() && FONT_FILE.test(e.name) && statSync(full).size < 64 * 1024 * 1024) files.push(full);
      }
    };
    walk(workspace, 0);
    for (const f of files) copyFileSync(f, join(this.repositoryDir, basename(f)));
    if (files.length) await run("fc-cache", [this.repositoryDir], { env: this.env() });
    this.known = undefined;
    return files.length;
  }

  /** Family names fontconfig knows (system, TeX Live, repository, downloaded), lowercased. */
  private async families(): Promise<Set<string>> {
    if (this.known) return this.known;
    const r = await run("fc-list", [":", "family"], { env: this.env() });
    this.known = new Set(r.output.split("\n").flatMap((l) => l.split(",").map((f) => f.trim().toLowerCase())).filter(Boolean));
    return this.known;
  }

  private async available(name: string): Promise<boolean> {
    if (existsSync(join(this.aliases, fontspecAlias(name, {}).file))) return true;
    if (FONT_FILE.test(name)) {
      if (existsSync(join(this.repositoryDir, name)) || existsSync(join(this.downloads, name))) return true;
      return (await run("kpsewhich", [name], { env: this.env() })).code === 0;
    }
    return (await this.families()).has(name.toLowerCase());
  }

  /**
   * ctex's fontset=windows loads SimSun, SimHei, KaiTi, FangSong and Microsoft
   * YaHei, partly through options (BoldFont = SimHei) that a feature file
   * cannot redirect. Without those fonts, a ctex-fontset-windows.def that
   * loads ctex's Fandol set is written to `dir`, which TeX searches first.
   */
  async ctexWindows(dir: string): Promise<FontOutcome | undefined> {
    if (await this.available("SimSun")) return undefined;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ctex-fontset-windows.def"),
      [
        "% Written by ofree-engine: the Windows fonts are not available on this",
        "% machine, so ctex's fontset=windows uses the Fandol fonts from TeX Live.",
        "\\ProvidesExplFile{ctex-fontset-windows.def}{2026/11/04}{0}{Windows font set, with Fandol fonts}",
        "\\file_input:n { ctex-fontset-fandol.def }",
        "\\cs_if_exist:NF \\lishu { \\NewDocumentCommand \\lishu { } { \\CJKfamily { zhkai } } }",
        "\\cs_if_exist:NF \\youyuan { \\NewDocumentCommand \\youyuan { } { \\CJKfamily { zhhei } } }",
        "\\cs_if_exist:NF \\yahei { \\NewDocumentCommand \\yahei { } { \\CJKfamily { zhhei } } }",
        "",
      ].join("\n"),
    );
    this.log("ctex fontset=windows: the Windows fonts are not available; using the Fandol fonts");
    return { name: "SimSun, SimHei, KaiTi, FangSong (ctex fontset=windows)", source: "substitute", family: "Fandol", note: FANDOL_NOTE };
  }

  /** Makes each font available if it is not yet, and says where it came from. */
  async provide(names: string[], microsoft: boolean): Promise<FontOutcome[]> {
    const out: FontOutcome[] = [];
    for (const name of names) {
      if (await this.available(name)) {
        if (existsSync(join(this.repositoryDir, name)) || (await this.inRepository(name))) out.push({ name, source: "repository" });
        continue;
      }
      out.push(await this.fetch(name, microsoft));
    }
    if (this.changed) await this.refresh();
    return out;
  }

  /** Makes files just added visible to TeX and fontconfig. */
  private async refresh() {
    await run("mktexlsr", [join(this.downloads, "..", "..", "..")], { env: this.env() });
    if (existsSync(this.downloads)) await run("fc-cache", [this.downloads], { env: this.env() });
    this.known = undefined;
  }

  private async inRepository(name: string): Promise<boolean> {
    if (!existsSync(this.repositoryDir) || readdirSync(this.repositoryDir).length === 0) return false;
    const r = await run("fc-list", [":", "family", "file"], { env: this.env() });
    const lower = name.toLowerCase();
    return r.output.split("\n").some((l) => l.startsWith(this.repositoryDir) && l.toLowerCase().includes(lower));
  }

  private async fetch(name: string, microsoft: boolean): Promise<FontOutcome> {
    const key = name.toLowerCase();
    // Each source may fail (network, missing tools); the next one is still tried.
    const attempt = async <T>(what: string, step: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await step();
      } catch (err) {
        this.log(`Font "${name}": ${what} failed: ${err instanceof Error ? err.message : err}`);
        return undefined;
      }
    };
    const tl = TEXLIVE_SUBSTITUTES[key.replace(/\s+/g, "")];
    if (tl && (await run("kpsewhich", [tl.files.Regular], { env: this.env() })).code === 0) {
      this.alias(name, tl.files);
      this.log(`Font "${name}": not in TeX Live, using ${tl.family}`);
      return { name, source: "substitute", family: tl.family, note: tl.note };
    }
    const family = googleFamily(name);
    const files = await attempt("Google Fonts", () => this.google(family));
    if (files) {
      // Under another name (a file name, or Google's name for a CJK family): point the document's name at the files.
      if (family.toLowerCase() !== key) this.alias(name, files);
      this.log(`Font "${name}": downloaded from Google Fonts${family !== name ? ` (${family})` : ""}`);
      return { name, source: "google", family: family !== name ? family : undefined };
    }
    if (microsoft && MICROSOFT[key] && (await attempt("Microsoft's download", () => this.microsoft(key)))) {
      this.log(`Font "${name}": downloaded Microsoft's core font installer`);
      return { name, source: "microsoft" };
    }
    if (key === "segoe ui" && (await attempt("Selawik's download", () => this.selawik()))) {
      this.alias(name, SELAWIK.files);
      this.log(`Font "${name}": using the metric-compatible Selawik`);
      return { name, source: "substitute", family: "Selawik", note: `${METRIC_NOTE} It covers Latin letters only.` };
    }
    const substitute = SUBSTITUTES[key] ?? CLOSE_MATCHES[key];
    const subFiles = substitute ? await attempt(`Google Fonts (${substitute})`, () => this.google(substitute)) : undefined;
    if (substitute && subFiles) {
      this.alias(name, subFiles);
      this.log(`Font "${name}": using ${substitute}`);
      return { name, source: "substitute", family: substitute, note: SUBSTITUTES[key] ? METRIC_NOTE : CLOSE_NOTE };
    }
    this.log(`Font "${name}": not in TeX Live, the repository, Google Fonts or Microsoft's core fonts`);
    return { name, source: "missing" };
  }

  /** Downloads Selawik from Microsoft's release (checked against its checksum; unzip only reads it). */
  private async selawik(): Promise<boolean> {
    if (existsSync(join(this.downloads, SELAWIK.files.Regular))) return true;
    const res = await fetch(SELAWIK.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== SELAWIK.sha256) throw new Error("it does not have the expected checksum");
    const zip = join(this.work, "selawik.zip");
    mkdirSync(this.work, { recursive: true });
    mkdirSync(this.downloads, { recursive: true });
    writeFileSync(zip, bytes);
    const r = await run("unzip", ["-oqj", zip, ...Object.values(SELAWIK.files), "-d", this.downloads]);
    if (r.code !== 0) throw new Error(r.output.slice(-200));
    this.changed = true;
    return true;
  }

  /**
   * For a font found nowhere: Latin Modern, under the document's name, so the
   * PDF has its text. Without this, every character of that font is lost.
   */
  async lastResort(name: string): Promise<FontOutcome | undefined> {
    const { family, files } = lastResortFiles(name);
    if ((await run("kpsewhich", [files.Regular], { env: this.env() })).code !== 0) return undefined;
    this.alias(name, files);
    await this.refresh();
    this.log(`Font "${name}": found nowhere; ${family} stands in so the PDF has its text`);
    return { name, source: "substitute", family, note: "No font of that name was found anywhere: check its name." };
  }

  /** Downloads a Google Fonts family (regular, bold, italic, bold italic as available); file names by style. */
  private async google(family: string): Promise<Record<string, string> | undefined> {
    const stem = family.replace(/\s+/g, "");
    const existing = Object.fromEntries(SHAPES.map(([, s]) => [s, `${stem}-${s}.ttf`]).filter(([, f]) => existsSync(join(this.downloads, f))));
    if (existing.Regular) return existing;
    const q = encodeURIComponent(family).replace(/%20/g, "+");
    for (const axes of [":ital,wght@0,400;0,700;1,400;1,700", ":wght@400;700", ""]) {
      const res = await fetch(`https://fonts.googleapis.com/css2?family=${q}${axes}`, { headers: { "User-Agent": "ofree-engine" } });
      if (res.status === 400) continue;
      if (!res.ok) throw new Error(`Google Fonts answered ${res.status}`);
      const styles = parseGoogleCss(await res.text());
      if (!styles.length) continue;
      mkdirSync(this.downloads, { recursive: true });
      const files: Record<string, string> = {};
      for (const { style, url } of styles) {
        const bytes = await fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${url}: ${r.status}`))));
        files[style] = `${stem}-${style}.ttf`;
        writeFileSync(join(this.downloads, files[style]), Buffer.from(bytes));
      }
      this.changed = true;
      return files;
    }
    return undefined;
  }

  /** Downloads and unpacks one of Microsoft's core font installers (unpacked with 7z, never run). */
  private async microsoft(key: string): Promise<boolean> {
    const [installer, sha256] = MICROSOFT[key];
    const res = await fetch(`https://downloads.sourceforge.net/corefonts/${installer}.exe`, { redirect: "follow" });
    if (!res.ok) throw new Error(`Microsoft's ${installer}.exe could not be downloaded (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`${installer}.exe does not have the expected checksum`);
    const dir = join(this.work, "corefonts", installer);
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, `${installer}.exe`);
    writeFileSync(exe, bytes);
    const unpacked = (await run("7z", ["e", "-y", `-o${dir}`, exe], {})).code === 0 || (await run("cabextract", ["-q", "-d", dir, exe], {})).code === 0;
    const ttfs = unpacked ? readdirSync(dir).filter((f) => /\.ttf$/i.test(f)) : [];
    if (!ttfs.length) throw new Error(`${installer}.exe could not be unpacked (7z or cabextract is needed)`);
    mkdirSync(this.downloads, { recursive: true });
    // Windows names them in lower case (times.ttf, timesbd.ttf); documents may use those.
    for (const f of ttfs) copyFileSync(join(dir, f), join(this.downloads, f.toLowerCase()));
    this.changed = true;
    return true;
  }

  private alias(name: string, files: Record<string, string>) {
    mkdirSync(this.aliases, { recursive: true });
    const { file, text } = fontspecAlias(name, files);
    writeFileSync(join(this.aliases, file), text);
    this.changed = true;
  }
}

/** Font names worth providing: not macros, not option-only names. */
export const providable = (name: string) => !/[\\#{}]/.test(name) && name.trim().length > 1 && !/^\*/.test(name) && extname(name) !== ".tfm";
