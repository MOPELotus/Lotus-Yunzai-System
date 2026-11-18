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
type RuntimeDiagnostics = (context: StatisticsContext) => {
  readonly accounts: readonly { id: number; seconds: number; adapter?: "milky" }[];
  readonly plugins: readonly { name: string; milliseconds: number }[];
};
interface RuntimeVersion {
  readonly version?: string;
  readonly revision?: string;
  readonly modified?: boolean;
  readonly modules: readonly { name: string; revision: string }[];
}

function versionSummary(runtime?: RuntimeVersion): string {
  const version = runtime?.version || "开发构建";
  const revision = runtime?.revision?.slice(0, 12) || "提交号不可用";
  const modified = runtime?.modified ? "（有本地修改）" : "";
  const modules = runtime?.modules.map(({ name, revision }) => `${name}　${revision.slice(0, 12)}`) ?? [];
  return [
    "Lotus-Yunzai 版本",
    `宿主版本　${version}`,
    `宿主提交　${revision}${modified}`,
    "",
    "内置模块",
    ...(modules.length ? modules : ["暂无内置模块版本记录"]),
  ].join("\n");
}

function uptime(seconds: number): string {
  const elapsed = Math.floor(seconds);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor(elapsed / 60) % 60;
  return `${hours ? `${hours} 小时 ` : ""}${minutes ? `${minutes} 分钟 ` : ""}${elapsed % 60} 秒`;
}

export function createModule({ messageStatistics, runtimeDiagnostics, runtimeVersion }: {
  readonly messageStatistics?: Statistics;
  readonly runtimeDiagnostics?: RuntimeDiagnostics;
  readonly runtimeVersion?: RuntimeVersion;
}) {
  function withRuntime(summary: string, context?: StatisticsContext): string {
    if (!runtimeDiagnostics || context?.isMaster !== true) return summary;

    const { accounts, plugins } = runtimeDiagnostics(context);
    const accountRows = accounts.map(({ id, seconds, adapter }) =>
      `${id}　${adapter === "milky" ? "Milky　" : ""}${uptime(seconds)}`);
    const pluginRows = plugins.map(({ name, milliseconds }) => `${name}　${Math.round(milliseconds)} ms`);
    return [
      summary,
      "",
      "账号在线时长",
      ...(accountRows.length ? accountRows : ["暂无在线账号"]),
      "",
      "插件加载用时",
      ...(pluginRows.length ? pluginRows : ["暂无插件加载记录"]),
    ].join("\n");
  }

  return {
    commands: {
      "#状态": (args = "", context: StatisticsContext) => {
        if (messageStatistics && /^(?:机器人|用户|群|消息|日期)(?:\s|$)/u.test(args)) {
          return messageStatistics(args, context);
        }
        const summary = `Lotus-Yunzai 正在运行（Bun ${Bun.version}）`;
        return args.trim() ? summary : withRuntime(summary, context);
      },
      "#统计": messageStatistics ?? (() => "消息统计当前不可用。"),
      "#版本": () => versionSummary(runtimeVersion),
      "#帮助": () => [
        "Lotus-Yunzai 系统指令",
        "#状态 查看宿主运行状态",
        "#统计 查看消息收发量",
        "#帮助 查看系统指令",
        "#版本 查看宿主和内置模块版本",
      ].join("\n"),
      "#诊断": (_args?: string, context?: StatisticsContext) => withRuntime(diagnostics(), context),
    },
  };
}

export default createModule({});
