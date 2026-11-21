import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { drawInfoText, infoCardColors as colors, measureInfoText, renderInfoCard } from "@lotus-yunzai/skia/info-card";
import { cardAssetFile } from "./local-card-assets.ts";
import type { VersionCardRelease } from "./version-card-data.ts";

export async function loadVersionCardTheme(directory: string) {
  const root = await realpath(directory).catch(() => undefined);
  if (!root) return;
  for (const prefix of ["", "common/", "resources/common/"]) {
    const assets = await Promise.all(["bg/bg-cryo.webp", "bg/bg-hydro.webp", "cont/card-bg.png"]
      .map(file => cardAssetFile(root, prefix + file)));
    if (assets.every(Boolean)) return join(root, prefix);
  }
}

export function renderVersionCard(releases: readonly VersionCardRelease[], themeDirectory?: string) {
  return renderInfoCard({ title: "版本信息", width: 600 }, ({ x, y, width, measure }) => {
    const sections = releases.map(release => {
      const title = measureInfoText(measure, release.version, width - 32, 22);
      const entries = release.entries.map(({ title, notes = [] }) => ({
        lines: measureInfoText(measure, title, width - 32, 18),
        notes: notes.flatMap(note => measureInfoText(measure, note, width - 48, 16)),
      }));
      const height = 22 + title.length * 32 + entries.reduce((sum, entry) =>
        sum + entry.lines.length * 26 + entry.notes.length * 24 + 6, 0);
      return { title, entries, height };
    });
    return {
      height: sections.reduce((sum, section) => sum + section.height + 12, 0),
      draw(ctx) {
        let top = y;
        for (const { title, entries, height } of sections) {
          ctx.beginPath();
          ctx.roundRect(x, top, width, height, 10);
          ctx.fillStyle = colors.tile;
          ctx.fill();
          drawInfoText(ctx, title, x + 16, top + 10, { size: 22, leading: 32, color: colors.gold });
          let itemTop = top + 10 + title.length * 32;
          for (const entry of entries) {
            drawInfoText(ctx, entry.lines, x + 16, itemTop, { size: 18, leading: 26 });
            itemTop += entry.lines.length * 26;
            drawInfoText(ctx, entry.notes, x + 32, itemTop, { size: 16, leading: 24, color: colors.muted });
            itemTop += entry.notes.length * 24 + 6;
          }
          top += height + 12;
        }
      },
    };
  }, { mode: "gpu", themeDirectory });
}
