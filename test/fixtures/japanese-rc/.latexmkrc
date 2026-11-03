# As Japanese thesis templates write it: every tool configured, Biber included.
$latex     = 'uplatex -synctex=1 -halt-on-error %O %S';
$bibtex    = 'upbibtex %O %B';
$biber     = 'biber --bblencoding=utf8 -u -U --output_safechars %O %B';
$makeindex = 'upmendex %O -o %D %S';
$dvipdf    = 'dvipdfmx %O -o %D %S';
$pdf_mode  = 3;
