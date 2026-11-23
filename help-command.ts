const helpAlias = /^(?:#(?:原神|星铁|绝区零)?|\/)?(?:命令|帮助|菜单|help|说明|功能|指令|使用说明)$/u;

export function isSystemHelpAlias(message: string): boolean {
  return helpAlias.test(message.trim());
}
