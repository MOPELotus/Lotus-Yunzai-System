import { expect, test } from "bun:test";
import { createModule } from "./index.ts";
import { statusMonitorText } from "./status-monitor-renderer.ts";
import { diskSectorCounters, statusIoRates, type StatusIoCounters } from "./status-monitor-io.ts";
import { createStatusMonitor, statusMonitorSettings, statusMonitorTtl } from "./status-monitor.ts";

test("保留旧监控设置，拒绝零间隔和无界历史", () => {
  expect(statusMonitorSettings()).toEqual({ enabled: true, interval: 60_000, limit: 60, persist: true });
  expect(statusMonitorSettings({ monitor: { open: false, getDataInterval: 0, saveDataNumber: 9999, openRedisSaveData: false } }))
    .toEqual({ enabled: false, interval: 60_000, limit: 60, persist: false });
  expect(statusMonitorSettings({ monitor: { getDataInterval: 1_000, saveDataNumber: 1 } }))
    .toEqual({ enabled: true, interval: 1_000, limit: 1, persist: true });
});

test("恢复并修剪存档，只续存真实采样及固定的过期时间", async () => {
  let at = 1_800_000_000_000;
  const stale = at - statusMonitorTtl * 1000;
  const current = at;
  const reads = [
    { at: stale, cpu: 20 }, { at: current - 1_000, cpu: 0 }, { at: current, ram: 1024 },
    { at: current + 20_000, cpu: 65 }, { at: current - 2_000, cpu: -99 },
  ];
  const writes: unknown[][] = [];
  let times = { idle: 20, total: 100 };
  const monitor = createStatusMonitor({ enabled: true, limit: 2, interval: 60_000, persist: true }, {
    storage: {
      async get(key) { expect(key).toBe("history"); return JSON.stringify(reads); },
      async set(...args) { writes.push(args); },
    },
    now: () => at, readCpu: () => times, readRam: async () => 2048, readIo: async () => ({}),
  });
  expect((await monitor.snapshot()).samples).toEqual([
    { at: current - 1_000, cpu: 0, ram: undefined }, { at: current, cpu: undefined, ram: 1024 },
  ]);
  expect(writes).toHaveLength(0);
  times = { idle: 70, total: 200 };
  at += 1000;
  await monitor.tick();
  expect(writes).toEqual([["history", JSON.stringify([{ at: current, ram: 1024 }, { at, cpu: 50, ram: 2048 }]), statusMonitorTtl]]);
  expect(statusMonitorText((await monitor.snapshot()).samples)).toContain("CPU　50.0%");
  expect(statusMonitorText((await monitor.snapshot()).samples)).toContain("RAM　2.0KB");
  at += statusMonitorTtl * 1000;
  expect((await monitor.snapshot()).samples).toEqual([]);
});

test("并发采样合并，关闭宿主时仍在读取的样本不写入", async () => {
  const abort = new AbortController();
  const ram = Promise.withResolvers<number>();
  let reads = 0;
  let writes = 0;
  const monitor = createStatusMonitor(statusMonitorSettings(), {
    signal: abort.signal,
    readCpu: () => ({ idle: 0, total: 100 }),
    readRam: () => { reads++; return ram.promise; },
    readIo: async () => ({}),
    storage: { async get() {}, async set() { writes++; } },
  });
  const inFlight = monitor.tick();
  expect(monitor.tick()).toBe(inFlight);
  while (!reads) await Promise.resolve();
  abort.abort();
  ram.resolve(5);
  await monitor.dispose();
  expect(reads).toBe(1);
  expect(writes).toBe(0);
  expect((await monitor.snapshot()).samples).toEqual([]);
});

test("暂停监控可看原有样本，关闭持久化时完全不访问存储", async () => {
  const at = Date.now();
  let requests = 0;
  const storage = {
    async get() { requests++; return JSON.stringify([{ at, ram: 0 }]); },
    async set() { throw new Error("暂停时不写入"); },
  };
  const paused = createStatusMonitor({ ...statusMonitorSettings(), enabled: false }, {
    storage, readCpu: () => { throw new Error("暂停时不启动采样"); }, now: () => at,
  });
  await paused.tick();
  const snapshot = await paused.snapshot();
  expect(snapshot).toEqual({ enabled: false, samples: [{ at, ram: 0 }] });
  expect(statusMonitorText(snapshot.samples, snapshot.enabled)).toContain("当前已关闭持续采样。");
  const memoryOnly = createStatusMonitor({ ...statusMonitorSettings(), enabled: false, persist: false }, { storage });
  expect((await memoryOnly.snapshot()).samples).toEqual([]);
  expect(requests).toBe(1);
});

test("保留旧监控命令，尚无样本时输出诚实说明", async () => {
  const { commands } = createModule({});
  expect(commands["#椰奶监控"]).toBe(commands["#监控"]);
  expect(await commands["#监控"]()).toBe("Lotus-Yunzai 监控\n等待首次采样。");
  expect(await commands["#监控"]("任意参数")).toBe("用法：#监控。");
});

test("使用内核的 512 字节扇区和大整数累计值，拒绝无效输入", () => {
  expect(diskSectorCounters("1 0 9223372036854775808 0 2 0 7 0 0 0 0"))
    .toEqual([9223372036854775808n * 512n, 3584n]);
  expect(diskSectorCounters("1 0 9223372036854775808 0 2 0 -7 0 0 0 0")).toBeUndefined();
  expect(diskSectorCounters("1 0 18446744073709551616 0 2 0 7 0 0 0 0")).toBeUndefined();
  expect(diskSectorCounters("1 0 1")).toBeUndefined();
});

const bus = (at: number, first: bigint, second: bigint, device = "fixture") => ({
  at,
  counters: new Map([[device, [first, second] as const], ["another", [100n, 100n] as const]]),
});

test("仅对同设备组同次开机求速率，回绕、换设备或间隔异常无结果", () => {
  const before = bus(1000, 9_007_199_254_740_992n, 100n);
  expect(statusIoRates(before, bus(3000, 9_007_199_254_740_993n, 170n))).toEqual([0.5, 35]);
  expect(statusIoRates(before, bus(3000, 9_007_199_254_740_992n, 100n))).toEqual([0, 0]);
  expect(statusIoRates(before, bus(1000, 9_007_199_254_740_993n, 170n))).toBeUndefined();
  expect(statusIoRates(before, bus(3000, 96n, 190n))).toBeUndefined();
  expect(statusIoRates(before, bus(3000, 9_007_199_254_740_993n, 170n, "new"))).toBeUndefined();
  expect(statusIoRates(undefined, before)).toBeUndefined();
});

test("恢复旧 CPU/RAM 和吞吐历史，新监控仅保存核验过的聚合速率", async () => {
  let at = 1_800_000_000_000;
  const captures: StatusIoCounters[] = [
    { network: bus(10, 100n, 200n), disk: bus(10, 120n, 210n) },
    { network: bus(1010, 100n, 201n), disk: bus(1010, 110n, 215n) },
    { disk: bus(3010, 140n, 215n) },
    { network: bus(4010, 140n, 240n), disk: bus(4010, 142n, 221n) },
  ];
  const storage = {
    value: JSON.stringify([
      { at: at - 2000, cpu: 10, ram: 1024 },
      { at: at - 1000, cpu: 11, ram: 1025, disk: [100, 200], network: [0, -1], extra: "discard" },
    ]),
    async get() { return this.value; },
    async set(_key: string, value: string) { this.value = value; },
  };
  const monitor = createStatusMonitor(statusMonitorSettings(), {
    storage,
    now: () => at,
    readRam: async () => 2048,
    readCpu: () => ({ idle: 1, total: at }),
    readIo: async () => captures.shift() ?? {},
  });
  expect((await monitor.snapshot()).samples).toEqual([
    { at: at - 2000, cpu: 10, ram: 1024 },
    { at: at - 1000, cpu: 11, ram: 1025, disk: [100, 200] },
  ]);
  at += 1000;
  await monitor.tick();
  expect((await monitor.snapshot()).samples.at(-1)).toEqual({ at, cpu: 100, ram: 2048, network: [0, 1] });
  at += 2000;
  await monitor.tick();
  expect((await monitor.snapshot()).samples.at(-1)).toEqual({ at, cpu: 100, ram: 2048, disk: [15, 0] });
  at += 1000;
  await monitor.tick();
  const { samples } = await monitor.snapshot();
  expect(samples.at(-1)).toEqual({ at, cpu: 100, ram: 2048, disk: [2, 6] });
  expect(statusMonitorText(samples)).toContain("网络　最近一次采样无有效数据");
  expect(statusMonitorText(samples)).toContain("磁盘　读 2.0B/s　写 6.0B/s");
  expect(storage.value).not.toMatch(/another|fixture|extra/u);
});
