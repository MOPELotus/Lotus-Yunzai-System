import { lookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import type { StatusDetailSection } from "./status-card-details.ts";

interface Probe {
  readonly name: string;
  readonly target: URL;
  readonly useProxy: boolean;
}

interface ProbeSettings {
  readonly list: readonly Probe[];
  readonly timeout: number;
  readonly concurrency: number;
  readonly proxy?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function range(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function secureTarget(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 2048) return;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
        !isIP(url.hostname) && /^(?:[a-z\d-]+\.)+[a-z\d-]+$/u.test(url.hostname)) return url;
  } catch {
    return;
  }
}

function explicitProxy(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 2048) return;
  try {
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.pathname === "/" && !url.search && !url.hash) return url.href;
  } catch {
    return;
  }
}

export function statusProbeSettings(config: Record<string, unknown>): ProbeSettings | undefined {
  const source = record(config.psTestSites);
  if (config.networkProbesEnabled !== true || (source?.show !== true && source?.show !== "pro") || !Array.isArray(source.list)) return;
  const list: Probe[] = [];
  for (const raw of source.list.slice(0, 8)) {
    const probe = record(raw);
    const target = secureTarget(probe?.url);
    const name = typeof probe?.name === "string" ? probe.name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 48) : "";
    if (name && target) list.push({ name, target, useProxy: probe?.useProxy === true });
  }
  if (list.length) return {
    list, timeout: range(source.timeout, 200, 5000, 5000), concurrency: range(source.concurNum, 1, 5, 5),
    proxy: explicitProxy(source.proxy),
  };
}

export function isPublicProbeAddress(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a! < 224 && !(a === 169 && b === 254) &&
      !(a === 100 && b! >= 64 && b! <= 127) && !(a === 172 && b! >= 16 && b! <= 31) &&
      !(a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
      !(a === 203 && b === 0 && c === 113);
  }
  if (isIP(ip) === 6) {
    const address = ip.toLowerCase();
    return /^[23][\da-f]{3}:/u.test(address) && !/^2001:(?:[0-9a-f]{0,2}|db8):|^2002:|^3fff:/u.test(address);
  }
  return false;
}

function publicAddress(hostname: string, signal: AbortSignal) {
  return new Promise<{ address: string; family: number }>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    lookup(hostname, { all: true }, (error, addresses) => {
      signal.removeEventListener("abort", stop);
      if (error) return reject(error);
      if (!addresses.length || addresses.some(item => !isPublicProbeAddress(item.address))) return reject(new Error("不可探测该地址"));
      resolve(addresses[0]!);
    });
  });
}

async function probeStatus(target: URL, signal: AbortSignal, proxy?: string) {
  const ip = await publicAddress(target.hostname, signal);
  signal.throwIfAborted();
  if (proxy) {
    const response = await fetch(target, { method: "HEAD", signal, redirect: "manual",
      proxy: { url: proxy, headers: {}, respectNoProxy: false } });
    return response.status;
  }
  return new Promise<number>((resolve, reject) => {
    const operation = request(target, {
      method: "HEAD", signal, agent: false, family: ip.family,
      lookup: (_, _options, done) => done(null, ip.address, ip.family),
    }, response => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    operation.on("error", reject);
    operation.end();
  });
}

export async function collectProbeResults(config: Record<string, unknown>, requestSignal?: AbortSignal, open = probeStatus) {
  const settings = statusProbeSettings(config);
  if (!settings || requestSignal?.aborted) return;
  const timeout = AbortSignal.timeout(settings.timeout);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  let index = 0;
  const rows = new Array<readonly [string, string]>(settings.list.length);
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, settings.list.length) }, async () => {
    while (index < settings.list.length && !signal.aborted) {
      const current = index++;
      const { name, target, useProxy } = settings.list[current]!;
      const start = performance.now();
      try {
        if (useProxy && !settings.proxy) {
          rows[current] = [name, "未配置探测代理"];
          continue;
        }
        const code = await open(target, signal, useProxy ? settings.proxy : undefined);
        rows[current] = [name, `HTTP ${code}　${Math.round(performance.now() - start)} ms`];
      } catch {
        rows[current] = [name, signal.aborted ? "超时" : "连接失败"];
      }
    }
  }));
  if (requestSignal?.aborted) return;
  const results = settings.list.map(({ name }, position) => rows[position] ?? [name, "超时"] as const);
  return { title: "网络测试", icon: "网络", rows: results } as const satisfies StatusDetailSection;
}
