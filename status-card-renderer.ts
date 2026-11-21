import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drawInfoText, infoCardColors as colors, measureInfoText, renderInfoCard } from "@lotus-yunzai/skia/info-card";
import type { Image } from "skia-canvas";
import { loadStatusBackground, readStatusBackground, type StatusPhoto } from "./status-background.ts";
import type { StatusCardModel } from "./status-card-data.ts";

const defaultDirectory = fileURLToPath(new URL("./assets/status-card/", import.meta.url));
interface StatusSection {
  readonly title: string;
  readonly lines: readonly string[];
  readonly percent?: number;
  readonly buffer?: number;
}

interface Theme {
  readonly background: Image;
  readonly photo: StatusPhoto;
}

export function statusCardThemeDirectory() {
  return process.env.LOTUS_SYSTEM_STATUS_THEME_DIR || defaultDirectory;
}

export async function loadStatusCardTheme(directory = statusCardThemeDirectory()): Promise<Theme | undefined> {
  const [root, selected] = await Promise.all([realpath(directory).catch(() => undefined), readStatusBackground()]);
  if (!root || !selected) return;
  for (const resource of [root, join(root, "resources")]) {
    const background = await loadStatusBackground(resource, selected);
    if (background) return { background: background.image, photo: background.photo };
  }
}

function duration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  const parts = [[Math.floor(seconds / 86_400), "天"], [Math.floor(seconds / 3600) % 24, "时"],
    [Math.floor(seconds / 60) % 60, "分"], [seconds % 60, "秒"]] as const;
  return parts.filter(([amount]) => amount > 0).map(([amount, unit]) => amount + unit).join(" ") || "0 秒";
}

export function renderStatusCard(model: StatusCardModel, theme: Theme | undefined, pro = false) {
  return renderInfoCard({ title: pro ? "运行状态 Pro" : "运行状态", metadata: `${model.platform} · ${model.runtime}`, width: 750 },
    ({ x, y, width, measure }) => {
      const photoHeight = theme ? 200 : 0;
      const sections: StatusSection[] = [
        ...model.accounts.map(account => ({
          title: account.name,
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
      const blocks = sections.map(({ title: name, lines: descriptions, percent, buffer }) => {
        const title = measureInfoText(measure, name, width - 32, 22);
        const lines = descriptions.filter(Boolean).flatMap(line => measureInfoText(measure, line, width - 32, 17));
        return { title, lines, percent, buffer, height: 25 + title.length * 31 + lines.length * 25 + (percent === undefined ? 0 : 16) };
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
          for (const { title, lines, percent, buffer, height } of blocks) {
            ctx.beginPath();
            ctx.roundRect(x, top, width, height, 10);
            ctx.fillStyle = colors.tile;
            ctx.fill();
            drawInfoText(ctx, title, x + 16, top + 10, { color: colors.gold, size: 22, leading: 31 });
            drawInfoText(ctx, lines, x + 16, top + 10 + title.length * 31, { color: colors.muted, size: 17, leading: 25 });
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
