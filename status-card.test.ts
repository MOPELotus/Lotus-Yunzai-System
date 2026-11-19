import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModule } from "./index.ts";
import { loadStatusCardTheme } from "./status-card-renderer.ts";

test("状态 Pro 只接受宿主准入的主人私聊或授权终端，无旧素材保留文字", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-status-missing-"));
  const previous = process.env.LOTUS_SYSTEM_STATUS_THEME_DIR;
  process.env.LOTUS_SYSTEM_STATUS_THEME_DIR = directory;
  try {
    const allowed: string[] = [];
    const { commands } = createModule({
      runtimeStatus(context, pro) {
        allowed.push(`${context.message_type}:${pro}`);
        if (context.runtimeDiagnosticsScope === "milky") return;
        return { accounts: [] };
      },
      async messageStatistics(args) { return `统计：${args}`; },
    });
    const owner = { message_type: "private", isMaster: true, self_id: 41, user_id: 42 } as const;
    const ordinary = { ...owner, isMaster: false };
    expect(await commands["#状态pro"]("", ordinary)).toContain("仅供");
    expect(await commands["#椰奶状态pro"]("", { ...owner, message_type: "group" })).toContain("仅供");
    expect(await commands["#状态pro"]("", { ...owner, self_id: undefined })).toContain("仅供");
    expect(await commands["#状态pro"]("", { ...owner, self_id: -1 })).toContain("仅供");
    expect(await commands["#状态pro"]("", {
      message_type: "terminal", isMaster: false, runtimeDiagnosticsScope: "milky",
    })).toContain("仅供");
    expect(allowed).toEqual([]);

    expect(await commands["#椰奶状态pro"]("", owner)).toContain("Lotus-Yunzai 运行诊断");
    expect(await commands["#状态pro"]("", { message_type: "terminal", isMaster: true })).toContain("Lotus-Yunzai 运行诊断");
    expect(await commands["#状态pro"]("", { ...ordinary, runtimeDiagnosticsScope: "milky" })).toContain("当前会话无法");
    expect(await commands["#状态"]("", ordinary)).toContain("Lotus-Yunzai 正在运行");
    expect(await commands["#椰奶状态"]("", ordinary)).toContain("Lotus-Yunzai 正在运行");
    expect(await commands["#状态"]("用户 42", owner)).toBe("统计：用户 42");
    expect(allowed).toEqual(["private:true", "terminal:true", "private:true"]);
  } finally {
    if (previous === undefined) delete process.env.LOTUS_SYSTEM_STATUS_THEME_DIR;
    else process.env.LOTUS_SYSTEM_STATUS_THEME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("本地椰奶主题引用不得通过符号链接读取主题目录外的资产", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-status-theme-"));
  try {
    const theme = join(directory, "theme");
    await mkdir(join(theme, "state/img/bg"), { recursive: true });
    const outside = join(directory, "outside.jpg");
    await writeFile(outside, "outside file");
    await symlink(outside, join(theme, "state/img/bg/1.jpg"));
    expect(await loadStatusCardTheme(theme)).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
