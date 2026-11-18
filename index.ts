function diagnostics(): string {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  const mib = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);
  return [
    "Lotus-Yunzai 运行诊断",
    `运行环境　Bun ${Bun.version} · ${process.platform}/${process.arch}`,
    `运行时间　${Math.floor(process.uptime())} 秒`,
    `常驻内存　${mib(rss)} MiB`,
    `JS 堆内存　${mib(heapUsed)} / ${mib(heapTotal)} MiB`,
  ].join("\n");
}

export default {
  commands: {
    "#状态": () => `Lotus-Yunzai 正在运行（Bun ${Bun.version}）`,
    "#帮助": () => [
      "Lotus-Yunzai 系统指令",
      "#状态 查看宿主运行状态",
      "#帮助 查看系统指令",
    ].join("\n"),
    "#诊断": diagnostics,
  },
};
