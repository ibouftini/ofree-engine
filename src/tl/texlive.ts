// Owns one TeX Live installation: installs it cold, adds packages to it, and
// builds the formats the documents use. Network access happens only when
// something is missing.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Engine } from "../plan/scan.js";
import { Mutex, run } from "../util/exec.js";
import { downloadAll, fetchBytes, pickMirror, sha512 } from "./net.js";
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

  private installed = new Set<string>();
  private db?: Tlpdb;
  private index?: Map<string, string>;
  private tlnet?: string;
  private formatsDirty = false;
  private readonly mutex = new Mutex();
  private readonly repo: string;

  constructor(
    readonly texdir: string,
    readonly arch: string,
    private readonly work: string,
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

  env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${this.bin}${delimiter}${process.env.PATH ?? ""}`,
      // Biber unpacks itself on first run; keep that inside the cached tree.
      PAR_GLOBAL_TEMP: join(this.texdir, ".ofree", "par"),
    };
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
        ...dirs.map((d) => `  <dir>${d}</dir>`),
        `</fontconfig>`,
        ``,
      ].join("\n"),
    );
    if (this.changed || readdirSync(cacheDir).length === 0) {
      await run("fc-cache", dirs.filter((d) => existsSync(d)), { env: this.env() });
    }
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
    const tlnet = await pickMirror();
    const tlpkg = join(this.repo, "tlpkg");
    mkdirSync(tlpkg, { recursive: true });
    const [xz, sum, asc] = await Promise.all(
      ["texlive.tlpdb.xz", "texlive.tlpdb.sha512", "texlive.tlpdb.sha512.asc"].map((f) => fetchBytes(`${tlnet}/tlpkg/${f}`)),
    );
    writeFileSync(join(tlpkg, "texlive.tlpdb.xz"), xz);
    writeFileSync(join(tlpkg, "texlive.tlpdb.sha512"), sum);
    writeFileSync(join(tlpkg, "texlive.tlpdb.sha512.asc"), asc);
    const unxz = await run("xz", ["-dkf", join(tlpkg, "texlive.tlpdb.xz")]);
    if (unxz.code !== 0) throw new Error(`Could not decompress the package database: ${unxz.output}`);
    const raw = readFileSync(join(tlpkg, "texlive.tlpdb"));
    const expected = sum.toString("utf8").trim().split(/\s+/)[0];
    if (sha512(raw) !== expected) throw new Error(`The package database from ${tlnet} failed its checksum`);
    this.tlnet = tlnet;
    this.db = parseTlpdb(raw.toString("utf8"));
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
      if (this.present && this.release !== db.release) {
        // A cached installation from an older TeX Live year cannot take new packages.
        renameSync(this.texdir, `${this.texdir}.${this.release}-${Date.now()}`);
        this.installed = new Set();
      }
      const before = new Set(this.installed);
      if (!this.present) await this.coldInstall(wanted);
      const missing = [...wanted].filter((n) => !this.installed.has(n) && db.packages.has(n));
      await this.tlmgrInstall(missing);
      return [...this.installed].filter((n) => !before.has(n));
    });
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
    const r = await run("perl", [join(this.work, "installer", "install-tl"), "-no-gui", "-profile", profile, "-repository", this.repo]);
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
    const install = () => run(tlmgr, ["--repository", this.repo, "install", ...names], { env: this.env() });
    let r = await install();
    if (r.code !== 0 && /update --self|needs to be updated/i.test(r.output)) {
      await this.prefetch(["texlive.infra", `texlive.infra.${this.arch}`]);
      await run(tlmgr, ["--repository", this.repo, "update", "--self"], { env: this.env() });
      r = await install();
    }
    if (r.code !== 0) throw new Error(`tlmgr could not install ${names.join(", ")}:\n${tail(r.output)}`);
    for (const n of names) this.installed.add(n);
    this.changed = true;
    if (names.some((n) => this.formatTriggers().has(n))) this.formatsDirty = true;
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

  /** Builds the formats for `engines` if they are missing or packages changed. */
  async ensureFormats(engines: Iterable<Engine>): Promise<void> {
    return this.mutex.lock(async () => {
      const web2c = join(this.texdir, "texmf-var", "web2c");
      for (const engine of new Set(engines)) {
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
