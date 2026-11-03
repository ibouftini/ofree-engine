// Action entry point: plan, provision, compile, report, in one job.

import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { cacheAvailable, restoreTexLive, saveTexLive } from "./cache.js";
import { compileAll, EXTRA_LATEXMKRC, type CompileOptions } from "./compile/compile.js";
import type { Missing } from "./compile/logparse.js";
import { filesLoadedBy } from "./plan/deps.js";
import { fingerprint, fontPackage, languagePackages, requirementTokens, resolvePackages, type Resolution } from "./plan/resolve.js";
import { findRoots, listTexFiles, planDocument, type DocumentPlan, type Engine } from "./plan/scan.js";
import { Fonts, providable, type FontOutcome } from "./fonts.js";
import { annotate, digestText, summaryMarkdown } from "./report.js";
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
  // An engine named in the inputs, either way xu-cheng/latex-action accepts it.
  const args = core.getInput("args").split(/\s+/);
  const forced: Engine | undefined =
    bool("latexmk_use_xelatex") || args.some((a) => /^-(xelatex|pdfxe)$/.test(a))
      ? "xelatex"
      : bool("latexmk_use_lualatex") || args.some((a) => /^-(lualatex|pdflua)$/.test(a))
        ? "lualatex"
        : undefined;
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

/** Programs documents run that TeX Live does not ship, and the Ubuntu package that has them. */
const SYSTEM_PROGRAMS: Record<string, string> = { gs: "ghostscript" };

async function installSystemPackages(pkgs: string[]) {
  core.info(`Installing system packages: ${pkgs.join(" ")}`);
  const install = (names: string[]) =>
    run("sudo", ["apt-get", "install", "-y", "-qq", "--no-install-recommends", ...names], { env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } });
  // The runner's package lists are usually current enough; update only if that fails.
  let all = await install(pkgs);
  if (all.code === 0) return;
  await run("sudo", ["apt-get", "update", "-qq"]);
  all = await install(pkgs);
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
  const repository = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const workspace = resolve(repository, core.getInput("working_directory") || ".");
  // Annotations and links name files relative to the repository.
  const prefix = relative(repository, workspace).split(sep).join("/");
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
  // Ghostscript (for EPS images) is not on GitHub's runners; install it alongside.
  t = performance.now();
  const eps = docs.find((d) => d.eps);
  const ghostscript =
    eps && (await run("gs", ["--version"])).code !== 0
      ? (core.info(`${eps.root}: EPS image (${eps.eps!.file}:${eps.eps!.line}) needs Ghostscript; installing it alongside TeX Live`),
        installSystemPackages(["ghostscript"]))
      : Promise.resolve();
  const arch = texliveArch();
  const texdir = process.env.OFREE_TEXDIR ?? join(homedir(), ".ofree", "texlive");
  const work = join(process.env.RUNNER_TEMP ?? tmpdir(), "ofree");
  const useCache = core.getInput("cache") !== "false" && cacheAvailable();
  const restored = useCache ? await restoreTexLive(texdir, arch, fp) : { exact: false, key: undefined };
  const tl = new TexLive(texdir, arch, work, year);
  tl.log = (m) => core.info(m);
  core.info(`Cache: ${restored.key ? `${restored.exact ? "exact" : "partial"} match ${restored.key}` : "no entry"} (${seconds(t)} s)`);
  let resolution: Resolution | undefined;
  let provisionedFrom = restored.exact && tl.present ? "restored from the cache" : "";
  if (!provisionedFrom) {
    const { db, index } = await tl.database();
    resolution = resolvePackages(db, index, arch, docs, extraPackages);
    let s = performance.now();
    const installed = await tl.install(resolution.packages);
    core.info(`Installed ${installed.length} packages (${tl.stats.coldInstall ? "first install" : "added to the cached TeX Live"}) in ${seconds(s)} s`);
    // Read the files of every package the documents use, not only new ones:
    // a restored installation may predate their dependencies.
    s = performance.now();
    await completeDependencies(tl, arch, [...installed, ...resolution.reasons.keys()]);
    core.info(`Dependency check done in ${seconds(s)} s`);
    provisionedFrom = restored.key
      ? "restored from the cache, then completed"
      : `installed now (${tl.stats.coldInstall ? "first run" : "partial"})`;
  }
  let s = performance.now();
  await tl.ensureFormats(docs.map((d) => d.engine));
  // Fonts outside TeX Live: the repository's own, then downloads (see fonts.ts).
  const fonts = new Fonts(texdir, join(homedir(), ".ofree", "repository-fonts"), work, () => tl.env(), (m) => core.info(m));
  tl.extraFontDirs = [fonts.repositoryDir];
  await tl.ensureFontconfig();
  const extraFonts = list("extra_fonts").flatMap((p) => globSync(p, { cwd: workspace }).map((f) => join(workspace, f)));
  const registered = await fonts.registerRepository(workspace, extraFonts);
  if (registered) core.info(`Registered ${registered} font file(s) from the repository`);
  const microsoftFonts = core.getInput("microsoft_fonts") !== "false";
  const named = [...new Set(docs.flatMap((d) => [...d.fonts.keys()]))].filter(providable);
  const fontOutcomes: FontOutcome[] = await fonts.provide(named, microsoftFonts);
  for (const f of fontOutcomes.filter((f) => f.source === "substitute")) {
    core.warning(`"${f.name}" cannot be downloaded, so ${f.family} is used instead. ${f.note ?? ""} To use ${f.name} itself, add its font files to the repository.`, { title: `Font ${f.name} replaced by ${f.family}` });
  }
  if (fonts.changed) tl.changed = true;
  core.info(`Formats and fonts ready in ${seconds(s)} s`);
  phases.provision = seconds(t);

  await ghostscript;

  // 3. Optional user setup (compatibility inputs).
  t = performance.now();
  const sysPkgs = core.getInput("extra_system_packages").split(/\s+/).filter(Boolean).map(debianName);
  if (sysPkgs.length) await installSystemPackages(sysPkgs);
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
      const provided: string[] = [];
      for (const m of missing) {
        if (m.kind === "program" && SYSTEM_PROGRAMS[m.name] && (await run(m.name, ["--version"])).code !== 0) {
          await installSystemPackages([SYSTEM_PROGRAMS[m.name]]);
          if ((await run(m.name, ["--version"])).code === 0) provided.push(`${SYSTEM_PROGRAMS[m.name]} (system)`);
          continue;
        }
        if (m.kind === "language") {
          const pkgs = languagePackages(db, index, m.name).filter((p) => !tl.installedPackages().has(p));
          core.info(`Missing language ${m.name}: ${pkgs.join(", ") || "nothing to install"}`);
          for (const p of pkgs) roots.add(p);
          continue;
        }
        // NFSS reports "LGRcmr.fd" but loads the lowercase file name.
        const candidates = m.kind === "file" ? [m.name, m.name.toLowerCase(), `${m.name}.sty`, `${m.name}.tex`, `${m.name}.cls`, `${m.name}.tfm`] : [m.name];
        const pkg = m.kind === "font" ? fontPackage(db, index, m.name) : candidates.map((c) => index.get(c)).find(Boolean);
        const state = !pkg ? "no TeX Live package provides it" : tl.installedPackages().has(pkg) ? `${pkg}, already installed` : pkg;
        core.info(`Missing ${m.kind} ${m.name}: ${state}`);
        if (pkg && !tl.installedPackages().has(pkg)) roots.add(pkg);
        if (!pkg && m.kind === "font" && providable(m.name)) {
          const [outcome] = await fonts.provide([m.name], microsoftFonts);
          if (outcome && outcome.source !== "missing" && !fontOutcomes.some((f) => f.name === m.name)) {
            fontOutcomes.push(outcome);
            provided.push(`font ${m.name}`);
            if (fonts.changed) tl.changed = true;
          }
        }
        const fontName = m.name.replace(/\.tfm$/, "");
        if (!pkg && m.kind === "file" && (m.name.endsWith(".tfm") || /^[a-z]+\d{3,4}$/.test(fontName))) {
          const kit = metafontKit(fontName).filter((p) => !tl.installedPackages().has(p));
          if (kit.length) core.info(`Font ${fontName} is generated by METAFONT: adding ${kit.join(", ")}`);
          for (const p of kit) roots.add(p);
        }
      }
      if (roots.size === 0) return provided;
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
    // Build through errors unless the workflow's own args ask to stop at the first one.
    keepGoing: !userArgs.split(/\s+/).includes("-halt-on-error"),
    concurrency: Math.max(1, cpus().length),
    log: (m) => core.info(m),
  };
  if (opts.compiler === "latexmk") {
    opts.extraRc = join(work, "ofree.latexmkrc");
    mkdirSync(work, { recursive: true });
    writeFileSync(opts.extraRc, EXTRA_LATEXMKRC);
  }
  const results = await compileAll(workspace, docs, opts, () => tl.env(), recovery);
  phases.compile = seconds(t);
  for (const r of results) {
    core.info(digestText(r, prefix));
    core.startGroup(`${r.doc.root}: full log`);
    core.info(`--- ${r.doc.root}: build program output (end) ---\n${r.runOutput.slice(-20_000)}`);
    core.info(`--- ${r.doc.root}: engine log (end) ---\n${r.output.slice(r.runOutput.length).slice(-20_000)}`);
    core.endGroup();
  }
  await shell(core.getInput("post_compile"), workspace, tl.env(), "post_compile");

  // 5. Report, publish the PDFs, keep the environment for next time.
  t = performance.now();
  const pdfs = results.filter((r) => r.pdf).map((r) => r.pdf!);
  core.setOutput("pdf", pdfs.join("\n"));
  const failed = results.filter((r) => r.status === "failed");
  const withErrors = results.filter((r) => r.status === "errors");
  core.setOutput("status", failed.length ? "failure" : withErrors.length ? "errors" : "success");
  const onError = core.getInput("on_error") === "warn" ? "warn" : "fail";
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
  annotate(results, onError, prefix);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addRaw(
        summaryMarkdown({
          prefix,
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
          fonts: fontOutcomes,
        }),
      )
      .write();
  }
  if (useCache && tl.changed) {
    t = performance.now();
    const key = await saveTexLive(texdir, arch, fp);
    if (key) core.info(`Saved TeX Live to the cache as ${key} in ${seconds(t)} s`);
  }

  // Every document is always built; the step fails if one has no PDF, or has
  // LaTeX errors (its PDF is still uploaded) unless on_error is "warn".
  if (failed.length > 0) {
    core.setFailed(`${failed.length} of ${results.length} documents could not be built: ${failed.map((r) => r.doc.root).join(", ")}`);
  } else if (withErrors.length > 0 && onError === "fail") {
    core.setFailed(
      `LaTeX errors in ${withErrors.map((r) => `${r.doc.root} (${r.diagnosis.errors.length})`).join(", ")}. ` +
        `The PDF${withErrors.length > 1 ? "s were" : " was"} built and uploaded anyway; set on_error: warn to let the step pass.`,
    );
  }
}

main().catch((err) => core.setFailed(err instanceof Error ? err.message : String(err)));
