import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { FontLibrary, loadImage } from "skia-canvas";

export async function cardAssetFile(root: string, path: string) {
  try {
    const file = await realpath(join(root, path));
    const name = relative(root, file);
    if (!name || name === ".." || name.startsWith(".." + sep) || isAbsolute(name)) return;
    const info = await stat(file);
    if (info.isFile() && info.size <= 24 * 1024 ** 2) return file;
  } catch {
    return;
  }
}

export async function loadCardImage(root: string, path: string) {
  const file = await cardAssetFile(root, path);
  if (file) return loadImage(await readFile(file));
}

const fonts = new Map<string, string>();

export async function loadCardFont(root: string, path: string) {
  const file = await cardAssetFile(root, path);
  if (!file) return;
  const known = fonts.get(file);
  if (known) return known;
  const name = "Lotus Card " + createHash("sha256").update(file).digest("hex").slice(0, 12);
  FontLibrary.use(name, [file]);
  fonts.set(file, name);
  return name;
}
