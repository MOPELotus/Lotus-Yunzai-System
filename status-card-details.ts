import { execFile } from "node:child_process";
import { readFile, readdir, statfs } from "node:fs/promises";
import { arch, availableParallelism, cpus, release, totalmem } from "node:os";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { readStatusIoCounters, statusIoRates, type StatusIoCounters } from "./status-monitor-io.ts";
import type { RuntimeStatusRedis, StatusResource } from "./status-card-data.ts";

export interface StatusDetailSection {
  readonly title: string;
  readonly icon: "磁盘" | "网络" | "redis" | "进程负载" | "系统";
  readonly rows: readonly (readonly [string, string])[];
}

const execute = promisify(execFile);
const diskTypes = new Set(["apfs", "btrfs", "exfat", "ext2", "ext3", "ext4", "f2fs", "fuseblk", "jfs", "ntfs", "ntfs3",
  "reiserfs", "vfat", "xfs", "zfs"]);

function label(value: string) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 96);
}

function bytes(value: number | bigint) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let amount = Number(value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function parseStatusMounts(raw: string) {
  const all = new Map<string, string>();
  for (const row of raw.split("\n")) {
    const [mount, fileSystem] = row.split(" - ", 2);
    const fields = mount?.split(" ");
    if (!fields || !diskTypes.has(fileSystem?.split(" ")[0] ?? "") || !fields[2] || !fields[4]) continue;
    const path = fields[4].replace(/\\(040|011|012|134)/gu, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
    if (!path.startsWith("/") || path.includes("\x00") || path.split("/").some(part => part.startsWith("."))) continue;
    if (path === "/" || !all.has(fields[2])) all.set(fields[2], path);
  }
  const paths = [...all.values()];
  return ["/", ...paths.filter(path => path !== "/")].slice(0, 16);
}

async function filesystemRows() {
  const mounts = process.platform === "linux"
    ? await readFile("/proc/self/mountinfo", "utf8").then(parseStatusMounts, () => ["/"])
    : [process.platform === "win32" ? process.cwd().slice(0, 3) : process.platform === "darwin" ? "/System/Volumes/Data" : "/"];
  const sampled = await Promise.all(mounts.map(async (path, i) => {
    const info = await statfs(path, { bigint: true }).catch(() => undefined);
    if (!info || info.bsize <= 0n || info.blocks <= 0n || info.bfree < 0n || info.bfree > info.blocks ||
        info.bavail < 0n || info.bavail > info.blocks) return;
    const used = (info.blocks - info.bfree) * info.bsize;
    const total = info.blocks * info.bsize;
    return [i === 0 ? "根目录" : `数据卷 ${i}`,
      `${bytes(used)} / ${bytes(total)}　使用 ${Number(used * 100n / total)}%　可用 ${bytes(info.bavail * info.bsize)}`] as const;
  }));
  return sampled.filter(row => row !== undefined);
}

export function parseStatusGpu(raw: string): StatusResource[] {
  return raw.trim().split("\n").flatMap(row => {
    const fields = row.split(",").map(value => value.trim());
    if (fields.length !== 4) return [];
    const [name, load, used, total] = fields;
    if (!name || !load || !used || !total || ![load, used, total].every(value => /^\d+(?:\.\d+)?$/u.test(value))) return [];
    const [percent, usedMib, capacityMib] = [Number(load), Number(used), Number(total)];
    if (percent > 100 || capacityMib <= 0 || usedMib > capacityMib || !Number.isFinite(capacityMib)) return [];
    return [{ title: "GPU", percent, detail: label(name),
      info: [`显存 ${bytes(usedMib * 1024 ** 2)} / ${bytes(capacityMib * 1024 ** 2)}`] }];
  }).slice(0, 8);
}

async function gpuResources() {
  const command = Bun.which("nvidia-smi");
  if (!command) return [];
  return execute(command, ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
    { timeout: 700, maxBuffer: 16 * 1024, windowsHide: true }).then(({ stdout }) => parseStatusGpu(stdout), () => []);
}

interface ProcessReading {
  readonly name: string;
  readonly state: string;
  readonly ticks: number;
  readonly started: number;
  readonly memory: number;
}

export function parseStatusProcess(stat: string, status: string): ProcessReading | undefined {
  const begin = stat.indexOf("(");
  const end = stat.lastIndexOf(")");
  if (begin < 0 || end <= begin) return;
  const values = stat.slice(end + 1).trim().split(/\s+/u);
  const ticks = Number(values[11]) + Number(values[12]);
  const started = Number(values[19]);
  const memory = Number(/^VmRSS:\s+(\d+) kB$/mu.exec(status)?.[1] ?? 0) * 1024;
  if (!values[0] || !Number.isSafeInteger(ticks) || ticks < 0 || !Number.isSafeInteger(started) ||
      started < 0 || !Number.isSafeInteger(memory)) return;
  return { name: label(stat.slice(begin + 1, end)), state: values[0], ticks, started, memory };
}

async function statusProcesses(directory = "/proc") {
  const entries = await readdir(directory).catch(() => []);
  const pids = entries.filter(entry => /^\d{1,9}$/u.test(entry)).slice(0, 2048);
  const rows = new Map<string, ProcessReading>();
  for (let index = 0; index < pids.length; index += 64) {
    await Promise.all(pids.slice(index, index + 64).map(async pid => {
      const statFile = directory + "/" + pid + "/stat";
      const [stat, status] = await Promise.all([
        readFile(statFile, "utf8").catch(() => ""), readFile(directory + "/" + pid + "/status", "utf8").catch(() => ""),
      ]);
      const row = parseStatusProcess(stat, status);
      if (row) rows.set(pid, row);
    }));
  }
  return rows;
}

async function cpuTicks() {
  const raw = await readFile("/proc/stat", "utf8").catch(() => "");
  const line = /^cpu\s+(\d+(?:\s+\d+){3,})/mu.exec(raw)?.[1];
  return line ? line.split(/\s+/u).slice(0, 8).reduce((sum, value) => sum + Number(value), 0) : 0;
}

function processRows(previous: ReadonlyMap<string, ProcessReading>, current: ReadonlyMap<string, ProcessReading>,
  elapsedTicks: number, config?: Record<string, unknown>): StatusDetailSection["rows"] {
  const filter = literalNames(config?.filterList);
  const counts = { running: 0, sleeping: 0, blocked: 0, other: 0 };
  const full = [...current].flatMap(([pid, process]) => {
    if (filter.includes(process.name)) return [];
    if (process.state === "R") counts.running++;
    else if (process.state === "D") counts.blocked++;
    else if (process.state === "S" || process.state === "I") counts.sleeping++;
    else counts.other++;
    const before = previous.get(pid);
    const cpu = before?.started === process.started && elapsedTicks > 0 && process.ticks >= before.ticks
      ? (process.ticks - before.ticks) / elapsedTicks * availableParallelism() * 100 : undefined;
    return [{ pid, cpu, ...process }];
  });
  if (!full.length) return [];
  const top = object(config?.showMax);
  const order = top?.order;
  const limit = typeof top?.showNum === "number" && Number.isSafeInteger(top.showNum)
    ? Math.max(0, Math.min(16, top.showNum)) : 6;
  const byCpu = [...full].sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1));
  const byMemory = [...full].sort((a, b) => b.memory - a.memory);
  const selected = top?.show === false ? [] : order === "cpu" ? byCpu.slice(0, limit)
    : order === "cpu_mem" ? [...byCpu.slice(0, Math.ceil(limit / 2)), ...byMemory.slice(0, Math.floor(limit / 2))]
      : byMemory.slice(0, limit);
  const names = literalNames(config?.list);
  const observed = [...new Map([...selected, ...full.filter(row => names.includes(row.name))].map(row => [row.pid, row])).values()];
  return [
    ["进程数", `全部 ${full.length}　运行 ${counts.running}　休眠 ${counts.sleeping}　阻塞 ${counts.blocked}　其他 ${counts.other}`],
    ...observed.slice(0, 20).map(row => [row.name || "进程", `CPU ${row.cpu === undefined ? "—" : row.cpu.toFixed(1) + "%"}　RAM ${bytes(row.memory)}`] as const),
  ];
}

function literalNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && name.length <= 96).slice(0, 64) : [];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function totalTraffic(snapshot: StatusIoCounters["network"]) {
  if (!snapshot) return;
  let sent = 0n;
  let received = 0n;
  for (const [tx, rx] of snapshot.counters.values()) {
    sent += tx;
    received += rx;
  }
  return [sent, received] as const;
}

function redisRows(redis: RuntimeStatusRedis): StatusDetailSection["rows"] {
  const value = (key: keyof RuntimeStatusRedis) => redis[key] ?? "—";
  return [
    ["版本", `${value("version")}　运行 ${value("uptime")} 秒`],
    ["内存", `${redis.usedMemory === undefined ? "—" : bytes(redis.usedMemory)}　峰值 ${redis.peakMemory === undefined ? "—" : bytes(redis.peakMemory)}${redis.maxMemory ? "　上限 " + bytes(redis.maxMemory) : ""}`],
    ["连接", `客户端 ${value("clients")}　阻塞 ${value("blocked")}　累计 ${value("connections")}`],
    ["累计命令", String(value("commands"))],
    ...redis.databases.map(db => [`db${db.index}`, `键数 ${db.keys}　有期限 ${db.expires}　平均 TTL ${db.averageTtl} ms`] as const),
  ];
}

async function systemDetails(gpu: readonly StatusResource[]) {
  const localAttribute = (file: string) => process.platform === "linux"
    ? readFile(file, "utf8").then(label, () => "") : Promise.resolve("");
  const [os, board, bios] = await Promise.all([
    process.platform === "linux"
      ? readFile("/etc/os-release", "utf8").then(raw => label(/^PRETTY_NAME="?([^"\n]+)"?$/mu.exec(raw)?.[1] ?? ""), () => "")
      : "",
    localAttribute("/sys/class/dmi/id/board_name"),
    localAttribute("/sys/class/dmi/id/bios_version"),
  ]);
  const cpu = label(cpus()[0]?.model ?? "");
  return { title: "FastFetch", icon: "系统", rows: [
    ["系统", os || process.platform], ["内核", release()], ["架构", arch()],
    ["处理器", [cpu, `${availableParallelism()} 逻辑核心`].filter(Boolean).join(" · ")],
    ...gpu.flatMap(item => item.detail ? [["GPU", item.detail] as const] : []),
    ["物理内存", bytes(totalmem())],
    ...(board ? [["主板", board] as const] : []),
    ...(bios ? [["BIOS", bios] as const] : []),
  ] } as const satisfies StatusDetailSection;
}

export async function collectStatusDetails(config: Record<string, unknown>, redis?: RuntimeStatusRedis) {
  const processConfig = object(config.processLoad);
  const includeProcess = process.platform === "linux" && processConfig?.show !== false;
  const first = await readStatusIoCounters();
  const [last, volumes, gpu, processes] = await Promise.all([
    setTimeout(160).then(readStatusIoCounters),
    filesystemRows(),
    gpuResources(),
    includeProcess ? (async () => {
      const [previous, before] = await Promise.all([statusProcesses(), cpuTicks()]);
      await setTimeout(160);
      const [current, after] = await Promise.all([statusProcesses(), cpuTicks()]);
      return processRows(previous, current, after - before, processConfig);
    })() : [],
  ]);
  const disk = statusIoRates(first.disk, last.disk);
  const network = statusIoRates(first.network, last.network);
  const traffic = totalTraffic(last.network);
  const sections: StatusDetailSection[] = [];
  if (volumes.length || disk) sections.push({ title: "硬盘信息", icon: "磁盘", rows: [...volumes,
    ...(disk ? [["磁盘读写", `读 ${bytes(disk[0])}/s　写 ${bytes(disk[1])}/s`] as const] : [])] });
  if (network || traffic) sections.push({ title: "网络信息", icon: "网络", rows: [
    ...(network ? [["当前速率", `上传 ${bytes(network[0])}/s　下载 ${bytes(network[1])}/s`] as const] : []),
    ...(traffic ? [["累计流量", `上传 ${bytes(traffic[0])}　下载 ${bytes(traffic[1])}`] as const] : []),
  ] });
  if (redis && config.showRedisInfo !== false) sections.push({ title: "Redis 服务器", icon: "redis", rows: redisRows(redis) });
  if (processes.length) sections.push({ title: "进程负载", icon: "进程负载", rows: processes });
  if (config.showFastFetch !== false) sections.push(await systemDetails(gpu));
  return { gpu, sections };
}
