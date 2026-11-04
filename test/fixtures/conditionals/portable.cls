\ProvidesClass{portable}
\newif\ifuse@biblatex\use@biblatexfalse
\DeclareOption{biblatex}{\use@biblatextrue}
\newif\ifuse@custom\use@customfalse
\newif\ifalways\alwaystrue
\DeclareOption*{\PassOptionsToClass{\CurrentOption}{report}}
\ProcessOptions\relax
\LoadClass{report}
\RequirePackage{ifxetex}
\ifuse@biblatex
  \RequirePackage[backend=biber]{biblatex}
\else
  \RequirePackage[numbers]{natbib}
\fi
\ifuse@custom
  \RequirePackage{neverloaded}
\fi
\ifalways
  \RequirePackage{setsomewhere}
\fi
\ifxetex
  \RequirePackage{fontspec}
  \setmathfont[Extension = .otf]{XITSMath-Regular}
  \setmainfont{XITS}[Extension = .otf, UprightFont = *-Regular, BoldFont = *-Bold]
\else
  \RequirePackage{mathptmx}
\fi
