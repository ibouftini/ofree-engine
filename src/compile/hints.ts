// Plain-language explanations for the LaTeX errors people meet most, with the
// likely fix. Each takes the error and returns a hint, or nothing.

import { RENAMED_FONTS } from "../plan/resolve.js";
import type { Issue } from "./diagnose.js";

/** Packages that define commands and environments often used without loading them. */
const DEFINED_BY: Record<string, string> = {
  "\\includegraphics": "graphicx", "\\graphicspath": "graphicx", "\\textcolor": "xcolor", "\\color": "xcolor",
  "\\colorbox": "xcolor", "\\definecolor": "xcolor", "\\url": "url (or hyperref)", "\\href": "hyperref",
  "\\autoref": "hyperref", "\\cref": "cleveref", "\\Cref": "cleveref", "\\SI": "siunitx", "\\si": "siunitx",
  "\\qty": "siunitx", "\\unit": "siunitx", "\\num": "siunitx", "\\toprule": "booktabs", "\\midrule": "booktabs",
  "\\bottomrule": "booktabs", "\\multirow": "multirow", "\\ce": "mhchem", "\\mathbb": "amssymb", "\\mathfrak": "amssymb",
  "\\text": "amsmath", "\\eqref": "amsmath", "\\DeclareMathOperator": "amsmath", "\\numberwithin": "amsmath",
  "\\boldsymbol": "amsmath", "\\bm": "bm", "\\lipsum": "lipsum", "\\blindtext": "blindtext", "\\todo": "todonotes",
  "\\hl": "soul", "\\ul": "soul", "\\sout": "ulem", "\\uline": "ulem", "\\subfloat": "subfig", "\\captionof": "caption",
  "\\FloatBarrier": "placeins", "\\citep": "natbib", "\\citet": "natbib", "\\addbibresource": "biblatex",
  "\\printbibliography": "biblatex", "\\textcite": "biblatex", "\\parencite": "biblatex", "\\autocite": "biblatex",
  "\\printglossaries": "glossaries", "\\gls": "glossaries", "\\acrshort": "glossaries (or acronym)", "\\ac": "acronym",
  "\\checkmark": "amssymb", "\\nicefrac": "nicefrac", "\\sfrac": "xfrac", "\\SetKwInOut": "algorithm2e",
  "\\State": "algpseudocode", "\\Require": "algpseudocode", "\\lstinputlisting": "listings", "\\inputminted": "minted",
  "\\tikz": "tikz", "\\usetikzlibrary": "tikz", "\\pgfplotsset": "pgfplots", "\\chemfig": "chemfig",
  "\\faGithub": "fontawesome5", "\\faEnvelope": "fontawesome5", "\\euro": "eurosym", "\\degree": "gensymb",
  "\\celsius": "gensymb", "\\newgeometry": "geometry", "\\onehalfspacing": "setspace", "\\doublespacing": "setspace",
  "\\fancyhead": "fancyhdr", "\\fancyfoot": "fancyhdr", "\\titleformat": "titlesec",
  "\\setlist": "enumitem", "\\xspace": "xspace", "\\enquote": "csquotes",
};

const ENV_DEFINED_BY: Record<string, string> = {
  align: "amsmath", "align*": "amsmath", gather: "amsmath", multline: "amsmath", split: "amsmath", cases: "amsmath",
  pmatrix: "amsmath", bmatrix: "amsmath", proof: "amsthm", tikzpicture: "tikz", axis: "pgfplots", lstlisting: "listings",
  minted: "minted", algorithm: "algorithm", algorithmic: "algpseudocode", subfigure: "subcaption", longtable: "longtable",
  tabularx: "tabularx", multicols: "multicol", wrapfigure: "wrapfig", landscape: "pdflscape", spacing: "setspace",
  comment: "comment", appendices: "appendix", tcolorbox: "tcolorbox", mdframed: "mdframed", circuitikz: "circuitikz",
};

const loadHint = (pkg: string | undefined, what: string) =>
  pkg ? `${what} comes from the **${pkg}** package: add \`\\usepackage{${pkg.split(" ")[0]}}\` to the preamble.` : undefined;

type Rule = [RegExp, (m: RegExpExecArray, issue: Issue, similar: (name: string) => string[]) => string | undefined];

const RULES: Rule[] = [
  [/^Undefined control sequence/, (_m, i) =>
    i.culprit
      ? loadHint(DEFINED_BY[i.culprit], `\`${i.culprit}\``) ??
        `\`${i.culprit}\` is not defined: check its spelling, or load the package that defines it.`
      : "A command is not defined: check its spelling, or load the package that defines it."],
  [/Environment (\S+) undefined/, (m) =>
    loadHint(ENV_DEFINED_BY[m[1]], `The \`${m[1]}\` environment`) ??
    `The \`${m[1]}\` environment is not defined: check its spelling, or load the package that defines it.`],
  [/^Missing \$ inserted/, () =>
    "Math (`^`, `_`, `\\alpha`, …) is used outside math mode: put it between `$…$`. A blank line inside an equation also causes this."],
  [/^Extra alignment tab has been changed/, () => "This table row has more `&` than the table has columns."],
  [/^Misplaced alignment tab character/, () =>
    "An `&` outside a table or alignment. Write `\\&` for an ampersand in text; in equations, use an environment such as `align` (amsmath)."],
  [/perhaps a missing \\item/, () => "A list has text before its first `\\item`, or has no `\\item` at all."],
  [/^Lonely \\item/, () => "`\\item` is used outside `itemize`, `enumerate` or `description`."],
  [/\\begin\{([^}]+)\} on input line (\d+) ended by \\end\{([^}]+)\}/, (m) =>
    `\`\\begin{${m[1]}}\` (line ${m[2]}) is closed by \`\\end{${m[3]}}\`. Check the spelling, and that environments close in reverse order.`],
  [/\\begin\{document\} ended by \\end\{([^}]+)\}/, (m) => `There is an \`\\end{${m[1]}}\` without a matching \`\\begin{${m[1]}}\`.`],
  [/File [`'‘]([^'’]+)['’] not found/, (m, _i, similar) => {
    const name = m[1];
    const alt = similar(name);
    if (alt.length) return `There is no \`${name}\`, but there is \`${alt[0]}\`: check the folder and the extension.`;
    if (/\.(sty|cls)$/.test(name)) return `No TeX Live package provides \`${name}\`: check its name, or add the file to the repository.`;
    return `\`${name}\` is not in the repository at this path. Paths are relative to the main document; check that the file is committed.`;
  }],
  [/Unicode character (\S+) \(U\+([0-9A-F]+)\)/, (m) =>
    `pdfLaTeX cannot typeset ${m[1]}. Compile with XeLaTeX or LuaLaTeX (add \`% !TeX program = xelatex\` as the first line) with a font that has it, or replace the character with a LaTeX command.`],
  [/^Missing \\begin\{document\}/, () => "Text or a stray character is in the preamble, before `\\begin{document}`."],
  [/^(?:File ended while scanning use of|Paragraph ended before) (\\[A-Za-z@]+)/, (m) =>
    `The argument of \`${m[1]}\` never ends: a closing brace \`}\` is missing.`],
  [/^Runaway argument/, () => "A closing brace `}` is missing."],
  [/^Too many \}'s|^Extra \}, or forgotten/, () => "There is a closing brace `}` without a matching `{`."],
  [/^Missing \} inserted|^Missing \{ inserted/, () => "Braces `{ }` are unbalanced, often inside math."],
  [/^Double (superscript|subscript)/, (m) =>
    `Two ${m[1]}s in a row (such as \`x^a^b\`): group them with braces, \`x^{a^b}\` or \`{x^a}^b\`.`],
  [/Option clash for package (\S+)/, (m) =>
    `\`${m[1]}\` is loaded twice with different options (the class or another package may load it first). Pass the options once, before it is loaded, with \`\\PassOptionsToPackage{…}{${m[1]}}\`.`],
  [/Command (\\\S+) already defined/, (m) => `A package already defines \`${m[1]}\`: choose another name, or use \`\\renewcommand\`.`],
  [/^Missing number, treated as zero|^Illegal unit of measure/, () =>
    "A length or number is missing or malformed, for example `width=0.5` instead of `width=0.5\\linewidth`."],
  [/Can be used only in preamble/, () => "This command must come before `\\begin{document}`."],
  [/^There's no line here to end/, () => "`\\\\` or `\\newline` where no line exists (after a blank line or at the start of a paragraph). Use `\\vspace{…}` for space instead."],
  [/Undefined color [`'‘]([^'’]+)['’]/, (m) => `The colour \`${m[1]}\` is not defined: define it with \`\\definecolor\`, or use a known name such as \`red\` or \`blue!50\`.`],
  [/^Not in outer par mode/, () => "A figure or table is inside a box, a table cell or another float."],
  [/^Too many unprocessed floats/, () => "Too many figures or tables in a row: add `\\clearpage`, or use the placement `[H]` from the float package."],
  [/Unknown graphics extension: (\S+)/, (m) => `This engine cannot include ${m[1]} images: convert them to PDF or PNG.`],
  [/^TeX capacity exceeded/, () => "Usually a command that calls itself without end, or a very large plot or table."],
  [/^Dimension too large|^Arithmetic overflow/, () => "A number is too large for TeX, often in a plot: rescale the data, or use `compat=newest` with pgfplots."],
  [/The font "([^"]+)" cannot be found/, (m) =>
    RENAMED_FONTS[m[1].toLowerCase()]
      ? `TeX Live now names this font **"${RENAMED_FONTS[m[1].toLowerCase()]}"**: use that name in the document.`
      : `The font "${m[1]}" is not in TeX Live or the repository. Add its files to the repository, or use a font that TeX Live has.`],
  [/I was expecting a [`'‘],' or a [`'‘]\}'/, () => "A field in this .bib entry does not end with a comma."],
  [/I didn't find a database entry/, () => "The citation key is not in any of the .bib files."],
];

export function hintFor(issue: Issue, similar: (name: string) => string[]): string | undefined {
  for (const [re, make] of RULES) {
    const m = re.exec(issue.message);
    if (m) return make(m, issue, similar);
  }
  return undefined;
}
