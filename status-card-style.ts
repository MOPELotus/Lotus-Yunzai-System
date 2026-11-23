export function statusSettingsRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

const colorNumber = String.raw`[+\-]?(?:\d{1,5}(?:\.\d+)?|\.\d+)%?`;
const rgbColor = new RegExp(`^(?:rgb|hsl)\\(\\s*${colorNumber}\\s*,\\s*${colorNumber}\\s*,\\s*${colorNumber}\\s*\\)$`, "iu");
const rgbaColor = new RegExp(`^(?:rgba|hsla)\\(\\s*${colorNumber}\\s*,\\s*${colorNumber}\\s*,\\s*${colorNumber}\\s*,\\s*${colorNumber}\\s*\\)$`, "iu");

function color(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80) return;
  const candidate = value.trim();
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu.test(candidate) ||
      rgbColor.test(candidate) || rgbaColor.test(candidate) ||
      /^(?:black|white|red|green|blue|purple|orange|yellow|pink|gray|grey|cyan|lime|gold|transparent)$/iu.test(candidate)) return candidate;
}

function colors(value: unknown, defaults: readonly string[]) {
  const entries = Array.isArray(value) ? value.slice(0, 12).flatMap(item => color(item) ?? []) : [color(value)].filter(value => value !== undefined);
  return entries.length ? entries : defaults;
}

interface Gradient {
  readonly angle: number;
  readonly stops: readonly { readonly color: string; readonly position: number }[];
}

export function parseStatusGradient(value: unknown): Gradient | undefined {
  if (typeof value !== "string" || value.length > 1024) return;
  const source = /^gradient:\s*([+\-]?\d{1,4}(?:\.\d{1,4})?)deg\s*,\s*(.+)$/iu.exec(value);
  if (!source) return;
  const segments = source[2]!.split(/,(?![^(]*\))/u);
  if (segments.length < 2 || segments.length > 12) return;
  const stops: Gradient["stops"][number][] = [];
  for (const [index, item] of segments.entries()) {
    const match = /^(.+?)(?:\s+(\d{1,3}(?:\.\d{1,4})?)%)?$/u.exec(item.trim());
    const fill = color(match?.[1]);
    const position = match?.[2] === undefined ? index / (segments.length - 1) : Number(match[2]) / 100;
    if (!fill || position > 1 || (stops.at(-1)?.position ?? 0) > position) return;
    stops.push({ color: fill, position });
  }
  return { angle: Number(source[1]), stops };
}

export function statusCardStyle(config?: Record<string, unknown>) {
  const style = statusSettingsRecord(config?.style);
  const progress = statusSettingsRecord(style?.progressBarColor);
  const badges = statusSettingsRecord(style?.botInfoColor);
  const charts = statusSettingsRecord(config?.chartsCfg);
  return {
    startColumn: style?.startColumn !== false,
    nameColor: color(style?.BotNameColor) ?? "#000",
    nameGradient: parseStatusGradient(style?.BotNameColor),
    progressHigh: color(progress?.high) ?? "#d73403",
    progressMedium: color(progress?.medium) ?? "#ffa500",
    progressLow: colors(progress?.low, ["#84A0DF", "#2EC272", "#8070F9"]),
    redisValueColor: color(style?.redisInfoValColor) ?? "#485ab6",
    botVersionColor: color(badges?.botVersion) ?? "#FBE0F3",
    botPlatformColor: color(badges?.platform) ?? "#F0EDF2",
    botUptimeColor: color(badges?.botRunTime) ?? "#F1EBFA",
    contactColors: colors(badges?.contacts, ["#F1EDFE", "#FDF1E6", "#E9F4FC"]),
    chartColors: colors(charts?.color, ["#2ec7c9", "#b6a2de"]),
  };
}
