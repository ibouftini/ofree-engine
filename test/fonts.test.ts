import { describe, expect, it } from "vitest";
import { CLOSE_MATCHES, fontspecAlias, googleFamily, lastResortFiles, parseGoogleCss } from "../src/fonts.js";

describe("fonts outside TeX Live", () => {
  it("turns the names documents use into Google Fonts families", () => {
    expect(googleFamily("Noto Nastaliq Urdu")).toBe("Noto Nastaliq Urdu");
    expect(googleFamily("NotoNastaliqUrdu-Regular.ttf")).toBe("Noto Nastaliq Urdu");
    expect(googleFamily("Roboto-Bold")).toBe("Roboto");
    // The system packages' CJK names differ from Google's.
    expect(googleFamily("Noto Serif CJK SC")).toBe("Noto Serif SC");
    expect(googleFamily("Noto Sans CJK jp")).toBe("Noto Sans JP");
  });

  it("has a close match for fonts without a download, and a last resort by style", () => {
    expect(CLOSE_MATCHES.consolas).toBe("Inconsolata");
    expect(CLOSE_MATCHES.aptos).toBe("Inter");
    expect(lastResortFiles("Fira Code").family).toBe("Latin Modern Mono");
    expect(lastResortFiles("Some Sans").family).toBe("Latin Modern Sans");
    expect(lastResortFiles("Totally Made Up").family).toBe("Latin Modern Roman");
  });

  it("reads the styles the Google Fonts CSS API offers", () => {
    const css = [
      "@font-face { font-family: 'Carlito'; font-style: italic; font-weight: 700; src: url(https://fonts.gstatic.com/s/carlito/v4/bi.ttf) format('truetype'); }",
      "@font-face { font-family: 'Carlito'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/carlito/v4/r.ttf) format('truetype'); }",
      "@font-face { font-family: 'Carlito'; font-style: normal; font-weight: 700; src: url(https://fonts.gstatic.com/s/carlito/v4/b.ttf) format('truetype'); }",
    ].join("\n");
    expect(parseGoogleCss(css)).toEqual([
      { style: "BoldItalic", url: "https://fonts.gstatic.com/s/carlito/v4/bi.ttf" },
      { style: "Regular", url: "https://fonts.gstatic.com/s/carlito/v4/r.ttf" },
      { style: "Bold", url: "https://fonts.gstatic.com/s/carlito/v4/b.ttf" },
    ]);
  });

  it("writes the feature file fontspec reads for a name, without spaces in its file name", () => {
    const a = fontspecAlias("Times New Roman", { Regular: "Tinos-Regular.ttf", Bold: "Tinos-Bold.ttf" });
    expect(a.file).toBe("TimesNewRoman.fontspec");
    expect(a.text).toBe("\\defaultfontfeatures[Times New Roman]{\n  UprightFont = Tinos-Regular.ttf,\n  BoldFont = Tinos-Bold.ttf,\n}\n");
  });
});
