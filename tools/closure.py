"""Print the TeX Live packages needed for a set of roots, following `depend` lines.

Usage: python3 closure.py TLPDB ARCH ROOTS [MINUS_ROOTS]
  ROOTS and MINUS_ROOTS are comma-separated package or scheme names.
  Prints one package name per line; a size summary goes to stderr.
"""
import sys


def load(path):
    pkgs, cur = {}, None
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("name "):
                cur = {"name": line[5:].strip(), "dep": [], "size": 0}
                pkgs[cur["name"]] = cur
            elif cur and line.startswith("depend "):
                cur["dep"].append(line[7:].strip())
            elif cur and line.startswith("containersize "):
                cur["size"] = int(line.split()[1])
    return pkgs


def closure(pkgs, arch, roots):
    seen, stack = set(), [r for r in roots if r]
    while stack:
        name = stack.pop().replace(".ARCH", "." + arch)
        if name in seen or name not in pkgs:
            continue
        seen.add(name)
        stack.extend(pkgs[name]["dep"])
    return seen


def main():
    tlpdb, arch, roots = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
    minus = sys.argv[4].split(",") if len(sys.argv) > 4 else []
    pkgs = load(tlpdb)
    names = closure(pkgs, arch, roots) - closure(pkgs, arch, minus)
    size = sum(pkgs[n]["size"] for n in names) / 1048576
    print(f"{len(names)} packages, {size:.1f} MiB compressed", file=sys.stderr)
    print("\n".join(sorted(names)))


if __name__ == "__main__":
    main()
