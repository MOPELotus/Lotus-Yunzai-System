import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStatusBackground, readStatusBackground } from "./status-background.ts";

const onePixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8DwHwAFAAH/cpxSZwAAAABJRU5ErkJggg==", "base64",
);
const twoPixels = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVQI12NkYPj/n4GBgQEACwcCALXYMdcAAAAASUVORK5CYII=", "base64",
);

test("只解析旧 style.backdropDefault 并接受主题照片文件名", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-status-config-"));
  try {
    const file = join(directory, "state.yaml");
    expect(await readStatusBackground(file)).toBe("random");
    await writeFile(file, "style:\n  backdrop: 'https://background.invalid/ignored'\n");
    expect(await readStatusBackground(file)).toBe("random");
    await writeFile(file, "style:\n  backdropDefault: '旧照片.JPG'\n");
    expect(await readStatusBackground(file)).toBe("旧照片.JPG");
    for (const rejected of ["../2.jpg", "/2.jpg", "https://background.invalid/2.jpg", "file:///2.jpg", "x.svg", "2.jpg\n"]) {
      await writeFile(file, `style: {backdropDefault: ${JSON.stringify(rejected)}}\n`);
      expect(await readStatusBackground(file)).toBeUndefined();
    }
    await writeFile(file, "style: {backdropDefault: random}\n");
    expect(await readStatusBackground(file)).toBe("random");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("随机可选择不同图片，损坏和越界引用被舍弃，指定不存在的图片时不替换", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-status-photos-"));
  try {
    const root = join(directory, "theme");
    const backgrounds = join(root, "state/img/bg");
    await mkdir(backgrounds, { recursive: true });
    await writeFile(join(backgrounds, "a-invalid.png"), "not a real image");
    await writeFile(join(backgrounds, "b-red.png"), onePixel);
    await writeFile(join(backgrounds, "z-blue.png"), twoPixels);
    await writeFile(join(root, "outside.png"), onePixel);
    await symlink(join(root, "outside.png"), join(backgrounds, "x-escape.png"));
    expect((await loadStatusBackground(root, "b-red.png"))?.width).toBe(1);
    expect((await loadStatusBackground(root, "z-blue.png"))?.width).toBe(2);
    expect((await loadStatusBackground(root, "random", () => 0))?.width).toBe(1);
    expect((await loadStatusBackground(root, "random", count => count - 1))?.width).toBe(2);
    expect(await loadStatusBackground(root, "x-escape.png")).toBeUndefined();
    expect(await loadStatusBackground(root, "missing.jpg")).toBeUndefined();
    expect(await loadStatusBackground(root, "../outside.png")).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
