import { createHash, randomInt } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { loadImage } from "skia-canvas";
import { cardAssetFile } from "./local-card-assets.ts";

const defaultConfig = new URL("../../config/system-status.yaml", import.meta.url);
const legacyStatusConfig = new URL("../../plugins/yenai-plugin/config/config/state.yaml", import.meta.url);
const backdropDirectory = "state/img/bg";

export interface StatusPhoto {
  readonly name: string;
  readonly sha256: string;
}

function isPhoto(value: unknown): value is string {
  return typeof value === "string" && !value.startsWith(".") && !/[/\\:\p{Cc}]/u.test(value) &&
    /\.(?:jpe?g|png|webp|gif|avif|bmp)$/iu.test(value);
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

export function isStatusPhoto(value: unknown): value is StatusPhoto {
  const objectValue = object(value);
  return objectValue !== undefined && isPhoto(objectValue.name) &&
    typeof objectValue.sha256 === "string" && objectValue.sha256.length === 64 && /^[a-f0-9]{64}$/u.test(objectValue.sha256);
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function photoDirectory(root: string) {
  const directory = await realpath(join(root, backdropDirectory));
  const location = relative(root, directory);
  if (location && location !== ".." && !location.startsWith(".." + sep) && !isAbsolute(location)) return directory;
}

async function readPhoto(directory: string, name: string) {
  const file = await cardAssetFile(directory, name);
  if (file) return readFile(file);
}

async function readConfig(source: string | URL): Promise<Record<string, unknown> | undefined> {
  try {
    const file = Bun.file(source);
    if (!await file.exists()) return {};
    if (file.size > 64 * 1024) return;
    const data: unknown = Bun.YAML.parse(await file.text());
    return object(data) ?? {};
  } catch {
    return;
  }
}

export function mergeLegacyStatusConfig(current: Record<string, unknown>, legacy?: Record<string, unknown>) {
  const defaults: Record<string, unknown> = {};
  if (!legacy) return current;
  for (const key of ["defaultState", "noPro", "closedChart"]) {
    if (typeof legacy[key] === "boolean") defaults[key] = legacy[key];
  }
  for (const key of ["showRedisInfo", "showFastFetch"]) {
    const value = legacy[key];
    if (typeof value === "boolean" || value === "pro" || (key === "showFastFetch" && value === "default")) defaults[key] = value;
  }
  if (Array.isArray(legacy.systemResources)) defaults.systemResources = legacy.systemResources;
  const legacyStyle = object(legacy.style);
  const backdropDefault = legacyStyle?.backdropDefault;
  if (backdropDefault === "random" || isPhoto(backdropDefault)) defaults.style = { backdropDefault };
  const sections = ["monitor", "processLoad", "chartsCfg"];
  if (current.networkProbesEnabled === true) sections.push("psTestSites");
  for (const key of sections) {
    const previous = object(legacy[key]);
    if (previous) defaults[key] = previous;
  }
  const merged = { ...defaults, ...current };
  for (const key of ["style", ...sections]) {
    const previous = object(defaults[key]);
    const override = object(current[key]);
    if (previous && override) merged[key] = { ...previous, ...override };
  }
  return merged;
}

export async function readStatusConfig(source?: string | URL): Promise<Record<string, unknown> | undefined> {
  const configured = source ?? (process.env.LOTUS_SYSTEM_STATUS_CONFIG || undefined);
  const current = await readConfig(configured ?? defaultConfig);
  if (!current || configured) return current;
  return mergeLegacyStatusConfig(current, await readConfig(legacyStatusConfig));
}

export async function readStatusBackground(source?: string | URL): Promise<string | undefined> {
  const config = await readStatusConfig(source);
  if (!config) return;
  const value = object(config.style)?.backdropDefault;
  if (value === undefined || value === "random") return "random";
  if (isPhoto(value)) return value;
}

export async function loadStatusBackground(root: string, selection: string, pick: (length: number) => number = randomInt) {
  if (selection !== "random" && !isPhoto(selection)) return;
  try {
    const directory = await photoDirectory(root);
    if (!directory) return;
    const load = async (name: string) => {
      const bytes = await readPhoto(directory, name);
      if (bytes) return { image: await loadImage(bytes), photo: { name, sha256: digest(bytes) } };
    };
    if (selection !== "random") return await load(selection);
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && isPhoto(entry.name))
      .map(({ name }) => name).sort();
    while (files.length) {
      const [name] = files.splice(pick(files.length), 1);
      if (!name) return;
      const background = await load(name).catch(() => undefined);
      if (background) return background;
    }
  } catch {
    return;
  }
}

export async function readStatusOriginal(theme: string, photo: StatusPhoto) {
  if (!isStatusPhoto(photo)) return;
  const root = await realpath(theme).catch(() => undefined);
  if (!root) return;
  for (const candidate of [root, join(root, "resources")]) {
    const directory = await photoDirectory(candidate).catch(() => undefined);
    if (!directory) continue;
    const bytes = await readPhoto(directory, photo.name).catch(() => undefined);
    if (bytes && bytes.length <= 16 * 1024 * 1024 && digest(bytes) === photo.sha256) return bytes;
  }
}
