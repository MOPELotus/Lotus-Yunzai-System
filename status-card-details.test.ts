import { expect, test } from "bun:test";
import { collectStatusCard } from "./status-card-data.ts";
import { parseStatusDisplayModes, parseStatusGpu, parseStatusMounts, parseStatusProcess } from "./status-card-details.ts";

test("仅识别本地卷，根卷与绑定挂载不重复，隐藏挂载不计入", () => {
  expect(parseStatusMounts([
    "1 2 8:1 /foo /bind rw - ext4 /dev/sda1 rw",
    "2 2 8:1 / / rw - ext4 /dev/sda1 rw",
    "3 2 8:2 / /home/with\\040space rw - xfs /dev/sda2 rw",
    "4 2 8:3 / /home/.hidden rw - btrfs /dev/sda3 rw",
    "5 2 0:8 / /mnt/remote rw - nfs 10.0.1.1:/network rw",
  ].join("\n"))).toEqual(["/", "/home/with space"]);
});

test("显卡采样拒绝占用超界，进程采样不读取命令参数", () => {
  expect(parseStatusGpu("NVIDIA RTX A4000, 22, 1024, 16384\nFake, 101, 1, 2\nFake, 23, 500, 100\nUnknown, N/A, 1, 2")).toEqual([
    { title: "GPU", percent: 22, detail: "NVIDIA RTX A4000", info: ["显存 1.0 GiB / 16.0 GiB"] },
  ]);
  const fields = ["S", ...Array.from({ length: 19 }, () => "0")];
  fields[11] = "10";
  fields[12] = "5";
  fields[19] = "170";
  expect(parseStatusProcess(`42 (worker) test) ${fields.join(" ")}`, "VmRSS:\t2048 kB\nCmdLine:\tsecret")).toEqual({
    name: "worker) test", state: "S", ticks: 15, started: 170, memory: 2097152,
  });
});

test("普通状态不收集扩展诊断或输出 Redis 原始数据和历史", async () => {
  const at = Date.now() - 1000;
  const model = await collectStatusCard({ accounts: [], redis: { version: "8.1.1", databases: [] } }, false,
    { showFastFetch: true, showRedisInfo: true, processLoad: { show: true } },
    [{ at, network: [2, 3], redisClients: 10 }, { at: at + 1, network: [3, 4], redisClients: 12 }]);
  expect(model.details).toBeUndefined();
  expect(model.networkHistory).toBeUndefined();
  expect(model.redisHistory).toBeUndefined();
  expect(model.redis).toBeUndefined();
  expect(model.resources.every(resource => ["CPU", "RAM"].includes(resource.title))).toBe(true);
});

test("显示器只输出已连接输出端提供的分辨率格式", () => {
  expect(parseStatusDisplayModes("3840x2160\n1920x1080\n1920x1080\ninvalid\n720x480\n"))
    .toEqual(["3840x2160", "1920x1080", "720x480"]);
});
