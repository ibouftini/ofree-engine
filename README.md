# ofree-engine

Fast, zero-configuration LaTeX builds on GitHub Actions.

**Status: early development.** It works on the bundled samples and is being benchmarked on real repositories. Expect changes.

## Use

```yaml
on: [push, pull_request]
jobs:
  pdf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: ibouftini/ofree-engine@main
```

Nothing else is needed. The action:

- **Finds the documents itself:** every `.tex` file with `\documentclass` that no other file includes, and tells the main one from drafts and figures (see below).
- **Picks the engine** (pdfLaTeX, XeLaTeX, LuaLaTeX, or pLaTeX and upLaTeX for Japanese) from `% !TeX program`, `.latexmkrc`, the class or the packages used, and says why. A `.latexmkrc` keeps its own route (upLaTeX then dvipdfmx, for example).
- **Installs only what the documents need:** the TeX Live packages, languages and fonts it reads from the sources. Anything still missing while compiling is installed and the document retried.
- **Finds fonts that are not in TeX Live:** font files in the repository are used as they are, by name. Other fonts are downloaded from Google Fonts, and Microsoft's core fonts (Arial, Times New Roman, Courier New, Georgia, Verdana, …) from Microsoft, under Microsoft's licence for them. Calibri and Cambria cannot be downloaded: Carlito and Caladea, which have the same character widths (so the same line and page breaks), stand in for them, with a warning. So do Fandol for the Windows Chinese fonts (`ctex` with `fontset=windows`) and IPAex for the IPA fonts.
- **Installs the programs documents run:** Ghostscript for EPS images, Inkscape for the `svg` package, gnuplot for `gnuplottex` and pgfplots, what Asymptote needs, only when a document uses them. Shell escape is turned on only for documents that need it.
- **Keeps that TeX Live in the Actions cache,** so later runs start in seconds.
- **Builds through LaTeX errors,** as Overleaf does: an undefined command or a missing figure still gives a PDF (with `??` where references are missing).
- **Explains what to fix:** the summary lists each real error once, at its file and line, with the command or text where TeX stopped and a plain-language hint. Errors that only follow from an earlier one are left out, and undefined references, citations and characters a font lacks are grouped.
- **Uploads the PDFs as an artifact,** also when they have errors.

### Several documents in one repository

Without `root_file`, one document decides whether the build passes, so an old draft cannot fail it. Files that are parts of a document are left out: those whose `% !TeX root` names another file, and `subfiles` parts. The main document is the file those comments name, else what `.latexmkrc` lists in `@default_files`, else `main.tex`, else the only document besides standalone figures. The others are built too and their PDFs uploaded, but their errors are only warnings.

If nothing marks a main document, every document must build. The summary then says how to mark one.

### Keeping the cache warm

GitHub deletes cache entries that have not been used for 7 days, so a document built less than once a week starts without its TeX Live (a first run takes 20–40 s instead of about 10 s). A weekly scheduled run that only restores the cache prevents that:

```yaml
on:
  schedule:
    - cron: "0 6 * * 1"   # every Monday
jobs:
  keep-warm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: ibouftini/ofree-engine@main
        with:
          keep_warm: true
```

It takes a few seconds (one billed minute a week on a private repository). Each project's cache entries are kept apart, so they stay the size of what its documents need.

### Runners

Tested on `ubuntu-24.04`, `ubuntu-26.04`, `ubuntu-24.04-arm`, `macos-latest`, and in a container job without `sudo`. Programs are installed with `apt`, so on macOS, install the ones a document needs in an earlier step.

### Coming from `xu-cheng/latex-action`

Change the `uses:` line. Its inputs (`root_file`, `working_directory`, `latexmk_use_xelatex`, `args`, `extra_system_packages`, `pre_compile`, …) are accepted as they are. `docker_image` and `os` are ignored, because no Docker image is used.

### Optional inputs

| Input | Default | Meaning |
|---|---|---|
| `on_error` | `fail` | With `fail`, LaTeX errors fail the step (the PDF is still uploaded); with `warn`, the step passes when a PDF was built |
| `microsoft_fonts` | `true` | Download Microsoft's core fonts when a document uses one; `false` uses metric-compatible free fonts (Tinos for Times New Roman, Arimo for Arial, …) |
| `shell_escape` | `auto` | `auto` enables it only for documents that need it (minted, svg, …); `always`; `never` |
| `extra_packages` | | TeX Live packages to add to the ones found automatically |
| `cache` | `true` | Reuse TeX Live across runs |
| `keep_warm` | `false` | Only keep the cached TeX Live alive, without compiling (see below) |
| `upload` | `true` | Upload the PDFs as a workflow artifact |
| `artifact_name` | `pdf` | Name of that artifact |

Outputs: `pdf` (paths of the PDFs, one per line) and `status`: `success`, `errors` (PDFs built through LaTeX errors) or `failure` (a document has no PDF).

If the workflow's `args` include `-halt-on-error`, the build stops at the first error instead, as it did with `xu-cheng/latex-action`.

## How it compares

The most-used LaTeX action, `xu-cheng/latex-action`, downloads a 2.3 GiB TeX Live image on every run: 84 s at the median, for a 14 s compilation. A typical document needs about 2 % of that.

**Real-world benchmark.** 42 public repositories that use `xu-cheng/latex-action` were built by both actions on GitHub-hosted runners. Each repository's own inputs were passed unchanged to both ([`bench-corpus.yml`](.github/workflows/bench-corpus.yml), generated by [`tools/make_corpus.py`](tools/make_corpus.py)). Measured 2026-11-04:

| | xu-cheng/latex-action@v4 | This action |
|---|---:|---:|
| Repositories built | 42 / 42 | 42 / 42 |
| Build step, median | 92 s | 12 s |
| Build step, mean | 107 s | 30 s |
| Whole job, median | 100 s | 20 s |

- **The corpus contains only repositories that can be built from their sources.** Repositories whose own CI fails at the tested commit, or whose `.tex` files are generated by earlier workflow steps, are left out.
- **The timing figures** come from a full run on this corpus.
- **Timings come from a run where most repositories had a cached TeX Live from an earlier run,** as they would in daily use.
- **The whole-job figures include `actions/checkout`,** which takes minutes for some large repositories.

**Japanese templates.** Ten Japanese thesis and report templates from university labs and students (Kyoto, Tokyo Tech, Tsukuba, Kochi, …) were built with nothing but their root file, both ways. They cover pLaTeX and upLaTeX through their `.latexmkrc`, `jsbook` without one, LuaLaTeX-ja, and `bxjsarticle`. Measured 2026-11-04:

| | xu-cheng/latex-action@v4 | This action |
|---|---:|---:|
| Templates built | 2 / 10 | 10 / 10 |
| Build step, with a cached TeX Live, median | 76 s (the two it builds) | 8 s |
| Build step, first run | | about 35 s |

`xu-cheng/latex-action` passes `-pdf`, which overrides the templates' `.latexmkrc`. The PDFs embed the HaranoAji fonts; Ghostscript, which the runners lack, is installed for the one template with EPS figures. The first-run figure is from the pLaTeX and upLaTeX samples in [`bench/samples`](bench/samples), built with the cache off.

On the samples in [`bench/samples`](bench/samples), build step only (one run, 2026-11-04; the incumbent's time varies a lot from run to run, here from 62 to 201 s):

| Sample | xu-cheng/latex-action@v4 | This action, first run | This action, cached |
|---|---:|---:|---:|
| paper (pdfLaTeX, Biber) | 133 s | 27 s | 7 s |
| arabic (XeLaTeX, polyglossia, Amiri) | 75 s | 29 s | 4 s |
| lua (LuaLaTeX, unicode-math, IEEE style) | 97 s | 29 s | 13 s |
| cv (local class, FontAwesome, Source Sans 3) | 201 s | 18 s | 4 s |
| book (chapters with `\include`, BibTeX/natbib, index, appendix) | 71 s | 17 s | 3 s |
| beamer (metropolis theme, overlays, TikZ) | 112 s | 26 s | 6 s |
| glossary (glossaries, acronyms, nomenclature) | 98 s | 24 s | 4 s |
| chinese (ctex, also with `fontset=windows`) | 108 s | 36 s | 8 s |
| urdu (polyglossia, Nastaliq with Graphite) | 76 s | 32 s | 7 s |
| bidi (Hebrew, Arabic, Persian and English; LuaLaTeX, babel) | 71 s | 20 s | 6 s |
| plots (pgfplots 2D and 3D, tikz-3dplot) | 84 s | 33 s | 9 s |
| chemistry (chemfig, mhchem, chemmacros, modiagram) | 62 s | 27 s | 8 s |
| roots (a main document, a broken draft, a standalone figure) | 191 s | 26 s | 3 s |
| uplatex, platex (`jsarticle`, no `.latexmkrc`) | fails | 36 s, 35 s | 4 s, 3 s |
| fonts (Times New Roman, Calibri, Noto Nastaliq Urdu, a font in the repository) | fails | 44 s | 6 s |
| errors (mistakes Overleaf forgives) | fails | 26 s | 8 s |
| programs (`svg`, gnuplot, Asymptote, minted, TikZ externalization) | fails | 43 s | 20 s |

`programs` stays slower when cached because Inkscape and the other programs come from `apt`, not the cache. In this action's output, the glossary, acronyms and nomenclature are filled in, the book's references, index and lists resolve, and the overlay frame becomes two pages. latexmk does not run the glossary and nomenclature tools by itself; this action adds those rules. `xu-cheng/latex-action` fails `errors` by design, as it stops at the first error.

A first run here spends about 11 s installing about 150 packages, 7 s building formats and font indexes, and the rest compiling.

## Development

```sh
corepack enable
pnpm install
pnpm test        # set TLPDB=/path/to/texlive.tlpdb to include the real-database tests
pnpm run build   # dist/ is committed; CI checks it is up to date
```
