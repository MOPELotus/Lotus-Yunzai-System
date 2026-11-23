import { expect, test } from "bun:test";
import { statusPanelLayout } from "./status-card-renderer.ts";
import { mergeLegacyStatusConfig } from "./status-background.ts";
import { parseStatusGradient, statusCardStyle } from "./status-card-style.ts";

test("普通与 Pro 沿用旧昵称渐变、状态徽标、圆环阈值和图表配色", () => {
  const settings = mergeLegacyStatusConfig({
    style: { progressBarColor: { high: "#ff4000" }, botInfoColor: { platform: "#aabbcc" } },
  }, {
    style: { startColumn: false, BotNameColor: "gradient:271.14deg,#001bff 0.98%,rgba(255,240,0,0.8) 95%",
      progressBarColor: { low: ["#123456", "bad"], high: "#fff", medium: "#ff0" },
      redisInfoValColor: "#030405", botInfoColor: { botVersion: "#ffeedd", contacts: ["#faffff"] },
      backdrop: "https://never.invalid/" },
    chartsCfg: { color: ["#012345", "#6789ab"] },
  });
  const result = statusCardStyle(settings);
  expect(result.startColumn).toBe(false);
  expect(result.nameGradient).toEqual({ angle: 271.14, stops: [
    { color: "#001bff", position: 0.0098 }, { color: "rgba(255,240,0,0.8)", position: 0.95 },
  ] });
  expect(result.progressLow).toEqual(["#123456"]);
  expect(result.progressMedium).toBe("#ff0");
  expect(result.progressHigh).toBe("#ff4000");
  expect(result.redisValueColor).toBe("#030405");
  expect(result.botVersionColor).toBe("#ffeedd");
  expect(result.botPlatformColor).toBe("#aabbcc");
  expect(result.contactColors).toEqual(["#faffff"]);
  expect(result.chartColors).toEqual(["#012345", "#6789ab"]);
  expect(settings.style).not.toHaveProperty("backdrop");
  expect(parseStatusGradient("gradient:90deg, rgb(,,), #fff")).toBeUndefined();
  expect(parseStatusGradient("gradient:90deg, #000 70%, #fff 40%")).toBeUndefined();
});

test("旧多列高度门槛和单列偏好生效，面板完整显示", () => {
  expect(statusPanelLayout([250, 250, 250], true).columns).toBe(1);
  expect(statusPanelLayout([500, 500, 650], true).columns).toBe(2);
  expect(statusPanelLayout([800, 800, 800, 800], true).columns).toBe(3);
  expect(statusPanelLayout([1300, 1300, 1300, 1300], true).columns).toBe(4);
  expect(statusPanelLayout([1300, 1300, 1300, 1300], false).columns).toBe(1);
  expect(statusPanelLayout([900, 500, 500], true).placements)
    .toEqual([{ column: 0, y: 40 }, { column: 1, y: 40 }, { column: 1, y: 560 }]);
});
