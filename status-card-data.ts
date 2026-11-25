import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("system", messageCatalog.messages);
import { readFile } from "node:fs/promises";
import { arch, cpus, freemem, platform, totalmem, uptime } from "node:os";
import { setTimeout } from "node:timers/promises";
import { collectStatusDetails, type StatusDetailSection } from "./status-card-details.ts";
import type { StatusMonitorSample } from "./status-monitor.ts";
import { collectProbeResults } from "./status-network-probes.ts";
import { statusSettingsRecord } from "./status-card-style.ts";

export interface RuntimeStatusAccount {
  readonly name: string;
  readonly adapter: "onebot" | "milky";
  readonly seconds: number;
  readonly sent?: string;
  readonly received?: string;
  readonly images?: string;
  readonly friends?: number;
  readonly groups?: number;
  readonly members?: number;
}

export interface RuntimeStatusSnapshot {
  readonly accounts: readonly RuntimeStatusAccount[];
  readonly pluginCount?: number;
  readonly scriptCount?: number;
  readonly redis?: RuntimeStatusRedis;
}

export interface RuntimeStatusRedis {
  readonly version?: string;
  readonly uptime?: number;
  readonly usedMemory?: number;
  readonly peakMemory?: number;
  readonly maxMemory?: number;
  readonly clients?: number;
  readonly blocked?: number;
  readonly connections?: number;
  readonly commands?: number;
  readonly databases: readonly { readonly index: number; readonly keys: number; readonly expires: number; readonly averageTtl: number }[];
}

export interface StatusResource {
  readonly title: string;
  readonly percent: number;
  readonly detail?: string;
  readonly info?: readonly string[];
  readonly bufferPercent?: number;
}

export interface StatusCardModel extends RuntimeStatusSnapshot {
  readonly platform: string;
  readonly runtime: string;
  readonly uptime: number;
  readonly resources: readonly StatusResource[];
  readonly details?: readonly StatusDetailSection[];
  readonly networkHistory?: readonly StatusMonitorSample[];
  readonly redisHistory?: readonly StatusMonitorSample[];
}

const GiB = 1024 ** 3;
const gib = (bytes: number) => (bytes / GiB).toFixed(2) + " GiB";

export function cpuTimes(cores = cpus()) {
  let idle = 0;
  let total = 0;
  for (const { times } of cores) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

async function memoryInfo() {
  if (platform() !== "linux") return new Map<string, number>();
  const raw = await readFile("/proc/meminfo", "utf8").catch(() => "");
  return new Map([...raw.matchAll(/^(MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$/gmu)]
    .map(([, key, value]) => [key!, Number(value) * 1024]));
}

export function cpuPercent(before: ReturnType<typeof cpuTimes>, after: ReturnType<typeof cpuTimes>) {
  const interval = after.total - before.total;
  const idle = after.idle - before.idle;
  if (interval > 0 && idle >= 0 && idle <= interval) return (1 - idle / interval) * 100;
}

function usedMemory(total: number, usedWithCache: number, memory: ReadonlyMap<string, number>) {
  const available = memory.get("MemAvailable");
  return available !== undefined && available >= 0 && available <= total ? total - available : usedWithCache;
}

export async function activeMemory() {
  const total = totalmem();
  const usedWithCache = total - freemem();
  const used = usedMemory(total, usedWithCache, await memoryInfo());
  if (total > 0 && used >= 0 && used <= total) return used;
}

export async function collectStatusCard(snapshot: RuntimeStatusSnapshot, pro: boolean,
  config: Record<string, unknown> = {}, samples: readonly StatusMonitorSample[] = [], signal?: AbortSignal): Promise<StatusCardModel> {
  const cores = cpus();
  const before = cpuTimes(cores);
  const [memory, detailed, probes] = await Promise.all([
    memoryInfo(),
    pro ? collectStatusDetails(config, snapshot.redis).catch(() => undefined) : undefined,
    pro ? collectProbeResults(config, signal).catch(() => undefined) : undefined,
    setTimeout(120),
  ]);
  const load = cpuPercent(before, cpuTimes());
  const total = totalmem();
  const usedWithCache = total - freemem();
  const used = usedMemory(total, usedWithCache, memory);
  const resources: StatusResource[] = [];
  if (load !== undefined) {
    resources.push({ title: "CPU", percent: load,
      ...(pro && { detail: cores[0]?.model, info: [$t("status-card-data.text_190c51debe", { "length": cores.length })] }) });
  }
  if (total > 0 && used >= 0 && used <= total) {
    const cache = usedWithCache - used;
    resources.push({ title: "RAM", percent: used / total * 100,
      ...(cache > 0 && { bufferPercent: usedWithCache / total * 100 }),
      ...(pro && { info: [`${gib(used)} / ${gib(total)}`, ...(cache > 0 ? [$t("status-card-data.text_46e9e714be", { "value1": gib(cache) })] : [])] }) });
    if (pro) {
      const swapTotal = memory.get("SwapTotal");
      const swapFree = memory.get("SwapFree");
      if (swapTotal !== undefined && swapTotal > 0 && swapFree !== undefined && swapFree <= swapTotal) {
        const swapUsed = swapTotal - swapFree;
        resources.push({ title: "SWAP", percent: swapUsed / swapTotal * 100,
          detail: `Available ${gib(swapFree)}`, info: [`${gib(swapUsed)} / ${gib(swapTotal)}`] });
      }
      const rss = process.memoryUsage().rss;
      resources.push({ title: "Bun", percent: rss / total * 100, detail: gib(rss), info: [$t("status-card-data.text_4097c47b8d")] });
    }
  }
  if (detailed) resources.push(...detailed.gpu);
  const selected = Array.isArray(config.systemResources)
    ? config.systemResources.flatMap(title => resources.filter(resource => resource.title === (title === "Node" ? "Bun" : title)))
    : resources;
  const { redis: _redis, ...session } = snapshot;
  const charts = statusSettingsRecord(config.chartsCfg);
  const showNetworkHistory = charts?.show === true || (pro && (charts?.show === undefined || charts.show === "pro"));
  const networkHistory = config.closedChart !== true && showNetworkHistory &&
    samples.filter(sample => sample.network).length > 1 ? samples.slice(-60).map(({ at, network }) => ({ at, network })) : undefined;
  const cutoff = Date.now() - 60 * 60 * 1000;
  const redisHistory = pro && config.showRedisInfo !== false && config.closedChart !== true
    ? samples.filter(sample => sample.at >= cutoff).slice(-60) : [];
  const details = detailed?.sections ?? [];
  const network = details.findIndex(section => section.icon === "网络");
  if (probes) details.splice(network === -1 ? 0 : network + 1, 0, probes);
  return { ...session, platform: platform(), runtime: `${arch()} · Bun ${Bun.version}`, uptime: uptime(), resources: [...new Set(selected)],
    ...(details.length && { details }), ...(networkHistory && { networkHistory }),
    ...(redisHistory.length && { redisHistory }) };
}
