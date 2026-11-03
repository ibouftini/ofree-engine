import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EXTRA_LATEXMKRC } from "../src/compile/compile.js";

describe("the latexmk rules this action adds", () => {
  it("are valid Perl: an error in them stops every build", () => {
    const r = spawnSync("perl", ["-c"], { input: EXTRA_LATEXMKRC, encoding: "utf8" });
    expect(r.stderr).toContain("syntax OK");
  });
});
