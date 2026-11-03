// The cached TeX Live, keyed by the requirement fingerprint.
//
// Entries are immutable, so every save gets a new key "<prefix><fingerprint>-<time>".
// Restoring asks for a key that never exists, which makes the cache service
// fall back to the newest entry with the same fingerprint, then to the newest
// entry of any fingerprint (a good base for adding the few missing packages).

import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { LAYOUT_VERSION } from "./plan/resolve.js";

const prefix = (arch: string) => `ofree-tl-v${LAYOUT_VERSION}-${arch}-`;

export function cacheAvailable(): boolean {
  return process.env.GITHUB_ACTIONS === "true" && cache.isFeatureAvailable();
}

export interface Restored {
  key?: string;
  /** The entry was made for exactly these requirements. */
  exact: boolean;
}

export async function restoreTexLive(texdir: string, arch: string, fingerprint: string): Promise<Restored> {
  const p = prefix(arch);
  try {
    const key = await cache.restoreCache([texdir], `${p}${fingerprint}-0`, [`${p}${fingerprint}-`, p]);
    return { key, exact: key?.startsWith(`${p}${fingerprint}-`) ?? false };
  } catch (err) {
    core.warning(`Could not restore the cached TeX Live: ${err instanceof Error ? err.message : err}`);
    return { exact: false };
  }
}

export async function saveTexLive(texdir: string, arch: string, fingerprint: string): Promise<string | undefined> {
  const key = `${prefix(arch)}${fingerprint}-${Date.now()}`;
  try {
    await cache.saveCache([texdir], key);
    return key;
  } catch (err) {
    core.warning(`Could not save TeX Live to the cache: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}
