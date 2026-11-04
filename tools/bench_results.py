"""Summarize a benchmark run: per entry and variant, the build step's duration
(the LaTeX action alone, without repository checkout) and the whole job's.

Reads the current run's jobs through the GitHub API (needs GH_TOKEN,
GITHUB_REPOSITORY and GITHUB_RUN_ID, or pass a run id as the first argument)
and prints a Markdown report. Job names must look like "<variant> · <entry>".
"""
import datetime as dt
import json
import os
import statistics
import subprocess
import sys

repo = os.environ.get("GITHUB_REPOSITORY", "ibouftini/ofree-engine")
run_id = sys.argv[1] if len(sys.argv) > 1 else os.environ["GITHUB_RUN_ID"]
raw = subprocess.run(
    ["gh", "api", "--paginate", f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100", "--jq", ".jobs[]"],
    capture_output=True, text=True, check=True,
).stdout
jobs = [json.loads(line) for line in raw.splitlines() if line.strip()]
ts = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
secs = lambda a, b: round((ts(b) - ts(a)).total_seconds())
BUILD_STEPS = ("latex-action", ".ofree-engine")
is_build = lambda name: any(b in name for b in BUILD_STEPS) or name == "Run ./"

rows = {}
for j in jobs:
    if " · " not in j["name"] or j.get("conclusion") in (None, "skipped") or not j.get("completed_at"):
        continue
    variant, entry = j["name"].split(" · ", 1)
    step = next((s for s in j.get("steps", []) if is_build(s["name"]) and s.get("completed_at")), None)
    rows.setdefault(entry, {})[variant] = {
        # The incumbent's job passes even when it fails, so that this does not mark the commit as failed.
        "ok": j["conclusion"] == "success" and not any(s["name"] == "The incumbent failed" and s.get("conclusion") == "success" for s in j.get("steps", [])),
        "job": secs(j["started_at"], j["completed_at"]),
        "step": secs(step["started_at"], step["completed_at"]) if step else None,
    }

variants = sorted({v for r in rows.values() for v in r}, key=lambda v: (v != "incumbent", v))


def cell(r):
    if r is None:
        return "—"
    mark = "" if r["ok"] else " ❌"
    return f"{r['step']} / {r['job']}{mark}"


print("## Benchmark: build step / whole job, in seconds\n")
print("| Entry | " + " | ".join(variants) + " |")
print("|---|" + "---:|" * len(variants))
for entry in sorted(rows):
    print(f"| {entry} | " + " | ".join(cell(rows[entry].get(v)) for v in variants) + " |")

print("\n## Summary\n")
both = [e for e in rows if all(rows[e].get(v, {}).get("ok") for v in variants)]
print(f"- Entries: {len(rows)}; every variant succeeded on {len(both)}.")
for v in variants:
    ok = sum(1 for e in rows if rows[e].get(v, {}).get("ok"))
    steps = [rows[e][v]["step"] for e in both if rows[e][v]["step"] is not None]
    jobs_ = [rows[e][v]["job"] for e in both]
    if steps:
        print(f"- **{v}**: succeeded on {ok}/{len(rows)}. On the {len(both)} common successes: "
              f"build step median {statistics.median(steps):.0f} s (mean {statistics.mean(steps):.0f} s), "
              f"whole job median {statistics.median(jobs_):.0f} s.")
lost = sorted(e for e in rows if rows[e].get("incumbent", {}).get("ok") and not all(rows[e].get(v, {}).get("ok") for v in variants))
won = sorted(e for e in rows if not rows[e].get("incumbent", {}).get("ok") and any(rows[e].get(v, {}).get("ok") for v in variants if v != "incumbent"))
if lost:
    print(f"- Incumbent succeeded, another variant failed: {', '.join(lost)}.")
if won:
    print(f"- Incumbent failed, another variant succeeded: {', '.join(won)}.")
