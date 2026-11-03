// Action entry point: plan, provision, compile, report, in one job.

import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { cacheAvailable, restoreTexLive, saveTexLive } from "./cache.js";
import { compileAll, type CompileOptions } from "./compile/compile.js";
import type { Missing } from "./compile/logparse.js";
import { filesLoadedBy } from "./plan/deps.js";
import { fingerprint, fontPackage, languagePackages, requirementTokens, resolvePackages, type Resolution } from "./plan/resolve.js";
import { findRoots, listTexFiles, planDocument, type DocumentPlan, type Engine } from "./plan/scan.js";
import { annotate, summaryMarkdown } from "./report.js";
import { TexLive, texliveArch } from "./tl/texlive.js";
import { closure } from "./tl/tlpdb.js";
import { run, seconds } from "./util/exec.js";

const bool = (name: string) => /^(true|yes|1|on)$/i.test(core.getInput(name).trim());
const list = (name: string) =>
  core
    .getInput(name)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

function expand(workspace: string, patterns: string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    if (/[*?[{]/.test(p)) out.push(...globSync(p, { cwd: workspace }).filter((f) => f.endsWith(".tex")));
    else out.push(p);
  }
  return [...new Set(out)];
}

function plan(workspace: string): DocumentPlan[] {
  const forced: Engine | undefined = bool("latexmk_use_xelatex") ? "xelatex" : bool("latexmk_use_lualatex") ? "lualatex" : undefined;
  const given = expand(workspace, core.getMultilineInput("root_file").flatMap((l) => l.split(/\s*\n\s*/)).filter(Boolean));
  if (given.length > 0) {
    // Compatibility with xu-cheng/latex-action: compile from the working directory
    // unless work_in_root_file_dir is set.
    const inRootDir = bool("work_in_root_file_dir");
    for (const g of given) if (!existsSync(join(workspace, g))) throw new Error(`File '${g}' cannot be found from the directory '${workspace}'.`);
    return given.map((root) => planDocument(workspace, root, { engine: forced, cwd: inRootDir ? dirname(root) : "." }));
  }
  const roots = findRoots(workspace, listTexFiles(workspace));
  if (roots.length === 0) throw new Error("No LaTeX document found: no .tex file contains \\documentclass.");
  return roots.map((root) => planDocument(workspace, root, { engine: forced }));
}

/**
 * xu-cheng/latex-action runs on Alpine by default, so existing workflows name
 * Alpine packages. Translate the common ones to Ubuntu's names.
 */
function debianName(pkg: string): string {
  const known: Record<string, string> = {
    "py-pygments": "python3-pygments",
    "py3-pygments": "python3-pygments",
    "font-noto": "fonts-noto",
    "font-noto-cjk": "fonts-noto-cjk",
    "font-noto-emoji": "fonts-noto-color-emoji",
    "font-dejavu": "fonts-dejavu",
    "font-liberation": "fonts-liberation",
    "ttf-dejavu": "fonts-dejavu",
    "ttf-liberation": "fonts-liberation",
    "openjdk17-jre": "openjdk-17-jre-headless",
  };
  if (known[pkg]) return known[pkg];
  if (/^perl-[a-z0-9-]+$/.test(pkg)) return `lib${pkg.slice(5)}-perl`;
  if (/^py3-/.test(pkg)) return `python3-${pkg.slice(4)}`;
  if (/^font-/.test(pkg)) return `fonts-${pkg.slice(5)}`;
  return pkg;
}

async function installSystemPackages(pkgs: string[]) {
  core.info(`Installing system packages: ${pkgs.join(" ")}`);
  await run("sudo", ["apt-get", "update", "-qq"]);
  const all = await run("sudo", ["apt-get", "install", "-y", "-qq", "--no-install-recommends", ...pkgs], {
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
  });
  if (all.code === 0) return;
  // One unknown name should not block the others.
  for (const p of pkgs) {
    const r = await run("sudo", ["apt-get", "install", "-y", "-qq", "--no-install-recommends", p], {
      env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
    });
    if (r.code !== 0) core.warning(`System package '${p}' could not be installed; continuing without it.`);
  }
}

async function shell(script: string, cwd: string, env: NodeJS.ProcessEnv, what: string) {
  if (!script.trim()) return;
  core.info(`Running ${what}`);
  let r = await run("bash", ["-eo", "pipefail", "-c", script], { cwd, env });
  core.info(r.output);
  if (r.code !== 0 && /Permission denied|Operation not permitted|Read-only file system|cannot create/i.test(r.output)) {
    // xu-cheng/latex-action runs these scripts as root inside its container;
    // scripts written for it may write to system folders.
    core.notice(`${what} needed administrator rights; running it again with sudo.`);
    r = await run("sudo", ["-E", "env", `PATH=${env.PATH ?? ""}`, "bash", "-eo", "pipefail", "-c", script], { cwd, env });
    core.info(r.output);
  }
  if (r.code !== 0) throw new Error(`${what} failed with exit code ${r.code}`);
}

/**
 * Installs what newly installed packages load themselves (read from their
 * files on disk), repeating until nothing new is needed.
 */
async function completeDependencies(tl: TexLive, arch: string, seed: string[]): Promise<string[]> {
  if (seed.length === 0) return [];
  const { db, index } = await tl.database();
  const basic = closure(db, arch, ["scheme-basic"]);
  const scanned = new Set<string>(basic);
  const added: string[] = [];
  let frontier = seed;
  for (let round = 0; round < 12 && frontier.length > 0; round++) {
    const wanted = new Set<string>();
    for (const name of frontier) {
      if (scanned.has(name)) continue;
      scanned.add(name);
      for (const file of tl.sourceFiles(name, /\.(sty|cls|def|code\.tex)$/)) {
        for (const req of filesLoadedBy(readFileSync(file, "latin1"))) {
          const owner = index.get(req) ?? (req.startsWith("tikzlibrary") ? index.get(req.replace(/^tikzlibrary/, "pgflibrary")) : undefined);
          if (owner && !tl.installedPackages().has(owner)) wanted.add(owner);
        }
      }
    }
    if (wanted.size === 0) break;
    const installed = await tl.install(closure(db, arch, wanted));
    added.push(...installed);
    frontier = installed;
  }
  if (added.length) core.info(`Installed ${added.length} packages that installed packages load themselves: ${added.join(", ")}`);
  return added;
}

/**
 * Fonts TeX Live generates with METAFONT on demand (Cyrillic LH fonts, for
 * example) have no file to install: install METAFONT and the font sources.
 */
function metafontKit(font: string): string[] {
  const kit = ["metafont", "mfware", "modes"];
  if (/^(l[a-hwx]|rx)[a-z]{2}\d{3,4}$/.test(font)) kit.push("lh", "cm-super");
  else if (/^(ec|tc)[a-z]{2}\d{3,4}$/.test(font)) kit.push("ec", "cm-super");
  else if (/^g[a-z]{3}\d{3,4}$/.test(font)) kit.push("cbfonts");
  return kit;
}

async function main() {
  const phases: Record<string, number> = {};
  let t = performance.now();
  const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), core.getInput("working_directory") || ".");
  mkdirSync(workspace, { recursive: true });
  for (const ignored of ["docker_image", "os"]) {
    if (core.getInput(ignored)) core.notice(`Input '${ignored}' is ignored: this action installs TeX Live directly, without Docker.`);
  }
  const texliveVersion = core.getInput("texlive_version").trim();
  if (texliveVersion && !/^(latest|\d{4})$/.test(texliveVersion)) throw new Error(`Unsupported texlive_version '${texliveVersion}'`);
  const year = /^\d{4}$/.test(texliveVersion) ? Number(texliveVersion) : undefined;

  // 1. Plan: read the sources, nothing installed yet.
  const docs = plan(workspace);
  const extraPackages = list("extra_packages");
  const tokens = [...requirementTokens(docs, extraPackages), ...(year ? [`texlive:${year}`] : [])].sort();
  const fp = fingerprint(tokens);
  for (const d of docs) core.info(`${d.root}: ${d.engine} (${d.engineReason}); ${d.requires.size} files required`);
  phases.plan = seconds(t);

  // 2. Provision TeX Live: cache first, network only for what is missing.
  t = performance.now();
  const arch = texliveArch();
  const texdir = process.env.OFREE_TEXDIR ?? join(homedir(), ".ofree", "texlive");
  const work = join(process.env.RUNNER_TEMP ?? tmpdir(), "ofree");
  const useCache = core.getInput("cache") !== "false" && cacheAvailable();
  const restored = useCache ? await restoreTexLive(texdir, arch, fp) : { exact: false, key: undefined };
  const tl = new TexLive(texdir, arch, work, year);
  let resolution: Resolution | undefined;
  let provisionedFrom = restored.exact && tl.present ? "restored from the cache" : "";
  if (!provisionedFrom) {
    const { db, index } = await tl.database();
    resolution = resolvePackages(db, index, arch, docs, extraPackages);
    const installed = await tl.install(resolution.packages);
    // Read the files of every package the documents use, not only new ones:
    // a restored installation may predate their dependencies.
    await completeDependencies(tl, arch, [...installed, ...resolution.reasons.keys()]);
    provisionedFrom = restored.key
      ? "restored from the cache, then completed"
      : `installed now (${tl.stats.coldInstall ? "first run" : "partial"})`;
  }
  await tl.ensureFormats(docs.map((d) => d.engine));
  await tl.ensureFontconfig();
  phases.provision = seconds(t);

  // 3. Optional user setup (compatibility inputs).
  t = performance.now();
  const sysPkgs = core.getInput("extra_system_packages").split(/\s+/).filter(Boolean).map(debianName);
  if (sysPkgs.length) await installSystemPackages(sysPkgs);
  const fonts = list("extra_fonts");
  if (fonts.length) {
    const fontDir = join(homedir(), ".local", "share", "fonts");
    mkdirSync(fontDir, { recursive: true });
    for (const pattern of fonts) for (const f of globSync(pattern, { cwd: workspace })) copyFileSync(join(workspace, f), join(fontDir, basename(f)));
    await run("fc-cache", ["-f", fontDir]);
  }
  await shell(core.getInput("pre_compile"), workspace, tl.env(), "pre_compile");
  phases.setup = seconds(t);

  // 4. Compile, recovering from what the engine can fix itself.
  t = performance.now();
  let direct = resolution ? [...resolution.reasons.keys()] : undefined;
  const recovery = {
    installMissing: async (missing: Missing[]) => {
      const { db, index } = await tl.database();
      direct ??= [...resolvePackages(db, index, arch, docs, extraPackages).reasons.keys()];
      const roots = new Set<string>();
      for (const m of missing) {
        if (m.kind === "language") {
          const pkgs = languagePackages(db, index, m.name).filter((p) => !tl.installedPackages().has(p));
          core.info(`Missing language ${m.name}: ${pkgs.join(", ") || "nothing to install"}`);
          for (const p of pkgs) roots.add(p);
          continue;
        }
        // NFSS reports "LGRcmr.fd" but loads the lowercase file name.
        const candidates = m.kind === "file" ? [m.name, m.name.toLowerCase(), `${m.name}.sty`, `${m.name}.tex`, `${m.name}.cls`] : [m.name];
        const pkg = m.kind === "font" ? fontPackage(db, index, m.name) : candidates.map((c) => index.get(c)).find(Boolean);
        const state = !pkg ? "no TeX Live package provides it" : tl.installedPackages().has(pkg) ? `${pkg}, already installed` : pkg;
        core.info(`Missing ${m.kind} ${m.name}: ${state}`);
        if (pkg && !tl.installedPackages().has(pkg)) roots.add(pkg);
        const fontName = m.name.replace(/\.tfm$/, "");
        if (!pkg && m.kind === "file" && (m.name.endsWith(".tfm") || /^[a-z]+\d{3,4}$/.test(fontName))) {
          const kit = metafontKit(fontName).filter((p) => !tl.installedPackages().has(p));
          if (kit.length) core.info(`Font ${fontName} is generated by METAFONT: adding ${kit.join(", ")}`);
          for (const p of kit) roots.add(p);
        }
      }
      if (roots.size === 0) return [];
      const installed = await tl.install(closure(db, arch, roots));
      installed.push(...(await completeDependencies(tl, arch, [...installed, ...direct])));
      await tl.ensureFormats(docs.map((d) => d.engine));
      return installed;
    },
    ensureEngine: async (engine: Engine) => {
      if (engine === "xelatex") {
        const { db } = await tl.database();
        await tl.install(closure(db, arch, ["xetex"]));
      }
      await tl.ensureFormats([engine]);
    },
  };
  const userArgs = core.getInput("args").trim();
  const opts: CompileOptions = {
    compiler: core.getInput("compiler") || "latexmk",
    args: userArgs ? userArgs.split(/\s+/).filter((a) => !/^-(pdf|xelatex|lualatex|pdflua|pdfxe)$/.test(a)) : ["-interaction=nonstopmode", "-file-line-error", "-halt-on-error"],
    shellEscape: bool("latexmk_shell_escape") ? "always" : ((core.getInput("shell_escape") || "auto") as CompileOptions["shellEscape"]),
    concurrency: Math.max(1, cpus().length),
    log: (m) => core.info(m),
  };
  const results = await compileAll(workspace, docs, opts, () => tl.env(), recovery);
  phases.compile = seconds(t);
  for (const r of results) {
    core.startGroup(`${r.doc.root}: ${r.ok ? "built" : "failed"} (log)`);
    const errors = r.findings.problems.filter((p) => p.severity === "error");
    if (errors.length) core.info(`Errors:\n${errors.map((p) => `  ${p.file ? `${p.file}:${p.line}: ` : ""}${p.message}`).join("\n")}\n`);
    core.info(`--- ${r.doc.root}: build program output (end) ---\n${r.runOutput.slice(-20_000)}`);
    core.info(`--- ${r.doc.root}: engine log (end) ---\n${r.output.slice(r.runOutput.length).slice(-20_000)}`);
    core.endGroup();
  }
  await shell(core.getInput("post_compile"), workspace, tl.env(), "post_compile");

  // 5. Report, publish the PDFs, keep the environment for next time.
  t = performance.now();
  const pdfs = results.filter((r) => r.pdf).map((r) => r.pdf!);
  core.setOutput("pdf", pdfs.join("\n"));
  core.setOutput("status", results.every((r) => r.ok) ? "success" : "failure");
  let artifactUrl: string | undefined;
  if (process.env.GITHUB_ACTIONS === "true" && core.getInput("upload") !== "false" && pdfs.length > 0) {
    try {
      const name = core.getInput("artifact_name") || "pdf";
      const { id } = await new DefaultArtifactClient().uploadArtifact(name, pdfs.map((p) => join(workspace, p)), workspace);
      const { GITHUB_SERVER_URL: s, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = process.env;
      if (id && s && repo && runId) artifactUrl = `${s}/${repo}/actions/runs/${runId}/artifacts/${id}`;
    } catch (err) {
      core.warning(`Could not upload the PDFs: ${err instanceof Error ? err.message : err}`);
    }
  }
  phases.publish = seconds(t);
  annotate(results);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addRaw(
        summaryMarkdown({
          results,
          phases,
          provisionedFrom,
          release: tl.release,
          packageCount: tl.installedPackages().size,
          downloadedPackages: tl.stats.packagesDownloaded,
          downloadedMiB: tl.stats.bytesDownloaded / 1048576,
          mirror: tl.mirror,
          resolution,
          artifactUrl,
        }),
      )
      .write();
  }
  if (useCache && tl.changed) {
    t = performance.now();
    const key = await saveTexLive(texdir, arch, fp);
    if (key) core.info(`Saved TeX Live to the cache as ${key} in ${seconds(t)} s`);
  }

  // Every document is always built; like xu-cheng/latex-action with
  // continue_on_error, the step still fails if any document failed.
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    core.setFailed(`${failed.length} of ${results.length} documents could not be built: ${failed.map((r) => r.doc.root).join(", ")}`);
  }
}

main().catch((err) => core.setFailed(err instanceof Error ? err.message : String(err)));
