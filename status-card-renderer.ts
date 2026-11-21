import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drawInfoText, infoCardColors as colors, measureInfoText, renderInfoCard } from "@lotus-yunzai/skia/info-card";
import type { CanvasRenderingContext2D, Image } from "skia-canvas";
import { loadCardImage } from "./local-card-assets.ts";
import { loadStatusBackground, readStatusBackground, type StatusPhoto } from "./status-background.ts";
import type { StatusCardModel } from "./status-card-data.ts";

const defaultDirectory = fileURLToPath(new URL("./assets/status-card/", import.meta.url));
const portraitSize = 50;
interface StatusSection {
  readonly title: string;
  readonly lines: readonly string[];
  readonly percent?: number;
  readonly buffer?: number;
  readonly account?: boolean;
}

interface Theme {
  readonly background: Image;
  readonly photo: StatusPhoto;
  readonly avatar?: Image;
  readonly online?: Image;
}

export function statusCardThemeDirectory() {
  return process.env.LOTUS_SYSTEM_STATUS_THEME_DIR || defaultDirectory;
}

export async function loadStatusCardTheme(directory = statusCardThemeDirectory()): Promise<Theme | undefined> {
  const [root, selected] = await Promise.all([realpath(directory).catch(() => undefined), readStatusBackground()]);
  if (!root || !selected) return;
  for (const resource of [root, join(root, "resources")]) {
    const background = await loadStatusBackground(resource, selected);
    if (!background) continue;
    const [avatar, online] = await Promise.all([
      loadCardImage(resource, "state/img/default_avatar.jpg").catch(() => undefined),
      loadCardImage(resource, "state/icon/11.png").catch(() => undefined),
    ]);
    return { background: background.image, photo: background.photo, avatar, online };
  }
}

function duration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  const parts = [[Math.floor(seconds / 86_400), "天"], [Math.floor(seconds / 3600) % 24, "时"],
    [Math.floor(seconds / 60) % 60, "分"], [seconds % 60, "秒"]] as const;
  return parts.filter(([amount]) => amount > 0).map(([amount, unit]) => amount + unit).join(" ") || "0 秒";
}

function drawAccountPortrait(ctx: CanvasRenderingContext2D, theme: Theme | undefined, initial: string, x: number, y: number) {
  const size = portraitSize;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 12);
  ctx.clip();
  if (theme?.avatar) {
    const image = theme.avatar;
    const zoom = size / Math.min(image.width, image.height);
    const w = image.width * zoom;
    const h = image.height * zoom;
    ctx.drawImage(image, x + (size - w) / 2, y + (size - h) / 2, w, h);
  } else {
    ctx.fillStyle = colors.rule;
    ctx.fillRect(x, y, size, size);
    drawInfoText(ctx, [initial], x + size / 2, y + 12, { size: 23, align: "center", color: colors.gold });
  }
  ctx.restore();
  if (theme?.online) {
    ctx.drawImage(theme.online, x + size - 11, y + size - 11, 16, 16);
  } else {
    ctx.beginPath();
    ctx.arc(x + size - 3, y + size - 3, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#49d79c";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#172130";
    ctx.stroke();
  }
}

export function renderStatusCard(model: StatusCardModel, theme: Theme | undefined, pro = false) {
  return renderInfoCard({ title: pro ? "运行状态 Pro" : "运行状态", metadata: `${model.platform} · ${model.runtime}`, width: 750 },
    ({ x, y, width, measure }) => {
      const photoHeight = theme ? 200 : 0;
      const sections: StatusSection[] = [
        ...model.accounts.map(account => ({
          title: account.name,
          account: true,
          lines: [
            `${account.adapter === "milky" ? "Milky v1" : "OneBot v11"} · 在线 ${duration(account.seconds)}`,
            [ [account.friends, "好友"], [account.groups, "群组"], [account.members, "群员"],
              [account.sent, "发送"], [account.received, "接收"], [account.images, "图片"] ].flatMap(([value, label]) =>
              value !== undefined ? [`${label} ${value}`] : []).join(" · "),
          ],
        })),
        { title: "宿主", lines: [`运行时间 ${duration(model.uptime)} · 主机名 隐藏`,
          [model.pluginCount === undefined ? "" : `${model.pluginCount} 个插件`,
            model.scriptCount === undefined ? "" : `${model.scriptCount} 个脚本`].filter(Boolean).join(" · ")] },
        ...model.resources.filter(item => Number.isFinite(item.percent)).slice(0, 4).map(resource => ({
          title: `${resource.title} ${Math.round(resource.percent)}%`,
          lines: [resource.detail, ...(resource.info ?? [])].filter((line): line is string => Boolean(line)),
          percent: resource.percent,
          buffer: resource.bufferPercent,
        })),
      ];
      const blocks = sections.map(({ title: name, lines: descriptions, percent, buffer, account }) => {
        const left = account ? 78 : 16;
        const textWidth = width - left - 16;
        const title = measureInfoText(measure, name, textWidth, 22);
        const lines = descriptions.filter(Boolean).flatMap(line => measureInfoText(measure, line, textWidth, 17));
        const initial = account ? Array.from(name.trim())[0] ?? "?" : undefined;
        const height = 25 + title.length * 31 + lines.length * 25 + (percent === undefined ? 0 : 16);
        return { title, lines, percent, buffer, left, initial, height: account ? Math.max(74, height) : height };
      });
      return {
        height: photoHeight + blocks.reduce((sum, block) => sum + block.height + 12, 0),
        draw(ctx) {
          if (theme) {
            const image = theme.background;
            const h = photoHeight - 14;
            const zoom = Math.max(width / image.width, h / image.height);
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(x, y, width, h, 12);
            ctx.clip();
            ctx.drawImage(image, x + (width - image.width * zoom) / 2, y + (h - image.height * zoom) * 0.3,
              image.width * zoom, image.height * zoom);
            ctx.restore();
          }
          let top = y + photoHeight;
          for (const { title, lines, percent, buffer, left, initial, height } of blocks) {
            ctx.beginPath();
            ctx.roundRect(x, top, width, height, 10);
            ctx.fillStyle = colors.tile;
            ctx.fill();
            if (initial) drawAccountPortrait(ctx, theme, initial, x + 14, top + (height - portraitSize) / 2);
            drawInfoText(ctx, title, x + left, top + 10, { color: colors.gold, size: 22, leading: 31 });
            drawInfoText(ctx, lines, x + left, top + 10 + title.length * 31, { color: colors.muted, size: 17, leading: 25 });
            if (percent !== undefined) {
              const bar = width - 32;
              ctx.fillStyle = colors.rule;
              ctx.fillRect(x + 16, top + height - 16, bar, 5);
              if (buffer !== undefined && Number.isFinite(buffer)) {
                ctx.fillStyle = colors.muted;
                ctx.fillRect(x + 16, top + height - 16, bar * Math.max(0, Math.min(100, buffer)) / 100, 5);
              }
              ctx.fillStyle = colors.gold;
              ctx.fillRect(x + 16, top + height - 16, bar * Math.max(0, Math.min(100, percent)) / 100, 5);
            }
            top += height + 12;
          }
        },
      };
    }, { mode: "gpu" });
}
