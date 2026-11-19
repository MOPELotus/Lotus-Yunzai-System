import { randomInt } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { loadCardImage } from "./local-card-assets.ts";

const defaultConfig = new URL("../../config/system-status.yaml", import.meta.url);
const backdropDirectory = "state/img/bg";

function isPhoto(value: unknown): value is string {
  return typeof value === "string" && !value.startsWith(".") && !/[/\\:\p{Cc}]/u.test(value) &&
    /\.(?:jpe?g|png|webp|gif|avif|bmp)$/iu.test(value);
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

export async function readStatusBackground(
  source = process.env.LOTUS_SYSTEM_STATUS_CONFIG || defaultConfig,
): Promise<string | undefined> {
  try {
    const file = Bun.file(source);
    if (!await file.exists()) return "random";
    if (file.size > 64 * 1024) return;
    const data: unknown = Bun.YAML.parse(await file.text());
    const value = object(object(data)?.style)?.backdropDefault;
    if (value === undefined || value === "random") return "random";
    if (isPhoto(value)) return value;
  } catch {
    return;
  }
}

export async function loadStatusBackground(root: string, selection: string, pick: (length: number) => number = randomInt) {
  if (selection !== "random" && !isPhoto(selection)) return;
  try {
    const directory = await realpath(join(root, backdropDirectory));
    const location = relative(root, directory);
    if (!location || location === ".." || location.startsWith(".." + sep) || isAbsolute(location)) return;
    if (selection !== "random") return await loadCardImage(directory, selection);
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && isPhoto(entry.name))
      .map(({ name }) => name).sort();
    while (files.length) {
      const [name] = files.splice(pick(files.length), 1);
      if (!name) return;
      const image = await loadCardImage(directory, name).catch(() => undefined);
      if (image) return image;
    }
  } catch {
    return;
  }
}
