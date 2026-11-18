export default {
  commands: {
    "#状态": () => `Lotus-Yunzai 正在运行（Bun ${Bun.version}）`,
    "#帮助": () => [
      "Lotus-Yunzai 系统指令",
      "#状态 查看宿主运行状态",
      "#帮助 查看系统指令",
    ].join("\n"),
  },
};
