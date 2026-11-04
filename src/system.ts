// Programs documents run that TeX Live does not ship (Ghostscript, Inkscape,
// gnuplot, ...). The system's package manager installs them once, and exactly
// what it added is saved as a snapshot inside the cached TeX Live. Later runs
// only unpack the snapshot: 0.1 to 2 s, instead of 7 to 40 s with apt, whose
// time goes to dpkg and package scripts rather than to the files themselves.
//
// A snapshot is restored only on the OS it was made on, never overwrites a
// file (a newer library in the runner image stays), and the programs are
// checked afterwards: if one does not run, the package manager is used.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./util/exec.js";

type Manager = "apt" | "brew" | null;

/** Packages that provide a program or library. Absent names cannot be installed on that system. */
const PACKAGES: Record<string, { apt?: string[]; brew?: string }> = {
  gs: { apt: ["ghostscript"], brew: "ghostscript" },
  inkscape: { apt: ["inkscape"], brew: "--cask inkscape" },
  gnuplot: { apt: ["gnuplot-nox"], brew: "gnuplot" },
  // libglut3.12 since Ubuntu 23.04, freeglut3 before. macOS's asy does not use it.
  "libglut.so.3": { apt: ["libglut3.12", "freeglut3"] },
};

/** Whether this module knows how to install a program (log output names all sorts of things). */
export const knownProgram = (name: string) => name in PACKAGES;

interface Manifest {
  /** OS the snapshots were made on. */
  os: string;
  /** Packages they hold. */
  packages: string[];
}

/** "ubuntu-26.04", or "macos" with its major version: snapshots hold programs linked for that system. */
export function osIdentity(osRelease: string | null, darwinMajor?: string): string {
  if (darwinMajor) return `macos-${darwinMajor}`;
  const field = (k: string) => new RegExp(`^${k}="?([^"\\n]*)"?$`, "m").exec(osRelease ?? "")?.[1] ?? "";
  return `${field("ID") || "linux"}-${field("VERSION_ID") || "unknown"}`;
}

/** Whether a snapshot file list entry is worth keeping: documentation and packaging state are not. */
export function keepInSnapshot(path: string): boolean {
  return path !== "/." && !/^\/usr\/share\/(doc|man|locale|lintian|info)\/|^\/etc\/(ld\.so\.cache|machine-id)$|^\/var\/(cache|log|lib\/(dpkg|apt))\//.test(path);
}

export class SystemPrograms {
  /** True once a new snapshot exists: TeX Live must be saved to the cache with it. */
  changed = false;
  private readonly manager: Manager;
  private readonly os: string;
  private snapshots = 0;
  private osDarwin = process.platform === "darwin";

  constructor(
    /** The folder of snapshots, inside the cached TeX Live. */
    private readonly dir: string,
    /** A folder outside it, for snapshots made while TeX Live is still being installed. */
    private readonly pending: string,
    private readonly log: (message: string) => void,
    private readonly warn: (message: string) => void,
  ) {
    this.manager = this.osDarwin ? "brew" : process.platform === "linux" ? "apt" : null;
    const release = existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : null;
    this.os = osIdentity(release, this.osDarwin ? process.env.ImageOS?.replace(/^\D+/, "") || "any" : undefined);
    mkdirSync(pending, { recursive: true });
  }

  /** Whether a program or shared library (libglut.so.3) is on this machine. */
  async has(name: string): Promise<boolean> {
    if (/\.so(\.\d+)*$/.test(name)) return (await run("ldconfig", ["-p"])).output.includes(name);
    return (await run(name, ["--version"])).code === 0;
  }

  private manifestPath(dir = this.dir) {
    return join(dir, "manifest.json");
  }

  private manifest(dir = this.dir): Manifest {
    if (existsSync(this.manifestPath(dir))) {
      const m = JSON.parse(readFileSync(this.manifestPath(dir), "utf8")) as Manifest;
      if (m.os === this.os) return m;
    }
    return { os: this.os, packages: [] };
  }

  /** Runs a command as root (container jobs often are root, without sudo). */
  private root(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    return process.getuid?.() === 0 || this.osDarwin ? run(cmd, args, { env }) : run("sudo", [cmd, ...args], { env });
  }

  /** Unpacks every snapshot, leaving files that already exist alone. */
  private async restore(): Promise<boolean> {
    if (!existsSync(this.dir)) return false;
    const tars = readdirSync(this.dir).filter((f) => f.endsWith(".tar"));
    if (tars.length === 0) return false;
    for (const f of tars) await this.root("tar", ["-xf", join(this.dir, f), this.osDarwin ? "-k" : "--skip-old-files", "-C", "/"]);
    if (!this.osDarwin) await this.root("ldconfig", []);
    return true;
  }

  private async aptInstall(pkgs: string[]) {
    const env = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
    const install = (names: string[]) => this.root("apt-get", ["install", "-y", "-qq", "--no-install-recommends", ...names], env);
    // The runner's package lists are usually current enough; update only if that fails.
    if ((await install(pkgs)).code === 0) return;
    await this.root("apt-get", ["update", "-qq"], env);
    if ((await install(pkgs)).code === 0) return;
    // One unknown name should not block the others.
    for (const p of pkgs) if ((await install([p])).code !== 0) this.warn(`System package '${p}' could not be installed; continuing without it.`);
  }

  /** Installs packages with the package manager and saves what they added as a snapshot. */
  private async install(pkgs: string[], commands: string[]) {
    const marker = join(this.pending, "marker");
    writeFileSync(marker, "");
    const files = new Set<string>();
    const add = (output: string) => {
      for (const f of output.split("\n")) if (f.startsWith("/") && keepInSnapshot(f)) files.add(f);
    };
    if (this.manager === "apt") {
      const list = async () => (await run("dpkg-query", ["-W", "-f=${Package}\n"])).output.split("\n").filter(Boolean);
      const before = new Set(await list());
      await this.aptInstall(pkgs);
      const added = (await list()).filter((p) => !before.has(p));
      if (added.length) add((await run("dpkg", ["-L", ...added])).output);
      // What package scripts generated: alternatives, font and icon caches, ...
      const places = ["/etc", "/var/lib/ghostscript", "/usr/bin", "/usr/local/bin", "/usr/share/glib-2.0/schemas", "/usr/share/mime", "/usr/share/icons", "/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0", "/usr/lib/aarch64-linux-gnu/gdk-pixbuf-2.0"];
      add((await this.root("find", [...places.filter(existsSync), "-xdev", "-cnewer", marker, "(", "-type", "f", "-o", "-type", "l", ")"])).output);
    } else if (this.manager === "brew") {
      const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_ANALYTICS: "1" };
      for (const p of pkgs) {
        const r = await run("brew", ["install", "--quiet", ...p.split(" ")], { env });
        if (r.code !== 0) this.warn(`Homebrew could not install '${p}'; continuing without it.`);
      }
      const prefix = (await run("brew", ["--prefix"])).output.trim();
      for (const place of [join(prefix, "Cellar"), join(prefix, "Caskroom"), join(prefix, "opt"), join(prefix, "bin"), join(prefix, "lib"), join(prefix, "share"), join(prefix, "etc"), "/Applications/Inkscape.app"]) {
        if (existsSync(place)) add((await run("find", [place, "-cnewer", marker, "(", "-type", "f", "-o", "-type", "l", ")"])).output);
      }
    } else return;

    const missing = [];
    for (const c of commands) if (!(await this.has(c))) missing.push(c);
    // A snapshot of a failed install would only hide the failure on the next run.
    if (missing.length || files.size === 0) {
      if (missing.length) this.warn(`Could not install ${missing.join(", ")}.`);
      return;
    }
    const n = Date.now();
    const listFile = join(this.pending, `${n}.list`);
    writeFileSync(listFile, [...files].join("\n") + "\n");
    const tar = join(this.pending, `${n}.tar`);
    // tar's exit code is no guide: packages list files that diversions moved away.
    const r = await this.root("tar", ["-cf", tar, "--no-recursion", "-T", listFile]);
    if (!existsSync(tar)) {
      this.warn(`Could not save a snapshot of ${pkgs.join(", ")}: ${r.output.slice(-200)}`);
      return;
    }
    await this.root("chmod", ["a+r", tar]);
    const m = this.manifest(this.pending);
    m.packages = [...new Set([...m.packages, ...pkgs])];
    writeFileSync(this.manifestPath(this.pending), JSON.stringify(m));
    this.snapshots++;
  }

  private async packagesFor(program: string): Promise<string | undefined> {
    const known = PACKAGES[program];
    if (!known) return undefined;
    if (this.manager === "brew") return known.brew;
    if (this.manager !== "apt" || !known.apt) return undefined;
    if (known.apt.length === 1) return known.apt[0];
    for (const p of known.apt) if ((await run("apt-cache", ["show", p])).code === 0) return p;
    return known.apt[0];
  }

  /**
   * Makes the programs available: from the snapshot if it has them, otherwise
   * from the package manager. `packages` are installed whatever they provide
   * (the extra_system_packages input).
   */
  async ensure(programs: string[], packages: string[] = []): Promise<void> {
    const absent = [];
    for (const p of programs) if (PACKAGES[p] && !(await this.has(p))) absent.push(p);
    if (absent.length === 0 && packages.length === 0) return;
    if (!this.manager) {
      this.warn(`Install ${[...absent, ...packages].join(", ")} in an earlier step: this system has no known package manager.`);
      return;
    }
    const t = performance.now();
    const wanted = new Map<string, string | null>();
    for (const p of absent) {
      const pkg = await this.packagesFor(p);
      if (pkg) wanted.set(pkg, p);
    }
    for (const p of packages) {
      const there = this.manager === "apt" && /install ok installed/.test((await run("dpkg-query", ["-W", "-f=${Status}", p])).output);
      if (!there && !wanted.has(p)) wanted.set(p, null);
    }
    if (wanted.size === 0) return;

    const held = new Set(this.manifest().packages);
    if ([...wanted.keys()].some((p) => held.has(p)) && (await this.restore())) {
      this.log(`Restored ${[...wanted.keys()].filter((p) => held.has(p)).join(", ")} from the cached snapshot in ${Math.round((performance.now() - t) / 100) / 10} s`);
    }
    const toInstall = [];
    const toCheck = [];
    for (const [pkg, program] of wanted) {
      if (held.has(pkg) && (program === null || (await this.has(program)))) continue;
      toInstall.push(pkg);
      if (program) toCheck.push(program);
    }
    if (toInstall.length === 0) return;
    this.log(`Installing ${toInstall.join(", ")} (only this time: it is saved with the cached TeX Live)`);
    await this.install(toInstall, toCheck);
    this.log(`Installed in ${Math.round((performance.now() - t) / 100) / 10} s`);
  }

  /** Moves new snapshots into the cached TeX Live, once it is in place. */
  commit(): void {
    if (this.snapshots === 0) return;
    mkdirSync(this.dir, { recursive: true });
    const kept = this.manifest();
    // Snapshots of another OS are of no more use, and must not be unpacked with these.
    if (kept.packages.length === 0) for (const f of readdirSync(this.dir).filter((x) => x.endsWith(".tar"))) rmSync(join(this.dir, f));
    const made = this.manifest(this.pending);
    for (const f of readdirSync(this.pending).filter((x) => x.endsWith(".tar"))) copyFileSync(join(this.pending, f), join(this.dir, f));
    writeFileSync(this.manifestPath(), JSON.stringify({ os: this.os, packages: [...new Set([...kept.packages, ...made.packages])] }));
    this.snapshots = 0;
    this.changed = true;
  }
}
