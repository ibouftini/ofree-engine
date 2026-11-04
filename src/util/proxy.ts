// Node's fetch ignores the proxy variables; @actions/cache and @actions/artifact already follow them.

/** Sends fetch through HTTPS_PROXY or HTTP_PROXY, honouring NO_PROXY, when one is set. */
export async function useProxyFromEnv(env: NodeJS.ProcessEnv = process.env) {
  if (!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) return;
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
