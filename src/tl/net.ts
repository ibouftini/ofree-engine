// Mirror choice and verified, parallel downloads.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pool } from "../util/exec.js";

/**
 * Mirrors tried in parallel; the first to answer wins and is used for the
 * whole run, because mirrors are not always in sync with each other.
 */
export const MIRRORS = [
  "https://mirrors.mit.edu/CTAN",
  "https://mirrors.rit.edu/CTAN",
  "https://mirror.math.princeton.edu/pub/CTAN",
  "https://ctan.math.illinois.edu",
  "https://ctan.mirrors.hoobly.com",
  "https://mirror.las.iastate.edu/tex-archive",
];

/** Mirrors of TeX Live's historic archive, which keeps each frozen year in the tlnet layout. */
export const HISTORIC = [
  "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive",
  "https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive",
  "https://mirrors.tuna.tsinghua.edu.cn/tex-historic-archive/systems/texlive",
];

/** Repository URLs (tlnet) for the current TeX Live, or for a frozen year. */
export function tlnetCandidates(year?: number): string[] {
  return year ? HISTORIC.map((h) => `${h}/${year}/tlnet-final`) : MIRRORS.map((m) => `${m}/systems/texlive/tlnet`);
}

/** The first repository to answer; used for the whole run because mirrors drift. */
export async function pickMirror(tlnets: string[]): Promise<string> {
  const probe = async (tlnet: string) => {
    const res = await fetch(`${tlnet}/tlpkg/texlive.tlpdb.sha512`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`${tlnet}: HTTP ${res.status}`);
    await res.arrayBuffer();
    return tlnet;
  };
  try {
    return await Promise.any(tlnets.map(probe));
  } catch {
    throw new Error(`No TeX Live repository answered (tried ${tlnets.join(", ")})`);
  }
}

export async function fetchBytes(url: string, retries = 3): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function sha512(data: Buffer): string {
  return createHash("sha512").update(data).digest("hex");
}

export interface Download {
  url: string;
  dest: string;
  /** Expected SHA-512 (hex); the download fails if it does not match. */
  sha512?: string;
}

export async function downloadAll(items: Download[], concurrency = 32): Promise<number> {
  let bytes = 0;
  await pool(items, concurrency, async (item) => {
    let data = await fetchBytes(item.url);
    if (item.sha512 && sha512(data) !== item.sha512) {
      // One retry: a mirror may have been mid-update.
      data = await fetchBytes(item.url);
      if (sha512(data) !== item.sha512) throw new Error(`Checksum mismatch for ${item.url}`);
    }
    mkdirSync(dirname(item.dest), { recursive: true });
    writeFileSync(item.dest, data);
    bytes += data.length;
  });
  return bytes;
}
