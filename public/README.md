# Codex Provider & Session Guide

在 VS Code Codex 中切换官方登录与第三方 API，并管理原有、新建会话及备份。以 DeepRouter 为例，方法可以用于其他具备相应能力的供应商。

更新：2026-10-17。示例模型为 `gpt-6.1-sol`；实际以供应商账户权限和兼容性测试为准。

直接阅读 [操作指南](docs/通用方法.md)：配置步骤、测试命令、错误处理、每日备份，以及可直接发给 GPT 的提示词都在同一份文档里。

可视化插件见 [VS Code 扩展方案](docs/VSCode扩展方案.md)。本地开发版为 `0.6.0`，新增可撤销的本机平滑切换：首次启用后，切换账号或 API 只需重载当前窗口。已通过隔离的真实 VS Code 验证，真实账号组合继续验收。源码和安装包统一见[仓库首页](../README.md)与 GitHub Releases；未上架 Marketplace，也不包含 Chat Completions 转换服务。

## 参考工具

- [codex-provider-sync](https://github.com/Dailin521/codex-provider-sync)：会话供应商元数据同步、检查和受管备份。
- [CC Switch](https://github.com/farion1231/cc-switch)：供应商管理及部分协议转换场景，使用前核对当前版本能力。
- [Codex++](https://github.com/BigPizzaV3/CodexPlusPlus)：桌面应用增强思路；不等同于 VS Code Remote SSH 扩展。

上游实现与许可证归各项目所有。这里没有复制其实现。官方行为以 OpenAI 文档和实际客户端版本为准。
