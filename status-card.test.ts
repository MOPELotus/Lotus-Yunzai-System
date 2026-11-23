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
    const { commands, aliases } = createModule({
      runtimeStatus(context, pro) {
        allowed.push(`${context.message_type}:${pro}`);
        if (context.runtimeDiagnosticsScope === "milky") return;
        return { accounts: [] };
      },
      async messageStatistics(args) { return `统计：${args}`; },
    });
    const owner = { message_type: "private", isMaster: true, self_id: 41, user_id: 42 } as const;
    const ordinary = { ...owner, isMaster: false };
    expect(await commands["#状态Pro"]("", ordinary)).toContain("仅供");
    expect(await commands["#状态Pro"]("", { ...owner, message_type: "group" })).toContain("仅供");
    expect(await commands["#状态Pro"]("", { ...owner, self_id: undefined })).toContain("仅供");
    expect(await commands["#状态Pro"]("", { ...owner, self_id: -1 })).toContain("仅供");
    expect(await commands["#状态Pro"]("", {
      message_type: "terminal", isMaster: false, runtimeDiagnosticsScope: "milky",
    })).toContain("仅供");
    expect(allowed).toEqual([]);

    expect(await commands["#状态Pro"]("", owner)).toContain("Lotus-Yunzai 运行诊断");
    expect(await commands["#状态Pro"]("", { message_type: "terminal", isMaster: true })).toContain("Lotus-Yunzai 运行诊断");
    expect(await commands["#状态Pro"]("", { ...ordinary, runtimeDiagnosticsScope: "milky" })).toContain("当前会话无法");
    expect(await commands["#状态"]("", ordinary)).toContain("Lotus-Yunzai 正在运行");
    expect(aliases).toEqual({
      "#状态pro": "#状态Pro",
      "#help": "#帮助",
      "#星铁帮助": "#帮助",
      "#星铁help": "#帮助",
      "#绝区零帮助": "#帮助",
      "#绝区零help": "#帮助",
      "#自动签到帮助": "#帮助",
    });
    expect(commands["#帮助"]()).toBe("https://www.lotusshared.cn/yunzai/");
    expect(await commands["#状态Pro"]("多余参数", owner)).toBe("用法：#状态Pro。");
    for (const name of ["#椰奶状态", "#椰奶状态Pro", "#椰奶状态pro", "#椰奶监控"]) {
      expect(Object.hasOwn(commands, name)).toBe(false);
      expect(Object.hasOwn(aliases, name)).toBe(false);
    }
    expect(await commands["#状态"]("用户 42", owner)).toBe("统计：用户 42");
    expect(allowed).toEqual(["private:true", "terminal:true", "private:true"]);
  } finally {
    if (previous === undefined) delete process.env.LOTUS_SYSTEM_STATUS_THEME_DIR;
    else process.env.LOTUS_SYSTEM_STATUS_THEME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("本地状态卡主题引用不得通过符号链接读取主题目录外的资产", async () => {
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

test("状态账号头像与在线图标读取原主题，缺失或越界时保留该状态卡主题", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-status-portrait-"));
  const theme = join(directory, "theme");
  const config = join(directory, "state.yaml");
  const previous = process.env.LOTUS_SYSTEM_STATUS_CONFIG;
  process.env.LOTUS_SYSTEM_STATUS_CONFIG = config;
  try {
    await mkdir(join(theme, "state/img/bg"), { recursive: true });
    await mkdir(join(theme, "state/icon"), { recursive: true });
    await writeFile(config, "style: {backdropDefault: 1.png}\n");
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a88YAAAAASUVORK5CYII=", "base64");
    const avatar = join(theme, "state/img/default_avatar.jpg");
    const online = join(theme, "state/icon/11.png");
    await writeFile(join(theme, "state/img/bg/1.png"), pixel);
    expect((await loadStatusCardTheme(theme))?.photo.name).toBe("1.png");
    expect((await loadStatusCardTheme(theme))?.avatar).toBeUndefined();
    expect((await loadStatusCardTheme(theme))?.online).toBeUndefined();

    await writeFile(avatar, pixel);
    await writeFile(online, pixel);
    const original = await loadStatusCardTheme(theme);
    expect(original?.avatar?.width).toBe(1);
    expect(original?.online?.width).toBe(1);

    await rm(avatar);
    await rm(online);
    const outside = join(directory, "outside.png");
    await writeFile(outside, pixel);
    await symlink(outside, avatar);
    await symlink(outside, online);
    const fallback = await loadStatusCardTheme(theme);
    expect(fallback?.photo.name).toBe("1.png");
    expect(fallback?.avatar).toBeUndefined();
    expect(fallback?.online).toBeUndefined();

    await rm(avatar);
    await rm(online);
    await writeFile(avatar, "corrupted image");
    await writeFile(online, "corrupted image");
    const corrupted = await loadStatusCardTheme(theme);
    expect(corrupted?.photo.name).toBe("1.png");
    expect(corrupted?.avatar).toBeUndefined();
    expect(corrupted?.online).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.LOTUS_SYSTEM_STATUS_CONFIG;
    else process.env.LOTUS_SYSTEM_STATUS_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("裸旧状态按全局 defaultState 分流，核心状态统计和其它消息保留原路由", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-status-config-"));
  const config = join(directory, "state.yaml");
  const previous = process.env.LOTUS_SYSTEM_STATUS_CONFIG;
  process.env.LOTUS_SYSTEM_STATUS_CONFIG = config;
  try {
    const { commands, fallback } = createModule({
      async messageStatistics(args) { return `统计：${args}`; },
    });
    const group = { message_type: "group", isMaster: false } as const;
    expect(await fallback("状态", group)).toBeUndefined();
    expect(await fallback("椰奶状态", group)).toBeUndefined();
    await writeFile(config, "defaultState: false\n");
    expect(await fallback("状态", group)).toBeUndefined();
    await writeFile(config, "defaultState: 'true'\n");
    expect(await fallback("状态", group)).toBeUndefined();
    await writeFile(config, "defaultState: true\n");
    expect(await fallback("状态", group)).toContain("Lotus-Yunzai 正在运行");
    expect(await fallback("状态 用户 42", group)).toBeUndefined();
    expect(await fallback("#状态帮助", group)).toBeUndefined();
    expect(await commands["#状态"]("用户 42", group)).toBe("统计：用户 42");
  } finally {
    if (previous === undefined) delete process.env.LOTUS_SYSTEM_STATUS_CONFIG;
    else process.env.LOTUS_SYSTEM_STATUS_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("按旧规则开放裸状态 Pro，noPro 生效时所有 Pro 拼法旁路", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-status-pro-config-"));
  const config = join(directory, "state.yaml");
  const previousConfig = process.env.LOTUS_SYSTEM_STATUS_CONFIG;
  const previousTheme = process.env.LOTUS_SYSTEM_STATUS_THEME_DIR;
  process.env.LOTUS_SYSTEM_STATUS_CONFIG = config;
  process.env.LOTUS_SYSTEM_STATUS_THEME_DIR = directory;
  try {
    const scopes: string[] = [];
    const { commands, fallback } = createModule({
      async messageStatistics(args) { return `统计：${args}`; },
      runtimeStatus(context, pro) {
        scopes.push(`${context.message_type}:${context.runtimeStatusScope}:${pro}`);
        return { accounts: [] };
      },
    });
    const oneBot = { message_type: "private", isMaster: true, self_id: 51, user_id: 52, runtimeStatusScope: "onebot" } as const;
    const milky = { ...oneBot, isMaster: false, runtimeStatusScope: "milky", runtimeDiagnosticsScope: "milky" } as const;
    const terminal = { message_type: "terminal", isMaster: true, runtimeStatusScope: "terminal" } as const;
    const ordinary = { ...oneBot, isMaster: false };
    const groupOwner = { ...oneBot, message_type: "group" } as const;
    expect(await fallback("状态pro", oneBot)).toBeUndefined();
    expect(await commands["#状态Pro"]("", ordinary)).toContain("仅供");
    expect(await commands["#状态Pro"]("", groupOwner)).toContain("仅供");
    expect(scopes).toEqual([]);

    expect(await commands["#状态Pro"]("", oneBot)).toContain("运行诊断");
    await writeFile(config, "defaultState: true\n");
    expect(await fallback("状态Pro", milky)).toContain("运行诊断");
    expect(await fallback("状态pro", milky)).toContain("运行诊断");
    expect(await commands["#状态Pro"]("", terminal)).toContain("运行诊断");
    expect(scopes).toEqual(["private:onebot:true", "private:milky:true", "private:milky:true", "terminal:terminal:true"]);
    expect(await fallback("状态pro 额外参数", milky)).toBeUndefined();
    expect(await fallback("椰奶状态Pro", oneBot)).toBeUndefined();
    expect(await fallback("状态debug", oneBot)).toBeUndefined();
    expect(await fallback("状态prodebug", groupOwner)).toBeUndefined();

    await writeFile(config, "defaultState: true\nnoPro: true\n");
    expect(await commands["#状态Pro"]("", oneBot)).toBeUndefined();
    expect(await fallback("状态pro", oneBot)).toBeUndefined();
    expect(await fallback("状态Pro", milky)).toBeUndefined();
    expect(await fallback("状态", oneBot)).toContain("正在运行");
    expect(await commands["#状态"]("群 777", oneBot)).toBe("统计：群 777");
    expect(commands["#诊断"]("", ordinary)).toContain("运行诊断");
    expect(scopes).toHaveLength(4);
    await writeFile(config, "noPro: [invalid\n");
    expect(await commands["#状态Pro"]("", terminal)).toBeUndefined();
  } finally {
    if (previousConfig === undefined) delete process.env.LOTUS_SYSTEM_STATUS_CONFIG;
    else process.env.LOTUS_SYSTEM_STATUS_CONFIG = previousConfig;
    if (previousTheme === undefined) delete process.env.LOTUS_SYSTEM_STATUS_THEME_DIR;
    else process.env.LOTUS_SYSTEM_STATUS_THEME_DIR = previousTheme;
    await rm(directory, { recursive: true, force: true });
  }
});
