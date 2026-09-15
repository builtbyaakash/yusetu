import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "kubernetes.default.svc",
]);

const METADATA_IPS = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "fd00:ec2::254",
]);

function isPrivateOrLinkLocal(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80:")) return true;
    return false;
  }
  return true;
}

function isLoopback(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ip.startsWith("127.");
  if (v === 6) return ip === "::1" || ip === "0:0:0:0:0:0:0:1";
  return false;
}

export type SsrfCheckOptions = {
  /** When true, allow 127.0.0.1 / ::1 (explicit local upstreams). */
  allowLocalhost: boolean;
};

/**
 * Validate an HTTP(S) upstream URL against SSRF rules.
 * Blocks cloud metadata endpoints always; blocks private/link-local unless allowLocalhost
 * (and then only loopback is permitted, not broader RFC1918).
 */
export async function assertSafeUpstreamUrl(
  rawUrl: string,
  options: SsrfCheckOptions,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid upstream URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Upstream URL must be http or https");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA_HOSTS.has(hostname)) {
    throw new Error("Upstream URL targets a blocked metadata host");
  }

  const resolveIps = async (): Promise<string[]> => {
    if (isIP(hostname)) return [hostname];
    try {
      const results = await lookup(hostname, { all: true, verbatim: true });
      return results.map((r) => r.address);
    } catch {
      throw new Error(`Unable to resolve upstream host: ${hostname}`);
    }
  };

  const ips = await resolveIps();
  for (const ip of ips) {
    if (METADATA_IPS.has(ip) || (ip.startsWith("169.254.") && !isLoopback(ip))) {
      throw new Error("Upstream URL resolves to a blocked metadata address");
    }

    if (isPrivateOrLinkLocal(ip)) {
      if (options.allowLocalhost && isLoopback(ip)) {
        continue;
      }
      throw new Error(
        options.allowLocalhost
          ? "Private/non-loopback addresses are not allowed for HTTP upstreams"
          : "Local/private addresses are blocked. Enable allowLocalhost setting to permit 127.0.0.1",
      );
    }
  }
}
