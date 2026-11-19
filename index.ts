import { collectStatusCard, type RuntimeStatusSnapshot } from "./status-card-data.ts";
import { loadStatusCardTheme, renderStatusCard, statusCardThemeDirectory } from "./status-card-renderer.ts";
import { readStatusOriginal } from "./status-background.ts";
import { createStatusPhotoLedger, type StatusPhotoStorage } from "./status-photo-ledger.ts";
import { publicVersionChanges, versionCardSections, type RuntimeVersion } from "./version-card-data.ts";
import { loadVersionCardTheme, renderVersionCard } from "./version-card-renderer.ts";

export type { RuntimeStatusAccount, RuntimeStatusSnapshot } from "./status-card-data.ts";
export type { StatusPhotoStorage } from "./status-photo-ledger.ts";
export type { RuntimeVersion, VersionCardEntry, VersionCardRelease } from "./version-card-data.ts";

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

interface DiagnosticsContext extends StatisticsContext {
  readonly adapter?: "milky";
  readonly message_id?: number;
  readonly runtimeStatusScope?: "onebot" | "milky" | "terminal";
  readonly runtimeDiagnosticsScope?: "milky";
  readonly isDelegated?: boolean;
  readonly privateCredentialSignal?: AbortSignal;
}

interface OriginalPhotoContext extends DiagnosticsContext {
  readonly reply_id?: string | number;
  readonly lookupReply?: () => Promise<{
    readonly user_id: number;
    readonly message: readonly { readonly type: string }[];
  } | undefined>;
}

type Statistics = (argumentsText: string, context: StatisticsContext) => Promise<string>;
type RuntimeDiagnostics = (context: DiagnosticsContext) => {
  readonly accounts: readonly { id: number; seconds: number; adapter?: "milky" }[];
  readonly plugins: readonly { name: string; milliseconds: number }[];
} | undefined;
type RuntimeStatus = (context: DiagnosticsContext, pro: boolean) =>
  RuntimeStatusSnapshot | Promise<RuntimeStatusSnapshot | undefined> | undefined;
function versionSummary(runtime?: RuntimeVersion): string {
  const version = runtime?.version || "开发构建";
  const revision = runtime?.revision?.slice(0, 12) || "提交号不可用";
  const modified = runtime?.modified ? "（有本地修改）" : "";
  const modules = runtime?.modules.map(({ name, revision }) => `${name}　${revision.slice(0, 12)}`) ?? [];
  const changes = publicVersionChanges(runtime).flatMap(({ version, entries }) => [
    "", `Lotus-Yunzai 版本 ${version}`,
    ...entries.flatMap(({ title, notes }) => [`· ${title}`, ...(notes ?? []).map(note => `  ◦ ${note}`)]),
  ]);
  return [
    "Lotus-Yunzai 版本",
    `宿主版本　${version}`,
    `宿主提交　${revision}${modified}`,
    "",
    "内置模块",
    ...(modules.length ? modules : ["暂无内置模块版本记录"]),
    ...changes,
  ].join("\n");
}

function uptime(seconds: number): string {
  const elapsed = Math.floor(seconds);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor(elapsed / 60) % 60;
  return `${hours ? `${hours} 小时 ` : ""}${minutes ? `${minutes} 分钟 ` : ""}${elapsed % 60} 秒`;
}

export function createModule({ messageStatistics, runtimeDiagnostics, runtimeVersion, runtimeStatus, statusPhotoStorage, signal }: {
  readonly messageStatistics?: Statistics;
  readonly runtimeDiagnostics?: RuntimeDiagnostics;
  readonly runtimeVersion?: RuntimeVersion;
  readonly runtimeStatus?: RuntimeStatus;
  readonly statusPhotoStorage?: StatusPhotoStorage;
  readonly signal?: AbortSignal;
}) {
  const photos = createStatusPhotoLedger(statusPhotoStorage, signal);
  function withRuntime(summary: string, context?: DiagnosticsContext): string {
    if (!context || (context.isMaster !== true && context.runtimeDiagnosticsScope !== "milky")) return summary;

    const runtime = runtimeDiagnostics?.(context);
    if (!runtime) return summary;
    const { accounts, plugins } = runtime;
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

  let rendering = false;
  async function statusCard(context: DiagnosticsContext, pro: boolean, fallback: () => string) {
    const { message_type, isMaster, self_id, user_id, runtimeDiagnosticsScope } = context;
    const ownerTerminal = message_type === "terminal" && isMaster === true;
    const ownerPrivate = message_type === "private" &&
      typeof self_id === "number" && Number.isSafeInteger(self_id) && self_id > 0 &&
      typeof user_id === "number" && Number.isSafeInteger(user_id) && user_id > 0 &&
      (isMaster === true || runtimeDiagnosticsScope === "milky");
    if (pro && !ownerTerminal && !ownerPrivate) {
      return "状态 Pro 仅供当前机器人的主人私聊或授权终端查看。";
    }
    let snapshot: RuntimeStatusSnapshot | undefined;
    let theme: Awaited<ReturnType<typeof loadStatusCardTheme>>;
    try {
      if (!pro) {
        theme = await loadStatusCardTheme();
        if (!theme) return fallback();
      }
      snapshot = await runtimeStatus?.(context, pro);
    } catch {
      return pro ? "当前会话无法读取状态 Pro。" : fallback();
    }
    if (!snapshot) return pro ? "当前会话无法读取状态 Pro。" : fallback();
    if (rendering) return fallback();
    rendering = true;
    try {
      theme ??= await loadStatusCardTheme();
      if (!theme) return fallback();
      const model = await collectStatusCard(snapshot, pro);
      const result = await renderStatusCard(model, theme);
      console.log(`[渲染] 运行状态 ${result.engine.renderer} ${result.engine.api} ${result.engine.device}`);
      const message = { type: "image" as const, file: result.png };
      if (context.runtimeStatusScope !== "onebot" && context.runtimeStatusScope !== "milky") return message;
      const { photo } = theme;
      return {
        type: "delivery" as const, message,
        onDelivered: (id: number) => photos.delivered(context, context.message_id, id, photo),
      };
    } catch {
      return fallback();
    } finally {
      rendering = false;
    }
  }

  function status(args = "", context?: DiagnosticsContext) {
    if (messageStatistics && context && /^(?:机器人|用户|群|消息|日期)(?:\s|$)/u.test(args)) {
      return messageStatistics(args, context);
    }
    const summary = `Lotus-Yunzai 正在运行（Bun ${Bun.version}）`;
    if (args.trim()) return summary;
    const fallback = () => withRuntime(summary, context);
    return runtimeStatus && context ? statusCard(context, false, fallback) : fallback();
  }

  function proStatus(args = "", context?: DiagnosticsContext) {
    if (args.trim()) return "用法：#状态pro。";
    if (!context) return "当前会话无法读取状态 Pro。";
    return statusCard(context, true, () => withRuntime(diagnostics(), context));
  }

  async function versionCard() {
    try {
      const theme = await loadVersionCardTheme();
      if (theme) {
        const result = await renderVersionCard(versionCardSections(runtimeVersion), theme);
        console.log(`[渲染] 版本 ${result.engine.renderer} ${result.engine.api} ${result.engine.device}`);
        return { type: "image" as const, file: result.png };
      }
    } catch {
      // The text and terminal report remain available when the local theme cannot be rendered.
    }
    return versionSummary(runtimeVersion);
  }

  async function originalPhoto(message: string, context: OriginalPhotoContext) {
    if (!/^#?原图$/u.test(message.trim()) || !context.lookupReply) return;
    const record = await photos.find(context, context.reply_id);
    if (!record) return;
    try {
      const quote = await context.lookupReply();
      if (!quote || quote.user_id !== record.authoredBy ||
          (record.card && !quote.message.some(part => part.type === "image"))) return;
      if (signal?.aborted || context.privateCredentialSignal?.aborted) return;
      const file = await readStatusOriginal(statusCardThemeDirectory(), record.photo);
      if (file && !signal?.aborted && !context.privateCredentialSignal?.aborted) {
        return { type: "image" as const, file };
      }
    } catch {
      return;
    }
  }

  return {
    fallback: originalPhoto,
    fallbackFeatures: () => ["[system] 状态"],
    commands: {
      "#状态": status,
      "#椰奶状态": status,
      "#状态pro": proStatus,
      "#椰奶状态pro": proStatus,
      "#统计": messageStatistics ?? (() => "消息统计当前不可用。"),
      "#版本": (_args = "", context?: StatisticsContext) =>
        runtimeVersion && context && context.message_type !== "terminal" ? versionCard() : versionSummary(runtimeVersion),
      "#帮助": () => [
        "Lotus-Yunzai 系统指令",
        "#状态 查看宿主运行状态",
        "#状态pro 主人私聊查看详细状态",
        "#统计 查看消息收发量",
        "#帮助 查看系统指令",
        "#版本 查看宿主和内置模块版本",
      ].join("\n"),
      "#诊断": (args = "", context?: DiagnosticsContext) => {
        const summary = diagnostics();
        return args.trim() && context?.isMaster !== true ? summary : withRuntime(summary, context);
      },
    },
  };
}

export default createModule({});
