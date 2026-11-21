import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderPng } from "@lotus-yunzai/skia";
import { Canvas, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { cardAssetFile, loadCardFont, loadCardImage } from "./local-card-assets.ts";
import type { VersionCardRelease } from "./version-card-data.ts";

// Visual reference is the legacy host's #版本, using miao-plugin 2860761
// resources/help/version-info.html, help/version-info.css and common/common.css.
const directory = fileURLToPath(new URL("./assets/version-card/", import.meta.url));
const width = 600;
const scale = 4;
// Skia filters and shadow distances use device pixels. Keep their former logical sizes.
const effectScale = scale / 1.2;
const panelX = 10;
const panelWidth = 575;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
interface Theme {
  readonly backdrop: Image;
  readonly panelBackdrop: Image;
  readonly texture: Image;
  readonly font: string;
}

export async function loadVersionCardTheme(
  themeDirectory = process.env.LOTUS_SYSTEM_VERSION_THEME_DIR || directory,
): Promise<Theme | undefined> {
  const root = await realpath(themeDirectory).catch(() => undefined);
  if (!root) return;
  for (const prefix of ["", "common/", "resources/common/"]) {
    if (!await cardAssetFile(root, prefix + "bg/bg-cryo.webp")) continue;
    const [backdrop, panelBackdrop, texture, numbers, chinese] = await Promise.all([
      loadCardImage(root, prefix + "bg/bg-cryo.webp"),
      loadCardImage(root, prefix + "bg/bg-hydro.webp"),
      loadCardImage(root, prefix + "cont/card-bg.png"),
      loadCardFont(root, prefix + "font/tttgbnumber.ttf"),
      loadCardFont(root, prefix + "font/HYWH-65W.ttf"),
    ]);
    if (!backdrop || !panelBackdrop || !texture) return;
    const font = [...[numbers, chinese].filter(Boolean).map(name => `"${name}"`), '"Noto Sans CJK SC"', "sans-serif"].join(", ");
    return { backdrop, panelBackdrop, texture, font };
  }
}

function wrap(ctx: Context, line: string, maximum: number): string[] {
  if (ctx.measureText(line).width <= maximum) return [line];
  const lines: string[] = [];
  let part = "";
  for (const { segment } of segmenter.segment(line)) {
    if (part && ctx.measureText(part + segment).width > maximum) {
      lines.push(part.trimEnd());
      part = "";
    }
    part += segment;
  }
  if (part) lines.push(part.trimEnd());
  return lines;
}

interface CardRow {
  readonly x: number;
  readonly top: number;
  readonly text: string;
  readonly marker?: "solid" | "ring";
}

function layout(ctx: Context, releases: readonly VersionCardRelease[], theme: Theme) {
  const boxes = [];
  let top = 15;
  for (const [index, release] of releases.entries()) {
    const heading = index === 0 ? `当前版本 ${release.version}` : `Lotus-Yunzai版本 ${release.version}`;
    const titleSize = index === 0 ? 20 : 16;
    const titleLineHeight = index === 0 ? 25 : 20;
    ctx.font = `${titleSize}px ${theme.font}`;
    const titleLines = wrap(ctx, heading, panelWidth - 40);
    const titleHeight = 16 + titleLines.length * titleLineHeight;
    const rows: CardRow[] = [];
    let y = titleHeight + 13;
    ctx.font = `14px ${theme.font}`;
    for (const entry of release.entries) {
      const lines = wrap(ctx, entry.title, 525);
      for (const [at, text] of lines.entries()) {
        rows.push({ x: 45, top: y, text, ...(at === 0 && { marker: "solid" }) });
        y += 17;
      }
      for (const note of entry.notes ?? []) {
        y += 1;
        for (const [at, text] of wrap(ctx, note, 505).entries()) {
          rows.push({ x: 65, top: y, text, ...(at === 0 && { marker: "ring" }) });
          y += 17;
        }
      }
      y += 3;
    }
    const height = y + 10;
    boxes.push({ top, height, titleHeight, titleSize, titleLineHeight, titleLines, rows });
    top += height + 5;
  }
  return { boxes, footer: top + 5, height: top + 42 };
}

function drawPanel(ctx: Context, theme: Theme, box: ReturnType<typeof layout>["boxes"][number]) {
  ctx.save();
  ctx.translate(panelX, box.top);
  ctx.beginPath();
  ctx.roundRect(0, 0, panelWidth, box.height, 10);
  ctx.shadowColor = "rgba(50,50,50,.80)";
  ctx.shadowOffsetX = 2 * effectScale;
  ctx.shadowOffsetY = 2 * effectScale;
  ctx.shadowBlur = 4 * effectScale;
  ctx.fillStyle = "#111c2a";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.clip();
  const cover = Math.max(panelWidth / theme.panelBackdrop.width, box.height / theme.panelBackdrop.height);
  ctx.drawImage(theme.panelBackdrop, 0, 0, theme.panelBackdrop.width * cover, theme.panelBackdrop.height * cover);
  const pattern = ctx.createPattern(theme.texture, "repeat-x");
  if (pattern) {
    const ratio = box.height / theme.texture.height;
    ctx.save();
    ctx.scale(ratio, ratio);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, panelWidth / ratio, theme.texture.height);
    ctx.restore();
  }
  ctx.fillStyle = "rgba(0,0,0,.4)";
  ctx.fillRect(0, 0, panelWidth, box.titleHeight);
  ctx.fillStyle = "rgba(0,0,0,.5)";
  ctx.fillRect(0, box.titleHeight, panelWidth, box.height - box.titleHeight);
  ctx.strokeStyle = "rgba(255,255,255,.24)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.12)";
  ctx.fillRect(0, box.titleHeight - .5, panelWidth, 1);
  ctx.font = `${box.titleSize}px ${theme.font}`;
  ctx.fillStyle = "#d3bc8e";
  for (const [index, title] of box.titleLines.entries()) {
    ctx.fillText(title, 20, 10 + box.titleLineHeight - 4 + index * box.titleLineHeight);
  }
  ctx.font = `14px ${theme.font}`;
  ctx.fillStyle = "#fff";
  for (const row of box.rows) {
    if (row.marker) {
      ctx.beginPath();
      ctx.arc(row.x - 13 - panelX, row.top + 9, row.marker === "solid" ? 1.9 : 2.1, 0, Math.PI * 2);
      if (row.marker === "solid") ctx.fill();
      else {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.fillText(row.text, row.x - panelX, row.top + 13.5);
  }
  ctx.restore();
}

export async function renderVersionCard(releases: readonly VersionCardRelease[], theme: Theme) {
  const meter = new Canvas(1, 1).getContext("2d");
  const { boxes, footer, height } = layout(meter, releases, theme);
  return renderPng(Math.round(width * scale), Math.round(height * scale), ctx => {
    ctx.scale(scale, scale);
    ctx.drawImage(theme.backdrop, 0, 0, width, height);
    for (const box of boxes) drawPanel(ctx, theme, box);
    ctx.textAlign = "center";
    ctx.font = `14px ${theme.font}`;
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "#000";
    ctx.shadowOffsetX = 1 * effectScale;
    ctx.shadowOffsetY = 1 * effectScale;
    ctx.shadowBlur = 1 * effectScale;
    ctx.fillText("Created By Lotus-Yunzai", width / 2 + 5, footer + 13.5);
  }, "gpu");
}
