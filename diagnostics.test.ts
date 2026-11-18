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
  expect(diagnosticReads).toBe(2);
});
