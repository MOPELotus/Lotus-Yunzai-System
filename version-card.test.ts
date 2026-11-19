import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModule } from "./index.ts";
import { versionCardSections, type RuntimeVersion } from "./version-card-data.ts";

const runtime = {
  revision: "a1b2c3d4e5f67890123456789012345678901234", modified: true,
  modules: [{ name: "system", revision: "1122334455667890123456789012345678901234" }],
} satisfies RuntimeVersion;

test("开发构建保留真实宿主提交和内置模块，正式发行记录需显式提供", () => {
  expect(versionCardSections(runtime)).toEqual([{ version: "开发构建", entries: [
    { title: "宿主提交　a1b2c3d4e5f6（有本地修改）" },
    { title: "内置模块", notes: ["system　112233445566"] },
  ] }]);

  const changes = versionCardSections({ ...runtime, version: "1.1.0", changelog: [
    { version: "1.1.0", entries: [{ title: "运行状态", notes: ["保留个人范围", ""] }] },
    { version: "1.0.0", entries: [{ title: "首期发行", notes: ["确认\u202e备注"] }] },
    { version: "1.0.0", entries: [{ title: "重复条目" }] },
    { version: "本机历史", entries: [{ title: "不读取" }] },
  ] });
  expect(changes).toHaveLength(2);
  expect(changes[0]?.entries.at(-1)).toEqual({ title: "运行状态", notes: ["保留个人范围"] });
  expect(changes[1]).toEqual({ version: "1.0.0", entries: [{ title: "首期发行", notes: ["确认 备注"] }] });
});

test("终端和缺少本地主题的普通聊天继续返回原有版本文字", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-version-theme-"));
  const previous = process.env.LOTUS_SYSTEM_VERSION_THEME_DIR;
  process.env.LOTUS_SYSTEM_VERSION_THEME_DIR = directory;
  try {
    const { commands } = createModule({ runtimeVersion: runtime });
    const terminal = commands["#版本"]("", { message_type: "terminal", isMaster: true });
    if (typeof terminal !== "string") throw new Error("终端版本应直接返回文字。");
    expect(terminal).toBe([
      "Lotus-Yunzai 版本",
      "宿主版本　开发构建",
      "宿主提交　a1b2c3d4e5f6（有本地修改）",
      "",
      "内置模块",
      "system　112233445566",
    ].join("\n"));
    expect(await commands["#版本"]("", { message_type: "group", isMaster: false })).toBe(terminal);
  } finally {
    if (previous === undefined) delete process.env.LOTUS_SYSTEM_VERSION_THEME_DIR;
    else process.env.LOTUS_SYSTEM_VERSION_THEME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
