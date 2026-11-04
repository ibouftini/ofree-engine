// Owns one TeX Live installation: installs it cold, adds packages to it, and
// builds the formats the documents use. Network access happens only when
// something is missing.

import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Engine } from "../plan/scan.js";
import { Mutex, run, seconds } from "../util/exec.js";
import { downloadAll, fetchBytes, NetworkError, rankMirrors, sha512, tlnetCandidates, tlpdbRevision } from "./net.js";
import { buildFileIndex, closure, parseTlpdb, type Tlpdb } from "./tlpdb.js";

export function texliveArch(): string {
  if (process.platform === "linux") return process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
  if (process.platform === "darwin") return "universal-darwin";
  throw new Error(`Platform ${process.platform}/${process.arch} is not supported yet`);
}

const tail = (s: string, n = 40) => s.trimEnd().split("\n").slice(-n).join("\n");

interface Manifest {
  release: number;
  packages: string[];
}

export class TexLive {
  readonly bin: string;
  release = 0;
  /** True once this run installed anything (the cache must then be saved). */
  changed = false;
  readonly stats = { packagesDownloaded: 0, bytesDownloaded: 0, coldInstall: false };
  /** Progress messages (the action passes core.info). */
  log: (message: string) => void = () => undefined;
  /** Font folders outside TeX Live (the repository's fonts), for fontconfig and LuaTeX. */
  extraFontDirs: string[] = [];
  /** Folders TeX searches before TeX Live (files written for this run only). */
  extraTexInputs: string[] = [];

  private installed = new Set<string>();
  private db?: Tlpdb;
  private index?: Map<string, string>;
  private tlnet?: string;
  private formatsDirty = false;
  private mapsDirty = false;
  private readonly mutex = new Mutex();
  private readonly repo: string;

  constructor(
    readonly texdir: string,
    readonly arch: string,
    private readonly work: string,
    /** A frozen TeX Live year to install from the historic archive; undefined for the current one. */
    readonly year?: number,
  ) {
    this.bin = join(texdir, "bin", arch);
    this.repo = join(work, "repo");
    this.loadManifest();
  }

  get present(): boolean {
    return existsSync(join(this.bin, "tlmgr")) && this.installed.size > 0;
  }

  get mirror(): string | undefined {
    return this.tlnet;
  }

  installedPackages(): ReadonlySet<string> {
    return this.installed;
  }

  /** Absolute paths of a package's installed run files with the given extensions. */
  sourceFiles(pkg: string, extensions: RegExp): string[] {
    const files = this.db?.packages.get(pkg)?.runfiles ?? [];
    return files.filter((f) => extensions.test(f)).map((f) => join(this.texdir, f)).filter((f) => existsSync(f));
  }

  env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${this.bin}${delimiter}${process.env.PATH ?? ""}`,
      // Biber unpacks itself on first run; keep that inside the cached tree.
      PAR_GLOBAL_TEMP: join(this.texdir, ".ofree", "par"),
      // TeX wraps log lines at 79 characters, splitting file names in error
      // messages; unwrapped logs make every message readable.
      max_print_line: "10000",
      error_line: "254",
      half_error_line: "238",
    };
    // A trailing separator keeps TeX Live's own search path after these folders.
    if (this.extraTexInputs.length) env.TEXINPUTS = [...this.extraTexInputs, process.env.TEXINPUTS ?? ""].join(delimiter);
    // LuaTeX (luaotfload) and kpathsea look for fonts outside TeX Live in OSFONTDIR.
    if (this.extraFontDirs.length) env.OSFONTDIR = [...this.extraFontDirs, process.env.OSFONTDIR].filter(Boolean).join(delimiter);
    if (existsSync(this.fontconfigFile())) env.FONTCONFIG_FILE = this.fontconfigFile();
    return env;
  }

  private fontconfigFile() {
    return join(this.texdir, ".ofree", "fonts.conf");
  }

  /**
   * XeTeX finds fonts by name through fontconfig, which does not know TeX
   * Live's font folders. Register them (after the system configuration, so
   * system fonts still work) and keep fontconfig's cache inside the cached tree.
   */
  async ensureFontconfig(): Promise<void> {
    const cacheDir = join(this.texdir, ".ofree", "fontconfig");
    const dirs = ["opentype", "truetype"].map((d) => join(this.texdir, "texmf-dist", "fonts", d));
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      this.fontconfigFile(),
      [
        `<?xml version="1.0"?>`,
        `<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">`,
        `<fontconfig>`,
        `  <cachedir>${cacheDir}</cachedir>`,
        `  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>`,
        ...[...dirs, ...this.extraFontDirs].map((d) => `  <dir>${d}</dir>`),
        `</fontconfig>`,
        ``,
      ].join("\n"),
    );
    if (this.changed || readdirSync(cacheDir).length === 0) {
      await run("fc-cache", dirs.filter((d) => existsSync(d)), { env: this.env() });
    }
  }

  /**
   * XeTeX on macOS finds fonts by name through CoreText, not fontconfig, so
   * TeX Live's fonts and the repository's are linked into ~/Library/Fonts,
   * where CoreText looks. Hard links cost nothing; copies are the fallback.
   */
  exposeFontsToMacOS(home: string): number {
    const target = join(home, "Library", "Fonts", "ofree-engine");
    mkdirSync(target, { recursive: true });
    let count = 0;
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(otf|ttf|ttc)$/i.test(e.name) && !existsSync(join(target, e.name))) {
          try {
            linkSync(full, join(target, e.name));
          } catch {
            copyFileSync(full, join(target, e.name));
          }
          count++;
        }
      }
    };
    for (const d of ["opentype", "truetype"]) walk(join(this.texdir, "texmf-dist", "fonts", d));
    for (const d of this.extraFontDirs) walk(d);
    return count;
  }

  private manifestPath() {
    return join(this.texdir, ".ofree", "manifest.json");
  }

  private loadManifest() {
    if (!existsSync(this.manifestPath())) return;
    const m = JSON.parse(readFileSync(this.manifestPath(), "utf8")) as Manifest;
    this.release = m.release;
    this.installed = new Set(m.packages);
  }

  private saveManifest() {
    mkdirSync(join(this.texdir, ".ofree"), { recursive: true });
    const m: Manifest = { release: this.release, packages: [...this.installed].sort() };
    writeFileSync(this.manifestPath(), JSON.stringify(m, null, 1));
  }

  /** The package database and file index, fetched once per run from one mirror. */
  async database(): Promise<{ db: Tlpdb; index: Map<string, string> }> {
    if (this.db && this.index) return { db: this.db, index: this.index };
    const failures = new Map<string, string>();
    let ranked = await rankMirrors(tlnetCandidates(this.year), 3, failures);
    // The current year is not in the historic archive until it is frozen.
    if (ranked.length === 0 && this.year) ranked = await rankMirrors(tlnetCandidates(), 3, failures);
    if (ranked.length === 0) {
      throw new NetworkError(`No TeX Live repository answered: ${[...failures].map(([url, why]) => `${new URL(url).host} (${why})`).join(", ")}`);
    }

    // Mirrors lag behind each other by a day or more, and tlmgr refuses a
    // repository older than the installation. Read the database of the few
    // fastest mirrors and use the newest one.
    const t0 = performance.now();
    type Candidate = { tlnet: string; dir: string; raw: Buffer; revision: number };
    const good: Candidate[] = [];
    const tasks = ranked.map(async (tlnet, i): Promise<Candidate> => {
      const dir = join(this.work, "tlpdb", String(i));
      mkdirSync(dir, { recursive: true });
      const [xz, sum, asc] = await Promise.all(
        ["texlive.tlpdb.xz", "texlive.tlpdb.sha512", "texlive.tlpdb.sha512.asc"].map((f) => fetchBytes(`${tlnet}/tlpkg/${f}`)),
      );
      writeFileSync(join(dir, "texlive.tlpdb.xz"), xz);
      writeFileSync(join(dir, "texlive.tlpdb.sha512"), sum);
      writeFileSync(join(dir, "texlive.tlpdb.sha512.asc"), asc);
      const unxz = await run("xz", ["-dkf", join(dir, "texlive.tlpdb.xz")]);
      if (unxz.code !== 0) throw new Error(`Could not decompress the package database: ${unxz.output}`);
      const raw = readFileSync(join(dir, "texlive.tlpdb"));
      if (sha512(raw) !== sum.toString("utf8").trim().split(/\s+/)[0]) throw new Error(`${tlnet}: checksum mismatch`);
      const candidate = { tlnet, dir, raw, revision: tlpdbRevision(raw.toString("utf8", 0, 20_000)) };
      good.push(candidate);
      return candidate;
    });
    for (const t of tasks) t.catch(() => undefined);
    try {
      await Promise.any(tasks);
    } catch {
      throw new NetworkError(`Could not read the package database from ${ranked.join(", ")}`);
    }
    // Give the other mirrors a short grace period; never wait for a slow one.
    await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 2000))]);
    const best = good.reduce((a, b) => (b.revision > a.revision ? b : a));
    this.log(
      `Package database: ${best.tlnet} (revision ${best.revision}; compared ${good.map((g) => g.revision).join(", ")}) in ${seconds(t0)} s`,
    );
    const tlpkg = join(this.repo, "tlpkg");
    mkdirSync(tlpkg, { recursive: true });
    for (const f of ["texlive.tlpdb", "texlive.tlpdb.xz", "texlive.tlpdb.sha512", "texlive.tlpdb.sha512.asc"]) {
      copyFileSync(join(best.dir, f), join(tlpkg, f));
    }
    this.tlnet = best.tlnet;
    this.db = parseTlpdb(best.raw.toString("utf8"));
    this.index = buildFileIndex(this.db, this.arch);
    return { db: this.db, index: this.index };
  }

  private async prefetch(names: Iterable<string>) {
    const { db } = await this.database();
    const items = [];
    for (const name of names) {
      const pkg = db.packages.get(name);
      const dest = join(this.repo, "archive", `${name}.tar.xz`);
      if (!pkg || existsSync(dest)) continue;
      items.push({ url: `${this.tlnet}/archive/${name}.tar.xz`, dest, sha512: pkg.containerChecksum || undefined });
    }
    this.stats.bytesDownloaded += await downloadAll(items);
    this.stats.packagesDownloaded += items.length;
  }

  /**
   * Makes sure every package in `wanted` (already a closure) is installed.
   * Returns the packages this call installed.
   */
  install(wanted: Set<string>): Promise<string[]> {
    return this.mutex.lock(async () => {
      const { db } = await this.database();
      // A cached installation from another TeX Live year cannot take new packages.
      if (this.present && this.release !== db.release) this.discard();
      const before = new Set(this.installed);
      if (!this.present) await this.coldInstall(wanted);
      const missing = () => [...wanted].filter((n) => !this.installed.has(n) && db.packages.has(n));
      try {
        await this.tlmgrInstall(missing());
      } catch (err) {
        if (!(err instanceof Error) || !/older than the local installation/.test(err.message)) throw err;
        // The cached installation is newer than every mirror that answered: start fresh.
        this.discard();
        await this.coldInstall(wanted);
        await this.tlmgrInstall(missing());
      }
      return [...this.installed].filter((n) => !before.has(n));
    });
  }

  /**
   * Brings the installed packages up to the repository's revisions. A cached
   * installation keeps its packages as they were; a package added to it later
   * may expect newer ones ("LaTeX kernel too old"). Returns what it updated.
   */
  updateInstalled(): Promise<string[]> {
    return this.mutex.lock(async () => {
      const { db } = await this.database();
      const localDb = join(this.texdir, "tlpkg", "texlive.tlpdb");
      if (!existsSync(localDb)) return [];
      const local = parseTlpdb(readFileSync(localDb, "utf8"));
      // tlmgr itself is left alone: updating it needs "update --self".
      const outdated = [...this.installed].filter(
        (n) => !n.startsWith("texlive.infra") && (db.packages.get(n)?.revision ?? 0) > (local.packages.get(n)?.revision ?? Infinity),
      );
      if (outdated.length === 0) return [];
      await this.prefetch(outdated);
      const r = await run(join(this.bin, "tlmgr"), ["--repository", this.repo, "update", ...outdated], { env: this.env() });
      if (r.code !== 0) throw new Error(`tlmgr could not update ${outdated.length} packages:\n${tail(r.output)}`);
      this.changed = true;
      this.formatsDirty = true;
      this.mapsDirty = true;
      return outdated;
    });
  }

  /** Sets the current installation aside so a fresh one can be installed. */
  private discard() {
    renameSync(this.texdir, `${this.texdir}.old-${Date.now()}`);
    this.installed = new Set();
  }

  private async coldInstall(wanted: Set<string>) {
    const { db } = await this.database();
    const basic = closure(db, this.arch, ["scheme-basic"]);
    await Promise.all([this.prefetch(new Set([...basic, ...wanted])), this.fetchInstaller()]);
    const profile = join(this.work, "texlive.profile");
    const t = this.texdir;
    writeFileSync(
      profile,
      [
        "selected_scheme scheme-basic",
        `TEXDIR ${t}`,
        `TEXMFLOCAL ${t}/texmf-local`,
        `TEXMFSYSCONFIG ${t}/texmf-config`,
        `TEXMFSYSVAR ${t}/texmf-var`,
        // User trees separate from system trees, or on-the-fly generation
        // (mktexfmt, mktexpk) refuses to run. Both stay inside the cached tree.
        `TEXMFCONFIG ${t}/texmf-userconfig`,
        `TEXMFVAR ${t}/texmf-uservar`,
        `TEXMFHOME ${t}/texmf-home`,
        "instopt_adjustpath 0",
        "instopt_adjustrepo 0",
        "instopt_letter 0",
        "instopt_portable 0",
        "instopt_write18_restricted 1",
        "tlpdbopt_autobackup 0",
        "tlpdbopt_create_formats 0",
        "tlpdbopt_install_docfiles 0",
        "tlpdbopt_install_srcfiles 0",
        "",
      ].join("\n"),
    );
    const installTl = (extra: string[]) =>
      run("perl", [join(this.work, "installer", "install-tl"), "-no-gui", "-profile", profile, "-repository", this.repo, ...extra]);
    let r = await installTl([]);
    if (r.code !== 0 && /gpg|signature|verif/i.test(r.output)) {
      // Old years are signed with keys that have since expired; the database
      // checksum was already verified above.
      r = await installTl(["-no-verify-downloads"]);
    }
    if (r.code !== 0) throw new Error(`install-tl failed:\n${tail(r.output)}`);
    this.release = db.release;
    this.installed = basic;
    this.changed = true;
    this.formatsDirty = true;
    this.stats.coldInstall = true;
    this.saveManifest();
  }

  private async fetchInstaller() {
    const dir = join(this.work, "installer");
    if (existsSync(join(dir, "install-tl"))) return;
    mkdirSync(dir, { recursive: true });
    const tgz = join(this.work, "install-tl-unx.tar.gz");
    writeFileSync(tgz, await fetchBytes(`${this.tlnet}/install-tl-unx.tar.gz`));
    const r = await run("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"]);
    if (r.code !== 0) throw new Error(`Could not unpack the TeX Live installer: ${r.output}`);
  }

  private async tlmgrInstall(names: string[]) {
    if (names.length === 0) return;
    await this.prefetch(names);
    const tlmgr = join(this.bin, "tlmgr");
    const install = (extra: string[] = []) => run(tlmgr, [...extra, "--repository", this.repo, "install", ...names], { env: this.env() });
    let r = await install();
    if (r.code !== 0 && /gpg|signature|verif/i.test(r.output)) r = await install(["--verify-repo=none"]);
    if (r.code !== 0 && /update --self|needs to be updated/i.test(r.output)) {
      await this.prefetch(["texlive.infra", `texlive.infra.${this.arch}`]);
      await run(tlmgr, ["--repository", this.repo, "update", "--self"], { env: this.env() });
      r = await install();
    }
    if (r.code !== 0) throw new Error(`tlmgr could not install ${names.join(", ")}:\n${tail(r.output)}`);
    for (const n of names) this.installed.add(n);
    this.changed = true;
    if (names.some((n) => this.formatTriggers().has(n))) this.formatsDirty = true;
    if (names.some((n) => this.db?.packages.get(n)?.executes.some((e) => /^add(Kanji|Mixed)?Map\b/.test(e)))) this.mapsDirty = true;
    this.saveManifest();
  }

  private triggers?: Set<string>;

  /** Packages whose installation changes a format (fmttriggers, AddFormat, AddHyphen). */
  private formatTriggers(): Set<string> {
    if (this.triggers) return this.triggers;
    const t = new Set<string>();
    for (const pkg of this.db?.packages.values() ?? []) {
      for (const e of pkg.executes) {
        if (/^(AddFormat|AddHyphen)\b/.test(e)) t.add(pkg.name);
        const m = /fmttriggers=(\S+)/.exec(e);
        if (m) for (const n of m[1].split(",")) t.add(n);
      }
    }
    return (this.triggers = t);
  }

  /**
   * Builds the formats for `engines` if they are missing or packages changed,
   * and the font maps if packages with maps were added: dvipdfmx finds
   * Japanese fonts (kanjix.map) only once updmap has run.
   */
  async ensureFormats(engines: Iterable<Engine>): Promise<void> {
    const wanted = new Set(engines);
    return this.mutex.lock(async () => {
      // A cached tree may predate its maps (or come from a version that did not
      // run updmap): check the map entry of the Japanese engines' base font.
      const kanjix = join(this.texdir, "texmf-var", "fonts", "map", "dvipdfmx", "updmap", "kanjix.map");
      const map = existsSync(kanjix) ? readFileSync(kanjix, "utf8") : "";
      for (const engine of wanted) {
        const base = engine === "platex" ? "rml" : engine === "uplatex" ? "uprml-h" : undefined;
        if (base && !new RegExp(`^${base}\\s`, "m").test(map)) this.mapsDirty = true;
      }
      if (this.mapsDirty) {
        const r = await run(join(this.bin, "updmap-sys"), [], { env: this.env() });
        if (r.code !== 0) this.log(`updmap-sys failed:\n${tail(r.output, 15)}`);
        this.mapsDirty = false;
        this.changed = true;
      }
      const web2c = join(this.texdir, "texmf-var", "web2c");
      for (const engine of wanted) {
        const exists = existsSync(web2c) && readdirSync(web2c).some((d) => existsSync(join(web2c, d, `${engine}.fmt`)));
        if (exists && !this.formatsDirty) continue;
        const r = await run(join(this.bin, "fmtutil-sys"), ["--byfmt", engine], { env: this.env() });
        if (r.code !== 0) throw new Error(`Building the ${engine} format failed:\n${tail(r.output)}`);
        this.changed = true;
      }
      this.formatsDirty = false;
    });
  }
}
