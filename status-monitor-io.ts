import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("system", messageCatalog.messages);
import { readFile, readlink, readdir, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";

export type Rates = readonly [number, number];
type Counters = ReadonlyMap<string, readonly [bigint, bigint]>;

interface DeviceSnapshot {
  readonly at: number;
  readonly counters: Counters;
}

export interface StatusIoCounters {
  readonly network?: DeviceSnapshot;
  readonly disk?: DeviceSnapshot;
}

const sysfsMagic = 0x62656572;
const maxCounter = 2n ** 64n - 1n;
const sectorBytes = 512n;

function counter(value?: string) {
  if (!value || !/^\d{1,20}$/u.test(value)) return;
  const n = BigInt(value);
  return n <= maxCounter ? n : undefined;
}

export function diskSectorCounters(raw: string) {
  const fields = raw.trim().split(/\s+/u);
  if (fields.length < 11) return;
  const read = counter(fields[2]);
  const written = counter(fields[6]);
  if (read !== undefined && written !== undefined) return [read * sectorBytes, written * sectorBytes] as const;
}

async function deviceSnapshot(directory: string, identityFile: string,
  read: (entry: string) => Promise<readonly [bigint, bigint]>): Promise<DeviceSnapshot | undefined> {
  if ((await statfs(directory)).type !== sysfsMagic) return;
  const entries = await readdir(directory);
  if (entries.length > 512) return;
  const rows = await Promise.all(entries.map(async name => {
    const path = join(directory, name);
    const canonical = resolve(directory, await readlink(path));
    // Lower devices account for the I/O of upper virtual devices such as bridges, VLAN, dm and md.
    if (!canonical.startsWith("/sys/devices/") || canonical.startsWith("/sys/devices/virtual/")) return;
    const identity = await attribute(path, identityFile);
    if (!counter(identity)) throw new Error($t("status-monitor-io.text_d2e51e1fc8"));
    const values = await read(path);
    if (identity !== await attribute(path, identityFile)) throw new Error($t("status-monitor-io.text_1eda52a350"));
    return [canonical + ":" + identity, values] as const;
  }));
  const counters = new Map(rows.filter(row => row !== undefined));
  if (counters.size) return { at: performance.now(), counters };
}

async function attribute(entry: string, file: string) {
  return (await readFile(join(entry, file), "utf8")).trim();
}

async function networkCounters(entry: string) {
  const [txValue, rxValue] = await Promise.all([
    attribute(entry, "statistics/tx_bytes"), attribute(entry, "statistics/rx_bytes"),
  ]);
  const tx = counter(txValue);
  const rx = counter(rxValue);
  if (tx === undefined || rx === undefined) throw new Error($t("status-monitor-io.text_535b69c7a0"));
  return [tx, rx] as const;
}

async function diskCounters(entry: string) {
  const values = diskSectorCounters(await attribute(entry, "stat"));
  if (!values) throw new Error($t("status-monitor-io.text_d0aaf13bde"));
  return values;
}

export async function readStatusIoCounters(): Promise<StatusIoCounters> {
  if (process.platform !== "linux") return {};
  const [network, disk] = await Promise.all([
    deviceSnapshot("/sys/class/net", "ifindex", networkCounters).catch(() => undefined),
    deviceSnapshot("/sys/block", "diskseq", diskCounters).catch(() => undefined),
  ]);
  return { network, disk };
}

export function statusIoRates(before?: DeviceSnapshot, after?: DeviceSnapshot): Rates | undefined {
  if (!before || !after || before.counters.size !== after.counters.size || !after.counters.size) return;
  const milliseconds = after.at - before.at;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  let first = 0n;
  let second = 0n;
  for (const [device, current] of after.counters) {
    const previous = before.counters.get(device);
    if (!previous || current[0] < previous[0] || current[1] < previous[1]) return;
    first += current[0] - previous[0];
    second += current[1] - previous[1];
  }
  const rates = [Number(first) / (milliseconds / 1000), Number(second) / (milliseconds / 1000)] as const;
  if (rates.every(value => Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER)) return rates;
}
