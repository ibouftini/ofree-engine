// The cached TeX Live, keyed by the project and the requirement fingerprint.
//
// Entries are immutable, so every save gets a new key
// "<prefix><lineage>-<fingerprint>-<time>". Restoring asks for a key that never
// exists, which makes the cache service fall back to the newest entry with the
// same fingerprint, then to the newest entry of the same lineage (the same
// documents, whose needs changed a little: a good base for adding what is
// missing). Never to another project's entry: each would inherit the other's
// packages, and the entries would grow with every save.

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

export async function restoreTexLive(texdir: string, arch: string, lineage: string, fingerprint: string): Promise<Restored> {
  const p = `${prefix(arch)}${lineage}-`;
  try {
    const key = await cache.restoreCache([texdir], `${p}${fingerprint}-0`, [`${p}${fingerprint}-`, p]);
    return { key, exact: key?.startsWith(`${p}${fingerprint}-`) ?? false };
  } catch (err) {
    core.warning(`Could not restore the cached TeX Live: ${err instanceof Error ? err.message : err}`);
    return { exact: false };
  }
}

export async function saveTexLive(texdir: string, arch: string, lineage: string, fingerprint: string): Promise<string | undefined> {
  const key = `${prefix(arch)}${lineage}-${fingerprint}-${Date.now()}`;
  try {
    await cache.saveCache([texdir], key);
    return key;
  } catch (err) {
    core.warning(`Could not save TeX Live to the cache: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}
