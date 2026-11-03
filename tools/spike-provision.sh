#!/usr/bin/env bash
# Spike: time two ways of installing a minimal TeX Live on a fresh runner.
#   parallel   - fetch exactly the needed archives in parallel into a local
#                repository, then install from it (no network during install)
#   sequential - the classic way: install-tl and tlmgr straight from a mirror
# Usage: spike-provision.sh MODE ROOTS SAMPLE_DIR
set -euo pipefail

MODE=$1
ROOTS=$2
SAMPLE=$3
ARCH=x86_64-linux
WORK=${RUNNER_TEMP:-/tmp}/ofree-spike
TEXDIR=$HOME/.ofree/texlive
TIMINGS=$WORK/timings.md
mkdir -p "$WORK/repo/archive" "$WORK/repo/tlpkg" "$WORK/installer"
: > "$TIMINGS"

now() { date +%s.%N; }
lap() { python3 -c "import sys; print(f'| {sys.argv[1]} | {float(sys.argv[3]) - float(sys.argv[2]):.1f} |')" "$1" "$2" "$(now)" | tee -a "$TIMINGS"; }

T_ALL=$(now)

# 1. Pick the fastest of a few mirrors (one mirror for everything: mirrors drift).
t=$(now)
MIRRORS=(
  https://mirrors.mit.edu/CTAN
  https://mirrors.rit.edu/CTAN
  https://ctan.math.illinois.edu
  https://mirror.math.princeton.edu/pub/CTAN
  https://ctan.mirrors.hoobly.com
)
best="" best_t=999
for m in "${MIRRORS[@]}"; do
  s=$(curl -sS -o /dev/null --max-time 5 -w '%{time_total}' "$m/systems/texlive/tlnet/tlpkg/texlive.tlpdb.sha512" || echo 999)
  echo "mirror $m: ${s}s"
  if python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) < float(sys.argv[2]) else 1)" "$s" "$best_t"; then
    best=$m best_t=$s
  fi
done
TLNET=$best/systems/texlive/tlnet
echo "Using $TLNET"
for f in texlive.tlpdb.xz texlive.tlpdb.sha512 texlive.tlpdb.sha512.asc; do
  curl -sSfL --retry 3 -o "$WORK/repo/tlpkg/$f" "$TLNET/tlpkg/$f"
done
xz -dk "$WORK/repo/tlpkg/texlive.tlpdb.xz"
curl -sSfL --retry 3 -o "$WORK/install-tl-unx.tar.gz" "$TLNET/install-tl-unx.tar.gz"
tar -xzf "$WORK/install-tl-unx.tar.gz" -C "$WORK/installer" --strip-components=1
lap "pick mirror, fetch package database and installer" "$t"

python3 tools/closure.py "$WORK/repo/tlpkg/texlive.tlpdb" "$ARCH" "$ROOTS" > "$WORK/all.txt"
python3 tools/closure.py "$WORK/repo/tlpkg/texlive.tlpdb" "$ARCH" scheme-basic > "$WORK/basic.txt"
EXTRAS=$(python3 tools/closure.py "$WORK/repo/tlpkg/texlive.tlpdb" "$ARCH" "$ROOTS" scheme-basic | tr '\n' ' ')
echo "extras beyond scheme-basic: $EXTRAS"

cat > "$WORK/texlive.profile" <<EOF
selected_scheme scheme-basic
TEXDIR $TEXDIR
TEXMFLOCAL $TEXDIR/texmf-local
TEXMFSYSCONFIG $TEXDIR/texmf-config
TEXMFSYSVAR $TEXDIR/texmf-var
TEXMFHOME $TEXDIR/texmf-home
TEXMFCONFIG $TEXDIR/texmf-config
TEXMFVAR $TEXDIR/texmf-var
instopt_adjustpath 0
instopt_adjustrepo 0
instopt_letter 0
instopt_portable 0
instopt_write18_restricted 1
tlpdbopt_autobackup 0
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
EOF

if [[ $MODE == parallel ]]; then
  t=$(now)
  sed "s|.*|$TLNET/archive/&.tar.xz|" "$WORK/all.txt" |
    xargs -P 32 -I{} curl -sSfL --retry 3 --output-dir "$WORK/repo/archive" -O {}
  lap "download $(wc -l < "$WORK/all.txt") archives in parallel ($(du -sm "$WORK/repo/archive" | cut -f1) MiB)" "$t"
  REPO=$WORK/repo
else
  REPO=$TLNET
fi

t=$(now)
perl "$WORK/installer/install-tl" -no-gui -profile "$WORK/texlive.profile" -repository "$REPO" > "$WORK/install-tl.log" 2>&1 ||
  { tail -40 "$WORK/install-tl.log"; exit 1; }
lap "install-tl scheme-basic ($MODE)" "$t"

export PATH="$TEXDIR/bin/$ARCH:$PATH"
echo "$TEXDIR/bin/$ARCH" >> "${GITHUB_PATH:-/dev/null}"

if [[ -n ${EXTRAS// /} ]]; then
  t=$(now)
  # shellcheck disable=SC2086
  tlmgr --repository "$REPO" install $EXTRAS > "$WORK/tlmgr.log" 2>&1 || { tail -40 "$WORK/tlmgr.log"; exit 1; }
  lap "tlmgr install extras ($MODE)" "$t"
fi
echo "TeX Live size: $(du -sh "$TEXDIR" | cut -f1)"

t=$(now)
(cd "$SAMPLE" && latexmk -pdf -interaction=nonstopmode -file-line-error main.tex > "$WORK/latexmk.log" 2>&1) ||
  { tail -60 "$WORK/latexmk.log"; exit 1; }
lap "compile sample (latexmk, biber)" "$t"
lap "TOTAL" "$T_ALL"

{
  echo "### Provisioning spike: $MODE"
  echo
  echo "| Phase | Seconds |"
  echo "|---|---:|"
  cat "$TIMINGS"
  echo
  echo "Mirror: \`$best\`"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
