import { expect, test } from "bun:test";
import { collectProbeResults, isPublicProbeAddress, statusProbeSettings } from "./status-network-probes.ts";

const group = { show: "pro", concurNum: 2,
  list: [
    { name: "直连", url: "https://one.example.test/path" },
    { name: "代理", url: "https://two.example.test/", useProxy: true },
    { name: "本机", url: "https://127.0.0.1/" },
    { name: "用户信息", url: "https://login:password@two.example.test/" },
    { name: "非 HTTPS", url: "http://one.example.test" },
  ],
};

test("站点检测需显式启用，普通旧配置和失效的目标不会触发外部请求", async () => {
  expect(statusProbeSettings({ psTestSites: group })).toBeUndefined();
  const optIn = { networkProbesEnabled: true, psTestSites: group };
  expect(statusProbeSettings(optIn)?.list.map(site => site.name)).toEqual(["直连", "代理"]);
  const queried: string[] = [];
  const output = await collectProbeResults(optIn, undefined, async target => {
    queried.push(target.hostname);
    return 204;
  });
  expect(queried).toEqual(["one.example.test"]);
  expect(output?.rows[0]).toEqual(["直连", expect.stringMatching(/^HTTP 204　\d+ ms$/u)]);
  expect(output?.rows[1]).toEqual(["代理", "未配置探测代理"]);
});

test("禁止本地、私有、环回、文档和 IPv4 映射地址", () => {
  for (const blocked of ["10.2.3.4", "127.0.0.1", "169.254.1.8", "172.16.3.4", "192.168.0.1", "198.18.2.2",
    "192.0.2.2", "100.64.1.0", "::1", "::ffff:1.2.3.4", "fe80::1", "fd03::1", "2001:db8::1"]) {
    expect(isPublicProbeAddress(blocked)).toBe(false);
  }
  expect(isPublicProbeAddress("1.1.1.1")).toBe(true);
  expect(isPublicProbeAddress("2606:4700::1111")).toBe(true);
});
