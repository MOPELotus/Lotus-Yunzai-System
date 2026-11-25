import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("system", messageCatalog.messages);
import { collectStatusCard, type RuntimeStatusSnapshot } from "./status-card-data.ts";
import { loadStatusCardTheme, renderStatusCard, statusCardThemeDirectory } from "./status-card-renderer.ts";
import { readStatusConfig, readStatusOriginal } from "./status-background.ts";
import { createStatusPhotoLedger, type StatusPhotoStorage } from "./status-photo-ledger.ts";
import { createStatusMonitor, statusMonitorSettings, type StatusMonitorStorage } from "./status-monitor.ts";
import { statusSettingsRecord } from "./status-card-style.ts";
import { renderStatusMonitor, statusMonitorText } from "./status-monitor-renderer.ts";
import { publicVersionChanges, versionCardSections, type RuntimeVersion } from "./version-card-data.ts";
import { loadVersionCardTheme, renderVersionCard } from "./version-card-renderer.ts";
import { isSystemHelpAlias } from "./help-command.ts";

const helpUrl = "https://www.lotusshared.cn/yunzai/";

export type { RuntimeStatusAccount, RuntimeStatusSnapshot } from "./status-card-data.ts";
export type { StatusPhotoStorage } from "./status-photo-ledger.ts";
export type { StatusMonitorStorage } from "./status-monitor.ts";
export type { RuntimeVersion, VersionCardEntry, VersionCardRelease } from "./version-card-data.ts";

function diagnostics(): string {
  const { rss, heapUsed, heapTotal } = process.memoryUsage();
  const mib = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);
  return [
    $t("index.text_c90078a108"),
    $t("index.text_8bb0d9bfa9", { "version": Bun.version, "platform": process.platform, "arch": process.arch }),
    $t("index.text_f71063a4e8", { "value1": Math.floor(process.uptime()) }),
    $t("index.text_6d74c99768", { "value1": mib(rss) }),
    $t("index.text_12e1484d50", { "value1": mib(heapUsed), "value2": mib(heapTotal) }),
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
  readonly inlineImageByteLimit?: number;
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
  const version = runtime?.version || $t("index.text_53fd643fa6");
  const revision = runtime?.revision?.slice(0, 12) || $t("index.text_63cffd447f");
  const modified = runtime?.modified ? $t("index.text_c453df6435") : "";
  const modules = runtime?.modules.map(({ name, revision }) => `${name}　${revision.slice(0, 12)}`) ?? [];
  const changes = publicVersionChanges(runtime).flatMap(({ version, entries }) => [
    "", $t("index.text_f20304d428", { "version": version }),
    ...entries.flatMap(({ title, notes }) => [`· ${title}`, ...(notes ?? []).map(note => `  ◦ ${note}`)]),
  ]);
  return [
    $t("index.text_738e2da28a"),
    $t("index.text_eaa4764faf", { "version": version }),
    $t("index.text_368320762b", { "revision": revision, "modified": modified }),
    "",
    $t("index.text_0f5e7ba3d2"),
    ...(modules.length ? modules : [$t("index.text_780ac58fe9")]),
    ...changes,
  ].join("\n");
}

function uptime(seconds: number): string {
  const elapsed = Math.floor(seconds);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor(elapsed / 60) % 60;
  return $t("index.text_cc5360ff29", { "value1": hours ? $t("index.text_969e87756b", { "hours": hours }) : "", "value2": minutes ? $t("index.text_5b189bd3b8", { "minutes": minutes }) : "", "value3": elapsed % 60 });
}

export function createModule({ messageStatistics, runtimeDiagnostics, runtimeVersion, runtimeStatus,
  statusPhotoStorage, statusMonitorStorage, statusMonitorRedisClients, signal }: {
  readonly messageStatistics?: Statistics;
  readonly runtimeDiagnostics?: RuntimeDiagnostics;
  readonly runtimeVersion?: RuntimeVersion;
  readonly runtimeStatus?: RuntimeStatus;
  readonly statusPhotoStorage?: StatusPhotoStorage;
  readonly statusMonitorStorage?: StatusMonitorStorage;
  readonly statusMonitorRedisClients?: (signal: AbortSignal) => Promise<number | undefined>;
  readonly signal?: AbortSignal;
}) {
  const photos = createStatusPhotoLedger(statusPhotoStorage, signal);
  const monitor = signal ? readStatusConfig().then(config =>
    createStatusMonitor(statusMonitorSettings(config), {
      storage: statusMonitorStorage, signal,
      readRedisClients: config?.showRedisInfo !== false && statusMonitorRedisClients ? () => statusMonitorRedisClients(signal) : undefined,
    })) : undefined;
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
      $t("index.text_c151a6d094"),
      ...(accountRows.length ? accountRows : [$t("index.text_8efa8cd3f5")]),
      "",
      $t("index.text_83015f8861"),
      ...(pluginRows.length ? pluginRows : [$t("index.text_24036f3fd3")]),
    ].join("\n");
  }

  let rendering = false;
  async function statusCard(context: DiagnosticsContext, pro: boolean, fallback: () => string, config?: Record<string, unknown>) {
    const { message_type, isMaster, self_id, user_id, runtimeDiagnosticsScope } = context;
    const ownerTerminal = message_type === "terminal" && isMaster === true;
    const ownerPrivate = message_type === "private" &&
      typeof self_id === "number" && Number.isSafeInteger(self_id) && self_id > 0 &&
      typeof user_id === "number" && Number.isSafeInteger(user_id) && user_id > 0 &&
      (isMaster === true || runtimeDiagnosticsScope === "milky");
    if (pro && !ownerTerminal && !ownerPrivate) {
      return $t("index.text_b2bbf4f815");
    }
    if (context.privateCredentialSignal?.aborted || signal?.aborted || context.isDelegated) return;
    if (rendering) return fallback();
    rendering = true;
    try {
      const settings = config ?? await readStatusConfig();
      const theme = await loadStatusCardTheme(undefined, settings);
      if (!theme && !pro) return fallback();
      const snapshot = await Promise.resolve().then(() => runtimeStatus?.(context, pro)).catch(() => undefined);
      if (!snapshot) return pro ? $t("index.text_61017dad72") : fallback();
      if (!theme) return fallback();
      if (context.privateCredentialSignal?.aborted || signal?.aborted) return;
      const history = pro || statusSettingsRecord(settings?.chartsCfg)?.show === true
        ? await (await monitor)?.snapshot() : undefined;
      const sessionSignal = context.privateCredentialSignal;
      const diagnosticSignal = signal && sessionSignal ? AbortSignal.any([signal, sessionSignal]) : signal ?? sessionSignal;
      const model = await collectStatusCard(snapshot, pro, settings, history?.samples, diagnosticSignal);
      if (context.privateCredentialSignal?.aborted || signal?.aborted) return;
      const result = await renderStatusCard(model, theme, context.inlineImageByteLimit);
      if (context.privateCredentialSignal?.aborted || signal?.aborted) return;
      console.log($t("index.text_1796c1cb68", { "renderer": result.engine.renderer, "api": result.engine.api, "device": result.engine.device }));
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

  function status(args = "", context?: DiagnosticsContext, config?: Record<string, unknown>) {
    if (messageStatistics && context && /^(?:机器人|用户|群|消息|日期)(?:\s|$)/u.test(args)) {
      return messageStatistics(args, context);
    }
    const summary = $t("index.text_907d967137", { "version": Bun.version });
    if (args.trim()) return summary;
    const fallback = () => withRuntime(summary, context);
    return runtimeStatus && context && context.message_type !== "terminal" ? statusCard(context, false, fallback, config) : fallback();
  }

  function renderProStatus(config: Record<string, unknown>, context?: DiagnosticsContext) {
    if (!context) return $t("index.text_61017dad72");
    return statusCard(context, true, () => withRuntime(diagnostics(), context), config);
  }

  async function proStatus(args = "", context?: DiagnosticsContext) {
    const config = await readStatusConfig();
    if (!config || config.noPro === true) return;
    if (args.trim()) return $t("index.text_f07d382151");
    return renderProStatus(config, context);
  }

  async function statusMonitor(args = "", context?: DiagnosticsContext) {
    if (args.trim()) return $t("index.text_19c83583f3");
    const snapshot = await (await monitor)?.snapshot();
    const samples = snapshot?.samples ?? [];
    const enabled = snapshot?.enabled;
    const fallback = () => statusMonitorText(samples, enabled);
    if (!samples.length || !context || context.message_type === "terminal" || rendering) return fallback();
    rendering = true;
    try {
      const theme = await loadStatusCardTheme();
      if (!theme || signal?.aborted) return fallback();
      const result = await renderStatusMonitor(samples, enabled);
      console.log($t("index.text_2073812db6", { "renderer": result.engine.renderer, "api": result.engine.api, "device": result.engine.device }));
      return { type: "image" as const, file: result.png };
    } catch {
      return fallback();
    } finally {
      rendering = false;
    }
  }

  async function versionCard() {
    try {
      const themeDirectory = await loadVersionCardTheme();
      if (!themeDirectory) return versionSummary(runtimeVersion);
      const result = await renderVersionCard(versionCardSections(runtimeVersion), themeDirectory);
      console.log($t("index.text_d98ab1905a", { "renderer": result.engine.renderer, "api": result.engine.api, "device": result.engine.device }));
      return { type: "image" as const, file: result.png };
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

  async function fallback(message: string, context: OriginalPhotoContext & { readonly normalizedMessage?: string }) {
    const input = message.trim();
    if (isSystemHelpAlias(context.normalizedMessage ?? input)) return helpUrl;
    if (/^状态(?:[Pp]ro)?$/u.test(input)) {
      const config = await readStatusConfig();
      if (config?.defaultState !== true) return;
      if (input === "状态") return status("", context, config);
      if (config.noPro === true) return;
      return renderProStatus(config, context);
    }
    return originalPhoto(input, context);
  }

  return {
    dispose: async () => (await monitor)?.dispose(),
    fallback,
    fallbackFeatures: ({ normalizedMessage }: { readonly normalizedMessage: string }) =>
      isSystemHelpAlias(normalizedMessage) ? [] : [$t("index.text_d8679affb4")],
    aliases: {
      "#状态pro": "#状态Pro",
      "#help": "#帮助",
      "#星铁帮助": "#帮助",
      "#星铁help": "#帮助",
      "#绝区零帮助": "#帮助",
      "#绝区零help": "#帮助",
      "#自动签到帮助": "#帮助",
    },
    commands: {
      "#状态": status,
      "#状态Pro": proStatus,
      "#监控": statusMonitor,
      "#统计": messageStatistics ?? (() => $t("index.text_12ead09c08")),
      "#版本": (_args = "", context?: StatisticsContext) =>
        runtimeVersion && context && context.message_type !== "terminal" ? versionCard() : versionSummary(runtimeVersion),
      "#帮助": () => $t("index.text_47ea7e256d", { "helpUrl": helpUrl }),
      "#诊断": (args = "", context?: DiagnosticsContext) => {
        const summary = diagnostics();
        return args.trim() && context?.isMaster !== true ? summary : withRuntime(summary, context);
      },
    },
  };
}

export default createModule({});
