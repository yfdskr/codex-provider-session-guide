# 开发、测试与打包

## 工程结构

```text
agent/                 独立后台、切换执行入口、官方启动等待程序
core/                  账号、配置、锁、进程检查、切换队列与备份
extension/src/         VS Code 命令、侧边栏与 Webview 接线
extension/webview/     管理面板 HTML / CSS / JavaScript
extension/resources/   SQLite 备份与会话同步 Python 程序
extension/test/        单元、集成和隔离真实进程测试
extension/ui-test/     Playwright 浏览器交互测试
extension/scripts/     构建与隔离的真实 VS Code 测试
docs/                  安装、故障处理、后台和切换说明
public/docs/           不安装管理器时的通用手动方法
开发计划.md             开发顺序、边界和待验收事项
```

扩展只展示界面、收集确认并调用独立后台；后台统一管理配置、代理、计划、操作锁和切换队列。不能增加第二套直接写真实配置的逻辑。

## 准备环境

开发推荐 Node.js 24、npm 和 Python 3.10+。从仓库根目录执行：

```bash
cd extension
npm ci
npm run check
npm test
npx playwright install --with-deps chromium
npm run test:ui
npm run package
```

`npm test` 会构建后台和测试程序。没有显式指定真实程序路径时，需要真实程序的可选测试跳过；不能把跳过写成已通过。历史 0.3.0 升级测试需要额外的旧安装包；源码仓库未附带时明确跳过。UI 使用模拟消息，不登录真实账号，不调用真实供应商。

打包结果在 `extension/artifacts/`。`npm run package` 使用预发布标志，仅生成 VSIX，不发布 Marketplace。

## 隔离的真实进程验证

先安装官方 Codex 与 `@dailin521/codex-provider-sync`，核对路径，再在 `extension/` 执行：

```bash
CODEX_TEST_PATH=/absolute/path/to/codex \
CODEX_SYNC_TEST_PATH=/absolute/path/to/codex-provider \
npm test
```

这些测试在临时目录内使用虚构凭据、本机模拟服务和测试对话，不切换用户实际账号。不要把真实 CODEX_HOME 指给测试，也不要把真实日志上传。

真实 VS Code 生命周期需桌面版 VS Code，并能定位已适配的官方扩展副本：

```bash
CPM_VSCODE_DESKTOP=/absolute/path/to/code \
CODEX_TEST_PATH=/absolute/path/to/codex \
CODEX_SYNC_TEST_PATH=/absolute/path/to/codex-provider \
node scripts/test-ide-reload.mjs
```

这项完整 GUI 验证需要未启用兼容入口的官方扩展副本作为源，克隆到临时目录、使用隔离 HOME 和模拟接口，检查首次启用、重载等待、切换一次重载、对话保留与原入口恢复。无图形环境需准备 Electron 依赖；仓库不重新分发官方程序。

## 扩展调试

在 VS Code 打开 `extension/`，先 `npm ci`，再按 F5。调试窗口与正常窗口可能在同一台机器上；手动调试账号或切换前请配置专用 `codexProviderManager.codexHome`，使用测试目录，不导入真实登录。

设置 `codexProviderManager.codexPath`、`pythonPath`、`nodePath`、`agentStorageRoot` 时使用当前机器的实际路径，不在提交中固定自己的用户名或服务器目录。

## 修改约定

- 当前版本只验证 Linux x64；增加官方扩展版本必须核对原程序哈希，并重新跑启用、重载切换、失败等待和撤销测试，不能只扩大版本范围。
- 后台运行目录按版本保存，不覆盖正在使用的同版本程序；修改运行代码应递增版本，扩展、协议版本标识、后台、安装包与文档保持一致。
- 写操作使用既有锁、版本检查和持久操作编号；未知结果不自动重试。
- 账号认证与第三方 API 分开，不把官方登录发送给供应商。日志不保存凭据、验证码和正文。
- 不用历史文件推断任意窗口任务可控制；跨服务器迁移继续按计划暂缓。
- 针对实际改动运行必要检查，说明通过、失败、跳过和未验证项。

## 提交和发布

提交前确认 `git status`，不加入 `.env`、auth.json、Key、真实会话、SQLite、日志、本机说明或 node_modules。测试中的 `SYNTHETIC` 值和示例地址是虚构数据。

每个版本更新 README、更新记录、兼容范围和验证报告。安装包使用 GitHub Release 附件，附 SHA-256；源码不提交旧安装包、运行状态或官方二进制。发布采用预发布标记，直到真实验收达到要求。

CI 运行配置检查、默认自动测试、浏览器测试与 VSIX 打包；隔离真实程序测试和真实账号验收单独记录，不声称 CI 覆盖它们。

发布脚本为 `scripts/publish-github.sh`，只允许登录用户 `yfdskr` 向既定仓库发布。运行前需在本机准备本次 Release 附件、核对报告并提交工作区；普通贡献者不需要执行。脚本不改写其他远程、不强推、不覆盖旧标签与 Release。GitHub CLI 不在 PATH 时可用 `GH_BIN=/实际路径/gh bash scripts/publish-github.sh`。
