import { describe, expect, it } from "vitest";
import { keepInSnapshot, knownProgram, osIdentity } from "../src/system.js";

describe("snapshots of system programs", () => {
  it("belong to one OS", () => {
    expect(osIdentity('NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="26.04"\n')).toBe("ubuntu-26.04");
    expect(osIdentity('ID=debian\nVERSION_ID="12"\n')).toBe("debian-12");
    expect(osIdentity(null, "15")).toBe("macos-15");
    expect(osIdentity(null)).toBe("linux-unknown");
  });

  it("leave out documentation and packaging state", () => {
    for (const p of ["/usr/bin/gs", "/usr/lib/x86_64-linux-gnu/libgs.so.10", "/etc/alternatives/gnuplot", "/usr/share/ghostscript/10.06.0/lib/gs_init.ps"]) expect(keepInSnapshot(p), p).toBe(true);
    for (const p of ["/.", "/usr/share/doc/gnuplot/README", "/usr/share/man/man1/gs.1.gz", "/usr/share/locale/fr/LC_MESSAGES/inkscape.mo", "/etc/ld.so.cache", "/var/lib/dpkg/status", "/var/cache/apt/pkgcache.bin"]) expect(keepInSnapshot(p), p).toBe(false);
  });

  it("are only for programs it knows", () => {
    expect(knownProgram("gs")).toBe(true);
    expect(knownProgram("libglut.so.3")).toBe(true);
    expect(knownProgram("some-word-from-a-log")).toBe(false);
  });
});
