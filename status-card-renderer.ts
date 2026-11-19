import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPng } from "@lotus-yunzai/skia";
import { Canvas, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { cardAssetFile, loadCardFont, loadCardImage } from "./local-card-assets.ts";
import type { RuntimeStatusAccount, StatusCardModel, StatusResource } from "./status-card-data.ts";

// Layout and local asset paths follow Yenai-Plugin fe42a6f, resources/state/index.html and css/index.css.
const defaultDirectory = fileURLToPath(new URL("./assets/status-card/", import.meta.url));
const logicalWidth = 750;
const scale = 1.4;
const colors = ["#84A0DF", "#2EC272", "#8070F9"];
const contacts = ["#F1EDFE", "#FDF1E6", "#E9F4FC"];
const icons = [
  "11", "机器人", "platform", "时间", "friend", "group", "groupMember", "sent", "recv", "screenshot",
  "系统", "主机名", "time", "插件", "资源",
] as const;
type Icon = typeof icons[number];
interface Theme {
  readonly background: Image;
  readonly avatar: Image;
  readonly icons: ReadonlyMap<Icon, Image>;
  readonly font: string;
}

export function statusCardThemeDirectory() {
  return process.env.LOTUS_SYSTEM_STATUS_THEME_DIR || defaultDirectory;
}

export async function loadStatusCardTheme(directory = statusCardThemeDirectory()): Promise<Theme | undefined> {
  const root = await realpath(directory).catch(() => undefined);
  if (!root) return;
  const direct = await cardAssetFile(root, "state/img/bg/1.jpg") || await cardAssetFile(root, "state/img/bg/2.jpg");
  const theme = direct ? root : await cardAssetFile(root, "resources/state/img/bg/1.jpg") ||
    await cardAssetFile(root, "resources/state/img/bg/2.jpg") ? join(root, "resources") : undefined;
  if (!theme) return;
  const [background, avatar, font, entries] = await Promise.all([
    loadCardImage(theme, "state/img/bg/1.jpg").then(image => image ?? loadCardImage(theme, "state/img/bg/2.jpg")),
    loadCardImage(theme, "state/img/default_avatar.jpg"),
    loadCardFont(theme, "common/font/FZB.ttf"),
    Promise.all(icons.map(async icon => [icon, await loadCardImage(theme, `state/icon/${icon}.png`)] as const)),
  ]);
  if (!background || !avatar || entries.some(([, image]) => image === undefined)) return;
  const family = font ? `"${font}", "Noto Sans CJK SC", sans-serif` : '"PingFang SC", "Noto Sans CJK SC", sans-serif';
  return { background, avatar, font: family, icons: new Map(entries.filter((entry): entry is readonly [Icon, Image] => entry[1] !== undefined)) };
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

function background(ctx: Context, theme: Theme, height: number) {
  const ratio = Math.max(logicalWidth / theme.background.width, height / theme.background.height);
  const width = theme.background.width * ratio;
  ctx.drawImage(theme.background, (logicalWidth - width) / 2, 0, width, theme.background.height * ratio);
}

function glass(ctx: Context, theme: Theme, height: number, x: number, y: number, width: number, boxHeight: number) {
  ctx.save();
  rounded(ctx, x, y, width, boxHeight, 18);
  ctx.shadowOffsetY = 8;
  ctx.shadowBlur = 32;
  ctx.shadowColor = "rgba(51,51,52,0.50)";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fill();
  ctx.restore();

  ctx.save();
  rounded(ctx, x, y, width, boxHeight, 18);
  ctx.clip();
  ctx.filter = "blur(14px)";
  background(ctx, theme, height);
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
  const version: Badge[] = [
    { label: "Lotus-Yunzai", icon: "机器人", color: "#FBE0F3" },
    { label: account.adapter === "milky" ? "Milky v1" : "OneBot v11", icon: "platform", color: "#F0EDF2" },
    { label: `Bot已运行 ${duration(account.seconds)}`, icon: "时间", color: "#F1EBFA" },
  ];
  const contact: Badge[] = [];
  const stats = [
    [account.friends, "好友", "friend"], [account.groups, "群组", "group"], [account.members, "群员", "groupMember"],
    [account.sent, "发", "sent"], [account.received, "收", "recv"], [account.images, "图片", "screenshot"],
  ] as const;
  for (const [value, suffix, name] of stats) {
    if (value === undefined || value === 0 || value === "0") continue;
    contact.push({ label: String(value), suffix, icon: name, color: contacts[contact.length % contacts.length]! });
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
  ctx.shadowOffsetX = -2;
  ctx.shadowOffsetY = 2;
  ctx.shadowBlur = 3;
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

function drawAccount(ctx: Context, theme: Theme, height: number, account: RuntimeStatusAccount,
  layout: ReturnType<typeof badgeRows>, y: number) {
  glass(ctx, theme, height, 25, y, 700, layout.height);
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
  ctx.shadowOffsetX = -2;
  ctx.shadowOffsetY = 2;
  ctx.shadowBlur = 8;
  ctx.shadowColor = "rgba(8,8,8,0.50)";
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.fill();
  ctx.restore();
  ctx.save();
  rounded(ctx, 56, avatarY, 100, 100, 25);
  ctx.shadowOffsetX = -2;
  ctx.shadowOffsetY = 2;
  ctx.shadowBlur = 12;
  ctx.shadowColor = "rgba(8,8,8,0.55)";
  ctx.fillStyle = "white";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.clip();
  ctx.drawImage(theme.avatar, 56, avatarY, 100, 100);
  ctx.restore();
  icon(ctx, theme, "11", 146, avatarY + 86, 20);

  font(ctx, theme, 28, 700);
  ctx.fillStyle = "#000";
  text(ctx, account.name, 186, y + 52, 380, true);
  ctx.strokeStyle = "#c0bfc1";
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(186, y + 65);
  ctx.lineTo(695, y + 65);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const row of layout.rows) drawBadge(ctx, theme, row.badge, 186 + row.x, y + 75 + row.y, row.width);
}

function drawSystem(ctx: Context, theme: Theme, height: number, model: StatusCardModel, y: number) {
  const items = [
    ["系统", "系统", model.platform, model.runtime],
    ["主机名", "主机名", "隐藏", undefined],
    ["运行时间", "time", duration(model.uptime), undefined],
    ["插件数", "插件", model.pluginCount === undefined ? "—" : `${model.pluginCount} plugins`,
      model.scriptCount === undefined ? undefined : `${model.scriptCount} js`],
  ] as const;
  for (const [index, [label, symbol, value, secondary]] of items.entries()) {
    const x = 25 + index * 177.5;
    glass(ctx, theme, height, x, y, 167.5, 117);
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
  ctx.shadowOffsetX = 4;
  ctx.shadowOffsetY = 4;
  ctx.shadowBlur = 8;
  ctx.shadowColor = "#c5ccda";
  ctx.fill();
  ctx.shadowColor = "transparent";
  if (resource.bufferPercent !== undefined) arc(ctx, x, cy, resource.bufferPercent, "#bcbbbbb0");
  arc(ctx, x, cy, percent, percent >= 90 ? "#d73403" : percent >= 80 ? "#ffa500" : colors[index % colors.length]!);
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

export async function renderStatusCard(model: StatusCardModel, theme: Theme) {
  const meter = new Canvas(1, 1).getContext("2d");
  const layouts = model.accounts.map(account => badgeRows(meter, theme, account));
  const resources = model.resources.filter(resource => Number.isFinite(resource.percent)).slice(0, 4);
  const resourceHeight = resources.length ? 234 + 22 * Math.max(0, ...resources.map(row => row.info?.length ?? 0)) : 0;
  const systemY = 40 + layouts.reduce((sum, box) => sum + box.height + 20, 0);
  const resourceY = systemY + 137;
  const footerY = resourceY + resourceHeight + (resources.length ? 20 : 0);
  const height = footerY + 60;
  return renderPng(Math.ceil(logicalWidth * scale), Math.ceil(height * scale), ctx => {
    ctx.scale(scale, scale);
    ctx.fillStyle = "#e9e9e9";
    ctx.fillRect(0, 0, logicalWidth, height);
    background(ctx, theme, height);
    let y = 40;
    for (const [index, account] of model.accounts.entries()) {
      const layout = layouts[index]!;
      drawAccount(ctx, theme, height, account, layout, y);
      y += layout.height + 20;
    }
    drawSystem(ctx, theme, height, model, y);
    if (resources.length) {
      glass(ctx, theme, height, 25, resourceY, 700, resourceHeight);
      icon(ctx, theme, "资源", 46, resourceY + 16, 20);
      font(ctx, theme, 18, 700);
      ctx.fillStyle = "#000";
      text(ctx, "资源使用", 73, resourceY + 33, undefined, true);
      ctx.strokeStyle = "#707070da";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(36, resourceY + 51);
      ctx.lineTo(714, resourceY + 51);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [index, resource] of resources.entries()) {
        drawResource(ctx, theme, resource, index, 36 + 678 * (index + 0.5) / resources.length, resourceY + 62);
      }
    }

    ctx.textAlign = "center";
    font(ctx, theme, 14);
    ctx.fillStyle = "#fff";
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.shadowBlur = 1;
    ctx.shadowColor = "#000";
    text(ctx, "Created By Lotus-Yunzai", 375, footerY + 17);
    const runtimeWidth = ctx.measureText("Bun " + Bun.version).width;
    ctx.textAlign = "left";
    text(ctx, "Bun", 375 - runtimeWidth / 2, footerY + 38);
    ctx.fillStyle = "#d3bc8e";
    text(ctx, Bun.version, 375 - runtimeWidth / 2 + ctx.measureText("Bun ").width, footerY + 38);
  }, "gpu");
}
