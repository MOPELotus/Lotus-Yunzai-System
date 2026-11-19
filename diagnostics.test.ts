import { expect, test } from "bun:test";
import { createModule } from "./index.ts";

test("诊断分别显示同 QQ 的 OneBot 和原生 Milky 在线时长", () => {
  let diagnosticReads = 0;
  const { commands } = createModule({
    runtimeDiagnostics: () => {
      diagnosticReads++;
      return {
        accounts: [{ id: 42, seconds: 15 }, { id: 42, adapter: "milky", seconds: 7 }],
        plugins: [{ name: "fixture", milliseconds: 2 }],
      };
    },
  });
  const owner = { message_type: "terminal" as const, isMaster: true };
  const rows = "账号在线时长\n42　15 秒\n42　Milky　7 秒\n\n插件加载用时\nfixture　2 ms";
  expect(commands["#诊断"]("", owner)).toContain(rows);
  expect(commands["#状态"]("", owner)).toContain(rows);
  expect(commands["#诊断"]("", { ...owner, isMaster: false })).not.toContain("账号在线时长");
  expect(commands["#状态"]("", { ...owner, isMaster: false })).not.toContain("Milky");
  expect(commands["#诊断"]("既有参数", owner)).toContain(rows);
  expect(diagnosticReads).toBe(3);
});

test("Milky 诊断范围只补充无参数诊断与状态，统计仍以原主人权限为准", async () => {
  let diagnosticReads = 0;
  let live = true;
  const { commands } = createModule({
    async messageStatistics(args, context) {
      return `${args}：${context.isMaster ? "主人" : "普通"}`;
    },
    runtimeDiagnostics(context) {
      diagnosticReads++;
      expect(context).toMatchObject({ isMaster: false, runtimeDiagnosticsScope: "milky", self_id: 42 });
      if (live) return { accounts: [{ id: 42, adapter: "milky", seconds: 7 }], plugins: [] };
    },
  });
  const owner = { message_type: "private", isMaster: false, runtimeDiagnosticsScope: "milky", self_id: 42 } as const;
  expect(commands["#诊断"]("", owner)).toContain("42　Milky　7 秒");
  expect(commands["#状态"]("", owner)).toContain("42　Milky　7 秒");
  expect(commands["#诊断"]("额外参数", owner)).not.toContain("账号在线时长");
  expect(await commands["#状态"]("机器人 42", owner)).toBe("机器人 42：普通");
  expect(await commands["#统计"]("日期 20", owner)).toBe("日期 20：普通");
  expect(diagnosticReads).toBe(2);

  live = false;
  expect(commands["#诊断"]("", owner)).not.toContain("账号在线时长");
  expect(commands["#状态"]("", owner)).not.toContain("账号在线时长");
  expect(diagnosticReads).toBe(4);
});
