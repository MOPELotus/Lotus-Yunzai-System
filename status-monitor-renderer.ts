import { drawInfoText, infoCardColors, renderInfoCard } from "@lotus-yunzai/skia/info-card";
import type { CanvasRenderingContext2D as Context } from "skia-canvas";
import type { StatusMonitorSample } from "./status-monitor.ts";

const width = 650;
const lineColor = "#2ec7c9";
const secondaryColor = "#b6a2de";
const chartFont = '"Noto Sans CJK SC", sans-serif';
const GiB = 1024 ** 3;
const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const second = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

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
  const latest = samples.at(-1);
  const formatRate = (value: number) => bytes(value) + "/s";
  const throughput = (key: "network" | "disk", first: string, second: string) => {
    const rates = latest?.[key];
    if (rates) return `${first} ${formatRate(rates[0])}　${second} ${formatRate(rates[1])}`;
    return samples.some(row => row[key]) ? "最近一次采样无有效数据" : "暂无可核验采样";
  };
  return [
    "Lotus-Yunzai 监控",
    ...(samples.length ? [
      `有效采样　${samples.length} 次`,
      `CPU　${latestCpu === undefined ? "暂无采样" : latestCpu.toFixed(1) + "%"}`,
      `RAM　${latestRam === undefined ? "暂无采样" : bytes(latestRam)}`,
      `网络　${throughput("network", "上行", "下行")}`,
      `磁盘　${throughput("disk", "读", "写")}`,
    ] : enabled ? ["等待首次采样。"] : []),
    ...(!enabled ? ["当前已关闭持续采样。"] : []),
  ].join("\n");
}

interface Point { readonly x: number; readonly y: number; readonly value: number }
interface Reading { readonly at: number; readonly value: number }
interface Series {
  readonly color: string;
  readonly area: string;
  readonly label?: string;
  readonly segments: readonly (readonly Reading[])[];
}
interface Peak {
  readonly point: Point;
  readonly color: string;
  readonly label: string;
  readonly radius: number;
  readonly padding: number;
  x: number;
}

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
  ctx.strokeStyle = "#777c87";
  const withSeconds = span < 120_000;
  const period = (withSeconds ? [1_000, 2_000, 5_000, 10_000, 15_000] :
    [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000])
    .find(interval => interval >= span / 8) ?? 7_200_000;
  const end = first + span;
  const severalDays = !withSeconds && day.format(first) !== day.format(end);
  const format = withSeconds ? second : time;
  let shown = 0;
  for (let tick = Math.ceil(first / period) * period; tick <= end; tick += period) {
    const labelX = x + (tick - first) / span * size;
    if (labelX < x + 18 || labelX > x + size - 18) continue;
    ctx.beginPath();
    ctx.moveTo(labelX, bottom);
    ctx.lineTo(labelX, bottom + 4);
    ctx.stroke();
    ctx.fillText(severalDays ? `${day.format(tick)} ${format.format(tick)}` : format.format(tick), labelX, bottom + 19);
    shown++;
  }
  if (!shown) {
    const startLabel = format.format(first);
    const endLabel = format.format(end);
    if (startLabel === endLabel) {
      ctx.fillText(startLabel, x + size / 2, bottom + 19);
    } else {
      ctx.fillText(startLabel, x + 18, bottom + 19);
      ctx.fillText(endLabel, x + size - 18, bottom + 19);
    }
  }
}

function chart(ctx: Context, samples: readonly StatusMonitorSample[],
  key: "cpu" | "ram" | "network" | "disk", y: number) {
  const io = key === "network" || key === "disk";
  ctx.fillStyle = infoCardColors.tile;
  ctx.beginPath();
  ctx.roundRect(25, y, width - 60, 322, 12);
  ctx.fill();
  drawInfoText(ctx, [key === "network" ? "网络吞吐" : key === "disk" ? "磁盘 I/O" : key.toUpperCase()],
    41, y + 11, { size: 20, color: infoCardColors.gold });
  ctx.font = `12px ${chartFont}`;
  ctx.textBaseline = "alphabetic";

  const colors = [lineColor, secondaryColor];
  const areas = ["rgba(46,199,201,0.72)", "rgba(182,162,222,0.68)"];
  const labels = key === "network" ? ["上行", "下行"] : key === "disk" ? ["读", "写"] : [];
  const series: Series[] = [];
  for (let index = 0; index < (io ? 2 : 1); index++) {
    const segments: Reading[][] = [];
    let current: Reading[] | undefined;
    for (const sample of samples) {
      const value = io ? sample[key]?.[index] : sample[key];
      if (value === undefined) {
        if (io) current = undefined;
        continue;
      }
      if (!current) segments.push(current = []);
      current.push({ at: sample.at, value });
    }
    series.push({ color: colors[index]!, area: areas[index]!, label: labels[index], segments });
  }
  if (io) {
    drawRateLegend(ctx, series, y);
    if (samples.some(row => row[key]) && !samples.at(-1)?.[key]) {
      ctx.fillStyle = infoCardColors.muted;
      ctx.textAlign = "right";
      ctx.fillText("最近采样缺失", 585, y + 28);
      ctx.textAlign = "left";
    }
  }
  const readings = series.flatMap(item => item.segments.flat());
  if (!readings.length) {
    ctx.textAlign = "center";
    ctx.fillStyle = infoCardColors.muted;
    ctx.fillText(io ? "暂无可核验的吞吐采样" : "暂无采样", width / 2, y + 160);
    ctx.textAlign = "left";
    return;
  }
  const max = Math.max(...readings.map(({ value }) => value));
  const rateStep = Math.max(1, 10 ** Math.floor(Math.log10(Math.max(1, max) / 5)));
  const maxScale = key === "cpu" ? Math.max(10, Math.ceil(max / 10) * 10) : io ?
    rateStep * Math.max(5, Math.ceil(max / rateStep)) :
    max >= GiB ? Math.ceil(max / (GiB / 2)) * GiB / 2 : Math.max(1, max);
  const division = key === "cpu" ? maxScale / 10 : io ? 5 : 4;
  const format = key === "cpu" ? (value: number) => value.toFixed(1) + "%" :
    io ? (value: number) => bytes(value) + "/s" : bytes;
  const left = io ? 111 : 84;
  const right = 585;
  const top = y + 71;
  const bottom = y + 291;
  const first = Math.min(...readings.map(({ at }) => at));
  const span = Math.max(...readings.map(({ at }) => at)) - first;
  const plot = ({ at, value }: Reading): Point => ({
    x: span ? left + (at - first) / span * (right - left) : (left + right) / 2,
    y: bottom - value / maxScale * (bottom - top),
    value,
  });

  ctx.fillStyle = infoCardColors.muted;
  ctx.textAlign = "right";
  ctx.lineWidth = 1;
  for (let i = 0; i <= division; i++) {
    const tickY = bottom - (bottom - top) * i / division;
    ctx.strokeStyle = i ? "rgba(211,188,142,.18)" : infoCardColors.rule;
    ctx.beginPath();
    ctx.moveTo(left, tickY);
    ctx.lineTo(right, tickY);
    ctx.stroke();
    ctx.fillText(format(maxScale * i / division), left - 8, tickY + 5);
  }
  ctx.textAlign = "center";
  if (span) horizontalScale(ctx, first, span, left, bottom, right - left);
  else ctx.fillText(second.format(first), (left + right) / 2, bottom + 19);

  const peaks: Peak[] = [];
  for (const item of series) {
    const groups = item.segments.map(segment => segment.map(plot));
    for (const points of groups) drawRateLine(ctx, points, item, bottom, !io);
    const points = groups.flat();
    if (!points.length) continue;
    const point = points.reduce((highest, next) => next.value > highest.value ? next : highest);
    const label = format(point.value);
    const halfText = ctx.measureText(label).width / 2 + 1;
    const radius = io ? 17 : Math.max(15, halfText);
    const padding = Math.max(radius, halfText);
    const minX = (io ? left : point.y - 27 - radius < y + 37 ? 86 : 49) + padding;
    const x = Math.max(minX, Math.min(607 - padding, point.x));
    peaks.push({ point, color: item.color, label, radius, padding, x });
  }
  if (peaks.length === 2) {
    const [first, second] = peaks.toSorted((a, b) => a.x - b.x) as [Peak, Peak];
    const spacing = first.padding + second.padding + 6;
    if (second.x - first.x < spacing && Math.abs(first.point.y - second.point.y) < 35) {
      const center = (first.x + second.x) / 2;
      first.x = Math.max(left + first.padding, Math.min(607 - second.padding - spacing, center - spacing / 2));
      second.x = first.x + spacing;
    }
  }
  for (const peak of peaks) drawPeak(ctx, peak);
  ctx.textAlign = "left";
}

function drawRateLegend(ctx: Context, series: readonly Series[], y: number) {
  const legendStart = width / 2 - 56;
  for (const [index, item] of series.entries()) {
    const x = legendStart + 64 * index;
    const cy = y + 22;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 12, cy);
    ctx.lineTo(x + 12, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, cy, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = infoCardColors.muted;
    ctx.fillText(item.label!, x + 18, cy + 5);
  }
}

function drawRateLine(ctx: Context, points: readonly Point[], series: Series, bottom: number, symbols: boolean) {
  if (points.length > 1) {
    ctx.beginPath();
    trace(ctx, points);
    ctx.lineTo(points.at(-1)!.x, bottom);
    ctx.lineTo(points[0]!.x, bottom);
    ctx.closePath();
    ctx.fillStyle = series.area;
    ctx.fill();
    ctx.beginPath();
    trace(ctx, points);
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (points.length === 1 || symbols && points.length < 85) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = series.color;
    ctx.fillStyle = "#fff";
    for (const { x, y } of points) {
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

}

function drawPeak(ctx: Context, { point, label, color, radius: marker, x: markerX }: Peak) {
  const center = point.y - 27;
  ctx.beginPath();
  ctx.moveTo(markerX - marker * .68, center + 11);
  ctx.lineTo(point.x, point.y - 4);
  ctx.lineTo(markerX + marker * .68, center + 11);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(markerX, center, marker, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#242c36";
  ctx.fillText(label, markerX, center + 4);
}

export function renderStatusMonitor(samples: readonly StatusMonitorSample[], enabled = true) {
  const metadata = enabled ? `CPU · 内存 · 网络 · 磁盘 / ${samples.length} 次采样`
    : `采样已暂停 · ${samples.length} 条历史记录`;
  return renderInfoCard({ title: "运行监控", metadata, width }, ({ x, y }) => ({
    height: 4 * 342 - 20,
    draw(ctx) {
      ctx.save();
      ctx.translate(x - 25, 0);
      for (const [index, key] of (["cpu", "ram", "network", "disk"] as const).entries()) {
        chart(ctx, samples, key, y + 342 * index);
      }
      ctx.restore();
    },
  }), { mode: "gpu" });
}
