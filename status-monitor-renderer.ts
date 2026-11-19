import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { renderPng } from "@lotus-yunzai/skia";
import type { CanvasRenderingContext2D as Context, Image } from "skia-canvas";
import { loadCardFont } from "./local-card-assets.ts";
import { loadStatusBackground, readStatusBackground } from "./status-background.ts";
import { background, glass, statusCardThemeDirectory } from "./status-card-renderer.ts";
import type { StatusMonitorSample } from "./status-monitor.ts";

// Geometry follows Yenai-Plugin fe42a6f, resources/state/monitor.html and css/index.css.
const width = 650;
const height = 846;
const scale = 1.4;
const lineColor = "#2ec7c9";
const originalFont = '"Noto Sans CJK SC", sans-serif';
const GiB = 1024 ** 3;
const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

interface MonitorTheme {
  readonly background: Image;
  readonly body: string;
  readonly title: string;
}

export async function loadStatusMonitorTheme(directory = statusCardThemeDirectory()): Promise<MonitorTheme | undefined> {
  const root = await realpath(directory).catch(() => undefined);
  const selected = await readStatusBackground();
  if (!root || !selected) return;
  for (const resources of [root, join(root, "resources")]) {
    const photo = await loadStatusBackground(resources, selected);
    if (!photo) continue;
    const [body, title] = await Promise.all([
      loadCardFont(resources, "common/font/FZB.ttf"),
      loadCardFont(resources, "common/font/NZBZ.ttf"),
    ]);
    return {
      background: photo.image,
      body: body ? `"${body}", ${originalFont}` : originalFont,
      title: title ? `"${title}", ${originalFont}` : originalFont,
    };
  }
}

function bytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let index = 0;
  while (index < units.length - 1 && value >= 1024) {
    index++;
    value /= 1024;
  }
  return value.toFixed(1) + units[index];
}

export function statusMonitorText(samples: readonly StatusMonitorSample[], enabled = true) {
  const latestCpu = samples.findLast(row => row.cpu !== undefined)?.cpu;
  const latestRam = samples.findLast(row => row.ram !== undefined)?.ram;
  return [
    "Lotus-Yunzai 监控",
    ...(samples.length ? [
      `有效采样　${samples.length} 次`,
      `CPU　${latestCpu === undefined ? "暂无采样" : latestCpu.toFixed(1) + "%"}`,
      `RAM　${latestRam === undefined ? "暂无采样" : bytes(latestRam)}`,
    ] : enabled ? ["等待首次采样。"] : []),
    ...(!enabled ? ["当前已关闭持续采样。"] : []),
  ].join("\n");
}

interface Point { readonly x: number; readonly y: number; readonly value: number }

function trace(ctx: Context, points: readonly Point[]) {
  const slopes = points.slice(1).map(({ x, y }, index) => {
    const before = points[index]!;
    return (y - before.y) / (x - before.x);
  });
  const tangents = points.map((_, index) => {
    const before = slopes[index - 1];
    const after = slopes[index];
    if (before === undefined) return after ?? 0;
    if (after === undefined) return before;
    return before * after > 0 ? 2 * before * after / (before + after) : 0;
  });
  const first = points[0]!;
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1]!;
    const after = points[i]!;
    const offset = (after.x - before.x) / 3;
    ctx.bezierCurveTo(before.x + offset, before.y + tangents[i - 1]! * offset,
      after.x - offset, after.y - tangents[i]! * offset, after.x, after.y);
  }
}

function horizontalScale(ctx: Context, first: number, span: number, x: number, bottom: number, size: number) {
  ctx.textAlign = "center";
  const period = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000]
    .find(interval => interval >= span / 8) ?? 7_200_000;
  const end = first + span;
  const severalDays = day.format(first) !== day.format(end);
  for (let tick = Math.ceil(first / period) * period; tick <= end; tick += period) {
    const labelX = x + (tick - first) / span * size;
    if (labelX < x + 18 || labelX > x + size - 18) continue;
    ctx.beginPath();
    ctx.moveTo(labelX, bottom);
    ctx.lineTo(labelX, bottom + 4);
    ctx.stroke();
    ctx.fillText(severalDays ? `${day.format(tick)} ${time.format(tick)}` : time.format(tick), labelX, bottom + 19);
  }
}

function chart(ctx: Context, theme: MonitorTheme, samples: readonly StatusMonitorSample[], key: "cpu" | "ram", y: number) {
  glass(ctx, theme, height, 25, y, 600, 322, width);
  ctx.fillStyle = "#444";
  ctx.font = `bold 20px ${theme.body}`;
  ctx.fillText(key.toUpperCase(), 41, y + 33);
  const readings = samples.flatMap(sample => {
    const value = sample[key];
    return value === undefined ? [] : [{ at: sample.at, value }];
  });
  ctx.font = `12px ${theme.body}`;
  if (!readings.length) {
    ctx.textAlign = "center";
    ctx.fillText("暂无采样", width / 2, y + 160);
    ctx.textAlign = "left";
    return;
  }
  const max = Math.max(...readings.map(({ value }) => value));
  const maxScale = key === "cpu" ? Math.max(10, Math.ceil(max / 10) * 10) :
    max >= GiB ? Math.ceil(max / (GiB / 2)) * GiB / 2 : Math.max(1, max);
  const division = key === "cpu" ? maxScale / 10 : 4;
  const format = key === "cpu" ? (value: number) => value.toFixed(1) + "%" : bytes;
  const left = 84;
  const right = 585;
  const top = y + 71;
  const bottom = y + 291;
  const first = readings[0]!.at;
  const span = readings.at(-1)!.at - first;
  const points = readings.map(({ at, value }): Point => ({
    x: span ? left + (at - first) / span * (right - left) : (left + right) / 2,
    y: bottom - value / maxScale * (bottom - top),
    value,
  }));

  ctx.fillStyle = "#696f79";
  ctx.textAlign = "right";
  ctx.lineWidth = 1;
  for (let i = 0; i <= division; i++) {
    const tickY = bottom - (bottom - top) * i / division;
    ctx.strokeStyle = i ? "#dbe2ee" : "#777c87";
    ctx.beginPath();
    ctx.moveTo(left, tickY);
    ctx.lineTo(right, tickY);
    ctx.stroke();
    ctx.fillText(format(maxScale * i / division), left - 8, tickY + 5);
  }
  ctx.textAlign = "center";
  if (span) horizontalScale(ctx, first, span, left, bottom, right - left);
  else ctx.fillText(time.format(first), points[0]!.x, bottom + 19);

  if (points.length > 1) {
    ctx.beginPath();
    trace(ctx, points);
    ctx.lineTo(points.at(-1)!.x, bottom);
    ctx.lineTo(points[0]!.x, bottom);
    ctx.closePath();
    ctx.fillStyle = "rgba(46,199,201,0.72)";
    ctx.fill();
    ctx.beginPath();
    trace(ctx, points);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (points.length < 85) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = lineColor;
    ctx.fillStyle = "#fff";
    for (const { x, y } of points) {
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  const peak = points.reduce((highest, next) => next.value > highest.value ? next : highest);
  const peakLabel = format(peak.value);
  const marker = Math.max(15, ctx.measureText(peakLabel).width / 2 + 1);
  const center = peak.y - 27;
  ctx.beginPath();
  ctx.moveTo(peak.x - marker * .68, center + 11);
  ctx.lineTo(peak.x, peak.y - 4);
  ctx.lineTo(peak.x + marker * .68, center + 11);
  ctx.closePath();
  ctx.fillStyle = lineColor;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(peak.x, center, marker, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#242c36";
  ctx.fillText(peakLabel, peak.x, center + 4);
  ctx.textAlign = "left";
}

export function renderStatusMonitor(samples: readonly StatusMonitorSample[], theme: MonitorTheme, enabled = true) {
  return renderPng(Math.round(width * scale), Math.round(height * scale), ctx => {
    ctx.scale(scale, scale);
    background(ctx, theme, height, width);
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.shadowOffsetX = 1;
    ctx.shadowColor = "#000";
    ctx.fillStyle = "#fff";
    ctx.font = `36px ${theme.title}`;
    ctx.fillText("Lotus-Yunzai 监控", 35, 58);
    ctx.font = `16px ${theme.body}`;
    ctx.fillText(enabled ? "CPU & RAM" : "CPU & RAM　采样已暂停", 35, 87);
    ctx.shadowColor = "transparent";

    chart(ctx, theme, samples, "cpu", 122);
    chart(ctx, theme, samples, "ram", 464);
    ctx.textAlign = "center";
    ctx.font = `14px ${theme.body}`;
    ctx.shadowColor = "#000";
    ctx.fillStyle = "#fff";
    ctx.fillText("Created By Lotus-Yunzai", width / 2 + 5, 822);
  }, "gpu");
}
