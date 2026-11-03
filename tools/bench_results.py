"""Summarize a benchmark run: job duration per entry and variant, plus totals.

Reads the current run's jobs through the GitHub API (needs GH_TOKEN,
GITHUB_REPOSITORY and GITHUB_RUN_ID) and prints a Markdown report.
Job names must look like "<variant> · <entry>".
"""
import datetime as dt
import json
import os
import statistics
import subprocess

repo, run_id = os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_RUN_ID"]
raw = subprocess.run(
    ["gh", "api", "--paginate", f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100", "--jq", ".jobs[]"],
    capture_output=True, text=True, check=True,
).stdout
jobs = [json.loads(line) for line in raw.splitlines() if line.strip()]
ts = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))

rows = {}
for j in jobs:
    if " · " not in j["name"] or not j.get("completed_at") or not j.get("started_at"):
        continue
    variant, entry = j["name"].split(" · ", 1)
    secs = round((ts(j["completed_at"]) - ts(j["started_at"])).total_seconds())
    rows.setdefault(entry, {})[variant] = (secs, j["conclusion"])

variants = sorted({v for r in rows.values() for v in r}, key=lambda v: (v != "incumbent", v))
print("## Benchmark: job duration in seconds\n")
print("| Entry | " + " | ".join(variants) + " |")
print("|---|" + "---:|" * len(variants))
for entry in sorted(rows):
    cells = []
    for v in variants:
        s, c = rows[entry].get(v, (None, None))
        cells.append("—" if s is None else (f"{s}" if c == "success" else f"{s} ❌"))
    print(f"| {entry} | " + " | ".join(cells) + " |")

print("\n## Summary\n")
both = [e for e in rows if all(rows[e].get(v, (0, ""))[1] == "success" for v in variants)]
inc_only = [e for e in rows if rows[e].get("incumbent", (0, ""))[1] == "success" and e not in both]
print(f"- Entries: {len(rows)}; all variants succeeded on {len(both)}.")
for v in variants:
    ok = sum(1 for e in rows if rows[e].get(v, (0, ""))[1] == "success")
    durations = [rows[e][v][0] for e in both]
    med = statistics.median(durations) if durations else float("nan")
    print(f"- **{v}**: succeeded on {ok}/{len(rows)}; median {med:.0f} s on the {len(both)} entries where every variant succeeded.")
if inc_only:
    print(f"- Incumbent succeeded but another variant failed: {', '.join(sorted(inc_only))}.")
