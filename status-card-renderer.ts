import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeImageRasterScale, renderPng } from "@lotus-yunzai/skia";
import { Canvas, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { loadCardFont, loadCardImage } from "./local-card-assets.ts";
import { loadStatusBackground, readStatusConfig, statusBackdrop, type StatusPhoto } from "./status-background.ts";
import type { RuntimeStatusAccount, StatusCardModel, StatusResource } from "./status-card-data.ts";
import type { StatusDetailSection } from "./status-card-details.ts";
import { statusCardStyle } from "./status-card-style.ts";

// Layout and local asset paths follow Yenai-Plugin fe42a6f, resources/state/index.html and css/index.css.
const defaultDirectory = fileURLToPath(new URL("./assets/status-card/", import.meta.url));
const logicalWidth = 750;
const scale = 4;
// Skia filters and shadow distances use device pixels. Keep their former logical sizes.
const effectScale = scale / 1.4;
const icons = [
  "11", "机器人", "platform", "时间", "friend", "group", "groupMember", "sent", "recv", "screenshot",
  "系统", "主机名", "time", "插件", "资源", "磁盘", "网络", "redis", "进程负载",
] as const;
type Icon = typeof icons[number];
interface Theme {
  readonly background: Image;
  readonly photo: StatusPhoto;
  readonly avatar?: Image;
  readonly online?: Image;
  readonly icons: ReadonlyMap<Icon, Image>;
  readonly font: string;
  readonly style: ReturnType<typeof statusCardStyle>;
}

export function statusCardThemeDirectory() {
  return process.env.LOTUS_SYSTEM_STATUS_THEME_DIR || defaultDirectory;
}

export async function loadStatusCardTheme(directory = statusCardThemeDirectory(), config?: Record<string, unknown>): Promise<Theme | undefined> {
  const root = await realpath(directory).catch(() => undefined);
  if (!root) return;
  config ??= await readStatusConfig();
  const choice = statusBackdrop(config);
  if (!choice) return;
  for (const theme of [root, join(root, "resources")]) {
    const background = await loadStatusBackground(theme, choice);
    if (!background) continue;
    const [avatar, font, entries] = await Promise.all([
      loadCardImage(theme, "state/img/default_avatar.jpg").catch(() => undefined),
      loadCardFont(theme, "common/font/FZB.ttf").catch(() => undefined),
      Promise.all(icons.map(async icon => [icon,
        await loadCardImage(theme, `state/icon/${icon}.png`).catch(() => undefined)] as const)),
    ]);
    const family = font ? `"${font}", "Noto Sans CJK SC", sans-serif` : '"PingFang SC", "Noto Sans CJK SC", sans-serif';
    return { background: background.image, photo: background.photo, avatar, font: family, style: statusCardStyle(config),
      online: entries.find(([name]) => name === "11")?.[1],
      icons: new Map(entries.filter((entry): entry is readonly [Icon, Image] => entry[1] !== undefined)) };
  }
}

function font(ctx: Context, theme: Theme, size: number, weight = 400) {
  ctx.font = `${weight} ${size}px ${theme.font}`;
}

function text(ctx: Context, value: string, x: number, y: number, width?: number, bold = false) {
  if (width !== undefined && ctx.measureText(value).width > width) {
    const separator = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let shortened = "";
    for (const { segment } of separator.segment(value)) {
      if (ctx.measureText(shortened + segment + "…").width > width) break;
      shortened += segment;
    }
    value = shortened + "…";
  }
  ctx.fillText(value, x, y);
  if (bold) {
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 0.50;
    ctx.strokeText(value, x, y);
    ctx.restore();
  }
}

function duration(seconds: number) {
  const elapsed = Math.floor(Math.max(0, seconds));
  const part = (n: number) => String(n).padStart(2, "0");
  return `${part(Math.floor(elapsed / 86400))}天 ${part(Math.floor(elapsed / 3600) % 24)}:${part(Math.floor(elapsed / 60) % 60)}:${part(elapsed % 60)}`;
}

function icon(ctx: Context, theme: Theme, name: Icon, x: number, y: number, size: number) {
  const image = theme.icons.get(name);
  if (image) ctx.drawImage(image, x, y, size, size);
}

function rounded(ctx: Context, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function background(ctx: Context, theme: Pick<Theme, "background">, height: number, pageWidth = logicalWidth, offset = 0) {
  const ratio = Math.max(pageWidth / theme.background.width, height / theme.background.height);
  const width = theme.background.width * ratio;
  ctx.drawImage(theme.background, (pageWidth - width) / 2 - offset, 0, width, theme.background.height * ratio);
}

type DrawTheme = Theme & { readonly columnWidth: number; readonly pageWidth: number; readonly left: number };

function glass(ctx: Context, theme: DrawTheme, height: number,
  x: number, y: number, width: number, boxHeight: number) {
  ctx.save();
  rounded(ctx, x, y, width, boxHeight, 18);
  ctx.shadowOffsetY = 8 * effectScale;
  ctx.shadowBlur = 32 * effectScale;
  ctx.shadowColor = "rgba(51,51,52,0.50)";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fill();
  ctx.restore();

  ctx.save();
  rounded(ctx, x, y, width, boxHeight, 18);
  ctx.clip();
  ctx.filter = `blur(${14 * effectScale}px)`;
  background(ctx, theme, height, theme.pageWidth, theme.left);
  ctx.filter = "none";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fillRect(x, y, width, boxHeight);
  const highlight = ctx.createLinearGradient(x, y, x + width, y + boxHeight);
  highlight.addColorStop(0, "rgba(255,255,255,0.26)");
  highlight.addColorStop(0.32, "rgba(255,255,255,0.05)");
  highlight.addColorStop(1, "rgba(255,255,255,0.15)");
  ctx.fillStyle = highlight;
  ctx.fillRect(x, y, width, boxHeight);
  ctx.strokeStyle = "rgba(255,255,255,0.40)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

interface Badge {
  readonly label: string;
  readonly suffix?: string;
  readonly icon: Icon;
  readonly color: string;
}
function badgeRows(ctx: Context, theme: Theme, account: RuntimeStatusAccount) {
  const { botVersionColor, botPlatformColor, botUptimeColor, contactColors } = theme.style;
  const version: Badge[] = [
    { label: "Lotus-Yunzai", icon: "机器人", color: botVersionColor },
    { label: account.adapter === "milky" ? "Milky v1" : "OneBot v11", icon: "platform", color: botPlatformColor },
    { label: `Bot已运行 ${duration(account.seconds)}`, icon: "时间", color: botUptimeColor },
  ];
  const contact: Badge[] = [];
  const stats = [
    [account.friends, "好友", "friend"], [account.groups, "群组", "group"], [account.members, "群员", "groupMember"],
    [account.sent, "发", "sent"], [account.received, "收", "recv"], [account.images, "图片", "screenshot"],
  ] as const;
  for (const [value, suffix, name] of stats) {
    if (value === undefined || value === 0 || value === "0") continue;
    contact.push({ label: String(value), suffix, icon: name, color: contactColors[contact.length % contactColors.length]! });
  }

  const rows: { x: number; y: number; width: number; badge: Badge }[] = [];
  let y = 0;
  for (const group of [version, contact]) {
    let x = 0;
    for (const badge of group) {
      font(ctx, theme, 14);
      const labelWidth = ctx.measureText(badge.label).width;
      font(ctx, theme, 12);
      const width = Math.ceil(36 + labelWidth + (badge.suffix ? ctx.measureText(badge.suffix).width : 0));
      if (x + width > 508) { x = 0; y += 30; }
      rows.push({ x, y, width, badge });
      x += width + 7;
    }
    if (group.length) y += 30;
  }
  return { rows, height: Math.max(138, 84 + y) };
}

function drawBadge(ctx: Context, theme: Theme, badge: Badge, x: number, y: number, width: number) {
  ctx.save();
  rounded(ctx, x, y, width, 20, 6);
  ctx.fillStyle = badge.color;
  ctx.shadowOffsetX = -2 * effectScale;
  ctx.shadowOffsetY = 2 * effectScale;
  ctx.shadowBlur = 3 * effectScale;
  ctx.shadowColor = "rgba(8,8,8,0.50)";
  ctx.fill();
  ctx.restore();
  icon(ctx, theme, badge.icon, x + 8, y + 3, 14);
  font(ctx, theme, 14);
  ctx.fillStyle = "#000";
  text(ctx, badge.label, x + 25, y + 15);
  if (badge.suffix) {
    const labelWidth = ctx.measureText(badge.label).width;
    font(ctx, theme, 12);
    ctx.fillStyle = "#171717";
    text(ctx, badge.suffix, x + 29 + labelWidth, y + 15);
  }
}

function drawAccount(ctx: Context, theme: DrawTheme, height: number, account: RuntimeStatusAccount,
  layout: ReturnType<typeof badgeRows>, y: number) {
  glass(ctx, theme, height, 25, y, theme.columnWidth - 50, layout.height);
  const avatarY = y + (layout.height - 100) / 2;
  for (const [x, offset, tint] of [[56, 5, "102,190,240"], [150, 5, "255,100,100"],
    [105, 0, "255,200,135"], [108, 95, "147,112,190"]] as const) {
    const halo = ctx.createRadialGradient(x, avatarY + offset, 0, x, avatarY + offset, 37);
    halo.addColorStop(0, `rgba(${tint},0.54)`);
    halo.addColorStop(1, `rgba(${tint},0)`);
    ctx.fillStyle = halo;
    ctx.fillRect(x - 37, avatarY + offset - 37, 74, 74);
  }
  ctx.save();
  rounded(ctx, 52, avatarY - 4, 108, 108, 26);
  ctx.shadowOffsetX = -2 * effectScale;
  ctx.shadowOffsetY = 2 * effectScale;
  ctx.shadowBlur = 8 * effectScale;
  ctx.shadowColor = "rgba(8,8,8,0.50)";
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.fill();
  ctx.restore();
  ctx.save();
  rounded(ctx, 56, avatarY, 100, 100, 25);
  ctx.shadowOffsetX = -2 * effectScale;
  ctx.shadowOffsetY = 2 * effectScale;
  ctx.shadowBlur = 12 * effectScale;
  ctx.shadowColor = "rgba(8,8,8,0.55)";
  ctx.fillStyle = "white";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.clip();
  if (theme.avatar) {
    const zoom = 100 / Math.min(theme.avatar.width, theme.avatar.height);
    const width = theme.avatar.width * zoom;
    const height = theme.avatar.height * zoom;
    ctx.drawImage(theme.avatar, 56 + (100 - width) / 2, avatarY + (100 - height) / 2, width, height);
  } else {
    ctx.fillStyle = "#f1edfe";
    ctx.fillRect(56, avatarY, 100, 100);
    font(ctx, theme, 34, 700);
    ctx.fillStyle = "#514f4f";
    ctx.textAlign = "center";
    text(ctx, account.name.trim().at(0)?.toUpperCase() || "?", 106, avatarY + 63);
  }
  ctx.restore();
  if (theme.online) {
    ctx.drawImage(theme.online, 146, avatarY + 86, 20, 20);
  } else {
    circle(ctx, 156, avatarY + 96, 8);
    ctx.fillStyle = "#49d79c";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  font(ctx, theme, 28, 700);
  const { nameColor, nameGradient } = theme.style;
  ctx.fillStyle = nameColor;
  if (nameGradient) {
    const radians = nameGradient.angle * Math.PI / 180;
    const width = Math.min(380, Math.max(1, ctx.measureText(account.name).width));
    const halfX = Math.sin(radians) * width / 2;
    const halfY = -Math.cos(radians) * 14;
    const gradient = ctx.createLinearGradient(186 + width / 2 - halfX, y + 39 - halfY,
      186 + width / 2 + halfX, y + 39 + halfY);
    for (const stop of nameGradient.stops) gradient.addColorStop(stop.position, stop.color);
    ctx.fillStyle = gradient;
  }
  text(ctx, account.name, 186, y + 52, 380, true);
  ctx.strokeStyle = "#c0bfc1";
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(186, y + 65);
  ctx.lineTo(theme.columnWidth - 55, y + 65);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const row of layout.rows) drawBadge(ctx, theme, row.badge, 186 + row.x, y + 75 + row.y, row.width);
}

function drawSystem(ctx: Context, theme: DrawTheme, height: number, model: StatusCardModel, y: number) {
  const items = [
    ["系统", "系统", model.platform, model.runtime],
    ["主机名", "主机名", "隐藏", undefined],
    ["运行时间", "time", duration(model.uptime), undefined],
    ["插件数", "插件", model.pluginCount === undefined ? "—" : `${model.pluginCount} plugins`,
      model.scriptCount === undefined ? undefined : `${model.scriptCount} js`],
  ] as const;
  for (const [index, [label, symbol, value, secondary]] of items.entries()) {
    const step = (theme.columnWidth - 40) / 4;
    const x = 25 + index * step;
    glass(ctx, theme, height, x, y, step - 10, 117);
    icon(ctx, theme, symbol, x + 21, y + 22, 16);
    font(ctx, theme, 14);
    ctx.fillStyle = "#404040";
    text(ctx, label, x + 44, y + 36);
    font(ctx, theme, 16);
    ctx.fillStyle = "#000";
    text(ctx, value, x + 21, y + 65, 126);
    if (secondary) {
      font(ctx, theme, 12);
      ctx.fillStyle = "#2e2e2e";
      text(ctx, secondary, x + 21, y + 89, 126);
    }
  }
}

function circle(ctx: Context, x: number, y: number, radius: number) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
}

function arc(ctx: Context, x: number, y: number, percent: number, color: string) {
  const fullCircle = Math.PI * 2;
  const legacyOffset = 3.14 * 88 * (1 - Math.min(100, Math.max(0, percent)) / 100);
  ctx.beginPath();
  ctx.arc(x, y, 45, -Math.PI / 2, -Math.PI / 2 + fullCircle - legacyOffset / 45);
  ctx.lineWidth = 12;
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.stroke();
}

function progressColor(theme: Theme, percent: number, index: number) {
  const { progressHigh, progressMedium, progressLow } = theme.style;
  return percent >= 90 ? progressHigh : percent >= 80 ? progressMedium : progressLow[index % progressLow.length]!;
}

function drawResource(ctx: Context, theme: Theme, resource: StatusResource, index: number, x: number, y: number) {
  const percent = Math.min(100, Math.max(0, resource.percent));
  const cy = y + 55;
  ctx.save();
  circle(ctx, x, cy, 55);
  ctx.fillStyle = "#fff";
  ctx.fill();
  const background = ctx.createLinearGradient(x - 51, cy - 51, x + 51, cy + 51);
  background.addColorStop(0, "#c5ccda");
  background.addColorStop(0.55, "#e8ecf2");
  background.addColorStop(1, "#fff");
  circle(ctx, x, cy, 51);
  ctx.fillStyle = background;
  ctx.fill();
  circle(ctx, x, cy, 39);
  ctx.fillStyle = "#fff";
  ctx.shadowOffsetX = 4 * effectScale;
  ctx.shadowOffsetY = 4 * effectScale;
  ctx.shadowBlur = 8 * effectScale;
  ctx.shadowColor = "#c5ccda";
  ctx.fill();
  ctx.shadowColor = "transparent";
  if (resource.bufferPercent !== undefined) arc(ctx, x, cy, resource.bufferPercent, "#bcbbbbb0");
  arc(ctx, x, cy, percent, progressColor(theme, percent, index));
  ctx.textAlign = "center";
  font(ctx, theme, 20, 700);
  ctx.fillStyle = "#514f4f";
  text(ctx, `${Math.round(percent)}%`, x, cy + 7, undefined, true);
  font(ctx, theme, 22, 700);
  ctx.fillStyle = "#000";
  text(ctx, resource.title, x, y + 138, undefined, true);
  font(ctx, theme, 12);
  ctx.fillStyle = "#5f5d5d";
  if (resource.detail) text(ctx, resource.detail, x, y + 158, 143);
  ctx.fillStyle = "#2f4f4f";
  for (const [line, value] of (resource.info ?? []).entries()) {
    text(ctx, value, x, y + (resource.detail ? 180 : 158) + line * 22, 143);
  }
  ctx.restore();
}

function sectionHeader(ctx: Context, theme: DrawTheme, height: number, y: number, panelHeight: number, symbol: Icon, title: string) {
  glass(ctx, theme, height, 25, y, theme.columnWidth - 50, panelHeight);
  icon(ctx, theme, symbol, 46, y + 16, 20);
  font(ctx, theme, 18, 700);
  ctx.fillStyle = "#000";
  text(ctx, title, 73, y + 33, undefined, true);
  ctx.strokeStyle = "#707070da";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(36, y + 51);
  ctx.lineTo(theme.columnWidth - 36, y + 51);
  ctx.stroke();
  ctx.setLineDash([]);
}

const detailHeight = (section: StatusDetailSection) => 72 + section.rows.reduce((height, row) =>
  height + (row[2] === undefined ? 26 : 40), 0);

function drawDetails(ctx: Context, theme: DrawTheme, height: number, section: StatusDetailSection, y: number) {
  sectionHeader(ctx, theme, height, y, detailHeight(section), section.icon, section.title);
  let baseline = y + 75;
  for (const [index, [label, value, percent]] of section.rows.entries()) {
    font(ctx, theme, 14, 700);
    ctx.fillStyle = "#34343d";
    text(ctx, label, 49, baseline, 165);
    font(ctx, theme, 14);
    ctx.fillStyle = section.icon === "redis" ? theme.style.redisValueColor : "#272a39";
    text(ctx, value, 231, baseline, theme.columnWidth - 285);
    if (percent !== undefined) {
      const width = theme.columnWidth - 278;
      rounded(ctx, 231, baseline + 9, width, 5, 2.5);
      ctx.fillStyle = "#b2b4bf70";
      ctx.fill();
      rounded(ctx, 231, baseline + 9, width * Math.max(0, Math.min(1, percent / 100)), 5, 2.5);
      ctx.fillStyle = progressColor(theme, percent, index);
      ctx.fill();
      baseline += 14;
    }
    baseline += 26;
  }
}

const historyHeight = 222;
const historyTime = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai" });

interface StatusChart {
  readonly title: string;
  readonly icon: StatusDetailSection["icon"];
  readonly axes: (maximum: number) => string;
  readonly series: readonly { readonly label: string; readonly color: string }[];
  readonly history: readonly { readonly at: number; readonly values?: readonly number[] }[];
}

function drawHistory(ctx: Context, theme: DrawTheme, height: number, chart: StatusChart, y: number) {
  sectionHeader(ctx, theme, height, y, historyHeight, chart.icon, chart.title);
  const readings = chart.history.filter(sample => sample.values !== undefined);
  const first = readings[0]!.at;
  const last = readings.at(-1)!.at;
  const maximum = Math.max(1, ...readings.flatMap(sample => sample.values!));
  const top = y + 75;
  const bottom = y + 176;
  const left = 119;
  const right = theme.columnWidth - 60;
  font(ctx, theme, 12);
  ctx.fillStyle = "#34343d";
  ctx.textAlign = "right";
  ctx.strokeStyle = "#59596880";
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const row = top + (bottom - top) * i / 2;
    ctx.beginPath();
    ctx.moveTo(left, row);
    ctx.lineTo(right, row);
    ctx.stroke();
    text(ctx, chart.axes(maximum * (1 - i / 2)), left - 8, row + 4, 66);
  }
  ctx.textAlign = "left";
  text(ctx, historyTime.format(first), left, bottom + 20);
  ctx.textAlign = "right";
  text(ctx, historyTime.format(last), right, bottom + 20);
  ctx.textAlign = "left";
  for (const [index, { label, color }] of chart.series.entries()) {
    ctx.fillStyle = color;
    text(ctx, label, theme.columnWidth - 162 + index * 56, y + 34);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let connected = false;
    for (const sample of chart.history) {
      if (!sample.values) {
        connected = false;
        continue;
      }
      const x = left + (sample.at - first) / Math.max(1, last - first) * (right - left);
      const point = bottom - sample.values[index]! / maximum * (bottom - top);
      if (connected) ctx.lineTo(x, point);
      else ctx.moveTo(x, point);
      connected = true;
    }
    ctx.stroke();
  }
}

function historyChart(model: StatusCardModel, theme: Theme): StatusChart[] {
  const candidates: StatusChart[] = [];
  const network = model.networkHistory?.filter(row => Number.isSafeInteger(row.at)).map(({ at, network }) => ({
    at, values: Array.isArray(network) && network.length === 2 && network.every(value => Number.isFinite(value) && value >= 0)
      ? network : undefined,
  }));
  const palette = theme.style.chartColors;
  if (network) candidates.push({
    title: "网络流量", icon: "网络", axes: value => (value / 1024).toFixed(1) + " KiB/s",
    series: [{ label: "上传", color: palette[0]! }, { label: "下载", color: palette[1 % palette.length]! }], history: network,
  });
  const redis = model.redisHistory?.filter(row => Number.isSafeInteger(row.at)).map(({ at, redisClients }) => ({
    at, values: redisClients !== undefined && Number.isSafeInteger(redisClients) && redisClients >= 0 ? [redisClients] : undefined,
  }));
  if (redis) candidates.push({
    title: "Redis 连接数", icon: "redis", axes: value => String(value), series: [{ label: "客户端", color: "#a64136" }], history: redis,
  });
  return candidates.filter(chart => chart.history.filter(sample => sample.values).length > 1);
}

const sectionGap = 20;
const topMargin = 40;
const footerHeight = 60;

export function statusPanelLayout(panelHeights: readonly number[], startColumn: boolean) {
  const heights = panelHeights.map(panel => panel + sectionGap);
  const total = heights.reduce((a, b) => a + b, 0);
  const fullHeight = topMargin + total + footerHeight;
  const targetCount = startColumn ? fullHeight > 4500 ? 4 : fullHeight > 2900 ? 3 : fullHeight > 1700 ? 2 : 1 : 1;
  const columns = Math.min(Math.max(1, heights.length), targetCount);
  const placements: { column: number; y: number }[] = [];
  let column = 0;
  let used = 0;
  let maximum = 0;
  let remaining = total;
  let target = total / columns;
  for (const [index, height] of heights.entries()) {
    const columnsLeft = columns - column - 1;
    const remainingItems = heights.length - index;
    if (used > 0 && columnsLeft > 0 && (remainingItems <= columnsLeft ||
        Math.abs(used - target) < Math.abs(used + height - target))) {
      maximum = Math.max(maximum, used);
      column++;
      used = 0;
      target = remaining / (columnsLeft);
    }
    placements.push({ column, y: topMargin + used });
    used += height;
    remaining -= height;
  }
  return { placements, columns: column + 1, footerY: topMargin + Math.max(maximum, used) };
}

export async function renderStatusCard(model: StatusCardModel, theme: Theme, inlineImageByteLimit?: number) {
  const meter = new Canvas(1, 1).getContext("2d");
  meter.fontSynthesis = false;
  const resources = model.resources.filter(resource => Number.isFinite(resource.percent));
  const rowSize = resources.length === 5 ? 5 : 4;
  const columnWidth = rowSize === 5 ? 800 : logicalWidth;
  const resourceRows: { items: StatusResource[]; height: number }[] = [];
  for (let index = 0; index < resources.length; index += rowSize) {
    const items = resources.slice(index, index + rowSize);
    resourceRows.push({ items, height: 192 + 22 * Math.max(0, ...items.map(row => row.info?.length ?? 0)) });
  }
  type Panel = { height: number; draw: (ctx: Context, theme: DrawTheme, height: number, y: number) => void };
  const panels: Panel[] = model.accounts.map(account => {
    const layout = badgeRows(meter, theme, account);
    return { height: layout.height, draw: (ctx, layoutTheme, height, y) => drawAccount(ctx, layoutTheme, height, account, layout, y) };
  });
  panels.push({ height: 117, draw: (ctx, layoutTheme, height, y) => drawSystem(ctx, layoutTheme, height, model, y) });
  if (resourceRows.length) {
    const panelHeight = 42 + resourceRows.reduce((sum, row) => sum + row.height, 0);
    panels.push({ height: panelHeight, draw(ctx, layoutTheme, height, y) {
      sectionHeader(ctx, layoutTheme, height, y, panelHeight, "资源", "资源使用");
      let rowY = y + 62;
      for (const [row, { items, height }] of resourceRows.entries()) {
        for (const [column, resource] of items.entries()) {
          const x = 36 + (columnWidth - 72) * (column + 0.5) / items.length;
          drawResource(ctx, layoutTheme, resource, row * rowSize + column, x, rowY);
        }
        rowY += height;
      }
    } });
  }
  for (const section of model.details ?? []) {
    panels.push({ height: detailHeight(section), draw: (ctx, layoutTheme, height, y) => drawDetails(ctx, layoutTheme, height, section, y) });
  }
  for (const chart of historyChart(model, theme)) {
    panels.push({ height: historyHeight, draw: (ctx, layoutTheme, height, y) => drawHistory(ctx, layoutTheme, height, chart, y) });
  }
  const layout = statusPanelLayout(panels.map(panel => panel.height), theme.style.startColumn);
  const { footerY } = layout;
  const width = columnWidth * layout.columns;
  const height = footerY + footerHeight;
  function draw(ctx: Context) {
    ctx.fontSynthesis = false;
    ctx.fillStyle = "#e9e9e9";
    ctx.fillRect(0, 0, width, height);
    background(ctx, theme, height, width);
    for (const [index, panel] of panels.entries()) {
      const { column, y } = layout.placements[index]!;
      const left = column * columnWidth;
      ctx.save();
      ctx.translate(left, 0);
      panel.draw(ctx, { ...theme, columnWidth, pageWidth: width, left }, height, y);
      ctx.restore();
    }
    ctx.textAlign = "center";
    font(ctx, theme, 14);
    ctx.fillStyle = "#fff";
    ctx.shadowOffsetX = 1 * effectScale;
    ctx.shadowOffsetY = 1 * effectScale;
    ctx.shadowBlur = 1 * effectScale;
    ctx.shadowColor = "#000";
    const footerCenter = width / 2;
    text(ctx, "Created By Lotus-Yunzai", footerCenter, footerY + 17);
    const runtimeWidth = ctx.measureText("Bun " + Bun.version).width;
    ctx.textAlign = "left";
    text(ctx, "Bun", footerCenter - runtimeWidth / 2, footerY + 38);
    ctx.fillStyle = "#d3bc8e";
    text(ctx, Bun.version, footerCenter - runtimeWidth / 2 + ctx.measureText("Bun ").width, footerY + 38);
  }
  const render = (factor: number) => renderPng(Math.ceil(width * factor), Math.ceil(height * factor), ctx => {
    ctx.scale(factor, factor);
    draw(ctx);
  }, "gpu", { allowHalfScale: factor === 4 });
  const full = await render(scale);
  if (inlineImageByteLimit === undefined || full.png.byteLength <= inlineImageByteLimit) return full;
  if (nativeImageRasterScale() === 4 && !full.reducedScaleReason) {
    const reduced = await render(2);
    if (reduced.png.byteLength <= inlineImageByteLimit) return reduced;
  }
  throw new RangeError("状态图超过当前会话图片大小上限。");
}
