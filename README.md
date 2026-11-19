# Lotus-Yunzai 系统模块

这是 Lotus-Yunzai 的内置系统模块，由主仓通过 Git 子模块固定版本。

| 指令 | 用途 |
| --- | --- |
| `#状态` | 查看宿主运行状态和 Bun 版本 |
| `#监控` | 查看 CPU 和 RAM 采样趋势，兼容 `#椰奶监控` |
| `#帮助` | 查看系统指令 |
| `#诊断` | 查看运行时、运行时间和进程内存 |

在 [Lotus-Yunzai](https://github.com/MOPELotus/Lotus-Yunzai) 根目录运行 `bun scripts/bootstrap.ts` 初始化，再运行 `bun app.ts`。可从终端或已接入的 OneBot 私聊、群聊发送指令。

监控默认每分钟采样一次，保留最近 60 个采样点。可在状态配置的 `monitor` 下调整 `open`、`getDataInterval`（毫秒）、`saveDataNumber` 和 `openRedisSaveData`。接入 Valkey 时默认保留监控历史 12 小时。配置和本地原主题由 `LOTUS_SYSTEM_STATUS_CONFIG`、`LOTUS_SYSTEM_STATUS_THEME_DIR` 指定。无主题时返回最近一次采样的文字摘要。
