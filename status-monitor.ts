import { activeMemory, cpuPercent, cpuTimes } from "./status-card-data.ts";

export interface StatusMonitorStorage {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
}

export interface StatusMonitorSample {
  readonly at: number;
  readonly cpu?: number;
  readonly ram?: number;
}

export interface StatusMonitorSettings {
  readonly enabled: boolean;
  readonly interval: number;
  readonly limit: number;
  readonly persist: boolean;
}

export const statusMonitorTtl = 12 * 3600;
const historyKey = "history";
const maxSamples = 720;

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value : fallback;
}

export function statusMonitorSettings(config?: Record<string, unknown>): StatusMonitorSettings {
  const monitor = object(config?.monitor);
  return {
    enabled: monitor?.open !== false,
    interval: integer(monitor?.getDataInterval, 1_000, 3_600_000, 60_000),
    limit: integer(monitor?.saveDataNumber, 1, maxSamples, 60),
    persist: monitor?.openRedisSaveData !== false,
  };
}

function sample(value: unknown, now: number): StatusMonitorSample | undefined {
  const row = object(value);
  if (typeof row?.at !== "number" || !Number.isSafeInteger(row.at) ||
      row.at <= 0 || row.at <= now - statusMonitorTtl * 1000 || row.at > now) return;
  const cpu = typeof row.cpu === "number" && Number.isFinite(row.cpu) && row.cpu >= 0 && row.cpu <= 100
    ? row.cpu : undefined;
  const ram = typeof row.ram === "number" && Number.isSafeInteger(row.ram) && row.ram >= 0 ? row.ram : undefined;
  if (cpu !== undefined || ram !== undefined) return { at: row.at, cpu, ram };
}

function parseHistory(raw: string | null | undefined, now: number, limit: number) {
  if (!raw || raw.length > 128 * 1024) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > maxSamples) return [];
    const rows = new Map<number, StatusMonitorSample>();
    for (const item of data) {
      const row = sample(item, now);
      if (row) rows.set(row.at, row);
    }
    return [...rows.values()].sort((a, b) => a.at - b.at).slice(-limit);
  } catch {
    return [];
  }
}

export function createStatusMonitor(settings: StatusMonitorSettings, {
  storage, signal, now = Date.now, readCpu = cpuTimes, readRam = activeMemory,
}: {
  readonly storage?: StatusMonitorStorage;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly readCpu?: () => ReturnType<typeof cpuTimes>;
  readonly readRam?: () => Promise<number | undefined>;
} = {}) {
  const persistent = settings.persist ? storage : undefined;
  let rows: StatusMonitorSample[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let stopped = signal?.aborted ?? false;
  let previous = settings.enabled && !stopped ? readCpu() : undefined;

  const ready = persistent && !stopped
    ? Promise.resolve().then(() => persistent.get(historyKey)).then(raw => {
      if (!stopped) rows = parseHistory(raw, now(), settings.limit);
    }).catch(() => {})
    : Promise.resolve();

  const retained = (at: number) => rows.filter(row => row.at > at - statusMonitorTtl * 1000 && row.at <= at);

  async function readSample() {
    await ready;
    if (stopped) return;
    const at = now();
    const current = readCpu();
    const cpu = previous && cpuPercent(previous, current);
    previous = current;
    const ram = await readRam().catch(() => undefined);
    if (stopped) return;
    const row = sample({ at, cpu, ram }, at);
    if (!row || (rows.at(-1)?.at ?? 0) >= row.at) return;
    rows = [...retained(at), row].slice(-settings.limit);
    await persistent?.set(historyKey, JSON.stringify(rows), statusMonitorTtl).catch(() => {});
  }

  function tick(): Promise<void> {
    if (stopped || !settings.enabled) return Promise.resolve();
    pending ??= readSample().finally(() => { pending = undefined; });
    return pending;
  }

  function schedule() {
    if (stopped || !settings.enabled) return;
    timer = setTimeout(() => void tick().catch(() => {}).finally(schedule), settings.interval);
    timer.unref();
  }

  function stop() {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }

  if (signal && !stopped) {
    signal.addEventListener("abort", stop, { once: true });
    schedule();
  }

  return {
    tick,
    async snapshot() {
      await ready;
      return { enabled: settings.enabled, samples: stopped ? [] : retained(now()) };
    },
    async dispose() {
      stop();
      await Promise.allSettled([ready, pending]);
    },
  };
}
