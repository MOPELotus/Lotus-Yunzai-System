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

interface StatisticsContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly isMaster: boolean;
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
}

type Statistics = (argumentsText: string, context: StatisticsContext) => Promise<string>;

export function createModule({ messageStatistics }: { readonly messageStatistics?: Statistics }) {
  return {
    commands: {
      "#状态": (args: string, context: StatisticsContext) => messageStatistics &&
          /^(?:机器人|用户|群|消息|日期)(?:\s|$)/u.test(args)
        ? messageStatistics(args, context) : `Lotus-Yunzai 正在运行（Bun ${Bun.version}）`,
      "#统计": messageStatistics ?? (() => "消息统计当前不可用。"),
      "#帮助": () => [
        "Lotus-Yunzai 系统指令",
        "#状态 查看宿主运行状态",
        "#统计 查看消息收发量",
        "#帮助 查看系统指令",
      ].join("\n"),
      "#诊断": diagnostics,
    },
  };
}

export default createModule({});
