import { BlockList, isIP } from "node:net";
import type { IncomingMessage, RequestListener } from "node:http";
import type { Config } from "./config.js";
import { formatTrustedProxies, normalizeAddress } from "./clientAddress.js";

export const REFUSAL_BODY = "Forbidden. This service only accepts requests through its configured proxy.\n";
export const MAX_REFUSAL_PEERS = 4096;
const REFUSAL_INTERVAL = 60_000;
const WARNING_INTERVAL = 600_000;
type IngressConfig = Pick<Config, "trustedProxies" | "proxyOnly" | "proxyOnlyExplicit" | "issuer" | "cookieSecure">;

export function reportIngressMode(config: IngressConfig, log = console.log, warn = console.warn): void {
  const entries = formatTrustedProxies(config.trustedProxies);
  const source = config.proxyOnlyExplicit ? `set to ${config.proxyOnly}` : "not set, derived from TRUSTED_PROXIES";
  const mode = config.proxyOnly
    ? `proxy-only. Only requests from TRUSTED_PROXIES (${entries}) are served; all other requests get 403, except loopback GET/HEAD /health.`
    : config.trustedProxies.length > 0
      ? `tunnel plus direct LAN. CF-Connecting-IP is trusted only from TRUSTED_PROXIES (${entries}); direct requests are served and recorded under their own address.`
      : "local-only. TRUSTED_PROXIES is empty, so every request is served and recorded under its connection address, and Cloudflare headers are ignored. If this install is behind a Cloudflare Tunnel, set TRUSTED_PROXIES to the connector machine's address.";
  log(`Ingress mode: ${mode} (PROXY_ONLY ${source}.)`);
  for (const range of config.trustedProxies) {
    if (range.prefix < (range.family === "ipv4" ? 32 : 128)) {
      warn(`TRUSTED_PROXIES range ${range.address}/${range.prefix}: every host in it is trusted.`);
    }
  }
  if (config.proxyOnly) {
    if (!config.issuer.startsWith("https://")) warn("Proxy-only: SERVICE_ISSUER is expected to start with https://.");
    if (config.cookieSecure !== "true") warn("Proxy-only: COOKIE_SECURE is expected to be true.");
  }
}

function hasCloudflareHeaders(request: IncomingMessage): boolean {
  if (["cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry"].some(name => request.headers[name] !== undefined)) return true;
  const loop = request.headers["cdn-loop"];
  return (Array.isArray(loop) ? loop : [loop]).some(value => value?.toLowerCase().includes("cloudflare"));
}

// Wrap the entire request pipeline, including monitoring. No body listener,
// routing, cookie processing, database access or throttle runs on refusal.
export function withIngressAdmission(
  handler: RequestListener,
  config: IngressConfig,
  { now = Date.now, warn = console.warn }: { now?: () => number; warn?: (line: string) => void } = {},
): RequestListener {
  const trusted = new BlockList();
  for (const range of config.trustedProxies) trusted.addSubnet(range.address, range.prefix, range.family);
  const loopback = new BlockList();
  loopback.addSubnet("127.0.0.0", 8, "ipv4");
  loopback.addAddress("::1", "ipv6");
  const refusals = new Map<string, { last: number; suppressed: number }>();
  let lastWarning = -Infinity;
  return (request, response) => {
    const peer = normalizeAddress(request.socket.remoteAddress ?? "");
    const version = isIP(peer);
    const family = version === 4 ? "ipv4" : "ipv6";
    const isTrusted = version !== 0 && trusted.check(peer, family);
    const health = version !== 0 && loopback.check(peer, family) &&
      (request.method === "GET" || request.method === "HEAD") && request.url === "/health";
    if (config.proxyOnly && (!peer || (!isTrusted && !health))) {
      const key = version === 0 ? "<no-peer>" : peer;
      const time = now();
      let state = refusals.get(key);
      if (!state && refusals.size >= MAX_REFUSAL_PEERS) {
        // Only expire entries whose quiet period has elapsed. Never evict an
        // active entry: that could let a peer log again inside its interval.
        // Drop pending counts on expiry so stale peers cannot exhaust capacity.
        for (const [address, entry] of refusals) {
          if (time - entry.last >= REFUSAL_INTERVAL) refusals.delete(address);
        }
      }
      if (!state && refusals.size < MAX_REFUSAL_PEERS) {
        state = { last: -Infinity, suppressed: 0 };
        refusals.set(key, state);
      }
      if (state) {
        if (time - state.last >= REFUSAL_INTERVAL) {
          const path = (request.url ?? "").split("?", 1)[0]!;
          const escaped = JSON.stringify(path.slice(0, 256)).replace(/[\u007f-\u009f\u2028\u2029]/g,
            character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
          warn(`Proxy-only refusal: peer=${key} path=${escaped}${path.length > 256 ? " [truncated]" : ""} suppressed=${state.suppressed}`);
          state.last = time;
          state.suppressed = 0;
        } else state.suppressed = Math.min(Number.MAX_SAFE_INTEGER, state.suppressed + 1);
      }
      response.writeHead(403, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "close",
      });
      response.end(REFUSAL_BODY);
      return;
    }
    if (!config.proxyOnly && !isTrusted && hasCloudflareHeaders(request) && now() - lastWarning >= WARNING_INTERVAL) {
      lastWarning = now();
      const address = version === 0 ? "<no-peer>" : peer;
      warn(config.trustedProxies.length === 0
        ? `Ingress warning: peer=${address}; this looks like a tunnel install missing TRUSTED_PROXIES. Every tunnel user is being recorded under the connector's address; proxy-only mode is off.`
        : `Ingress warning: peer=${address}; the connector's address may have changed. Check TRUSTED_PROXIES.`);
    }
    if (request.httpVersion === "1.1" && request.headers.expect !== undefined) {
      if (request.headers.expect.toLowerCase() === "100-continue") response.writeContinue();
      else {
        response.writeHead(417);
        response.end();
        return;
      }
    }
    return handler(request, response);
  };
}
