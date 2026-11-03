import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  output: string;
}

/** Runs a command, capturing stdout and stderr together. Never throws on a non-zero exit. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => chunks.push(b));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

/** Runs `tasks` with at most `limit` in flight; results keep input order. */
export async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Serializes async sections (tlmgr must never run twice at once). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export const seconds = (since: number) => Math.round((performance.now() - since) / 100) / 10;
