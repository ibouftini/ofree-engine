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

/** The runner could not reach or read what it had to download. */
export class NetworkError extends Error {}

/** Why a request failed, in a few words: the system's error code rather than "fetch failed". */
export function failureReason(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError") return "no answer in time";
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}

/**
 * Repositories in the order they answered, at most `max` of them. Those that
 * did not answer are added to `failures`, by URL, with the reason.
 */
export function rankMirrors(tlnets: string[], max = 3, failures?: Map<string, string>): Promise<string[]> {
  return new Promise((resolve) => {
    const answered: string[] = [];
    let pending = tlnets.length;
    for (const tlnet of tlnets) {
      fetch(`${tlnet}/tlpkg/texlive.tlpdb.sha512`, { signal: AbortSignal.timeout(6000) })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await res.arrayBuffer();
          answered.push(tlnet);
          if (answered.length === max) resolve(answered.slice());
        })
        .catch((err) => void failures?.set(tlnet, failureReason(err)))
        .finally(() => {
          if (--pending === 0) resolve(answered.slice(0, max));
        });
    }
  });
}

/** Repository revision recorded in a package database ("depend revision/80924"). */
export function tlpdbRevision(text: string): number {
  return Number(/^depend revision\/(\d+)$/m.exec(text.slice(0, 20_000))?.[1] ?? 0);
}

export async function fetchBytes(url: string, retries = 3): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new NetworkError(`Could not download ${url}: ${failureReason(lastError)}`);
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
