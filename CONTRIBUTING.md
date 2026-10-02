# 参与开发

支持 Windows 10/11 x64，开发要求 Node.js 22.12+。克隆仓库后运行：

```powershell
npm ci
npm test
npm start
```

修改界面后运行模拟数据检查：

```powershell
.\node_modules\.bin\electron.cmd . --smoke --smoke-no-mouse
```

报告与截图写入 `artifacts/`，不会进入 Git 或发布包。`npm run release` 生成完整 Windows 分享包；版本已存在时构建会停止，请先检查并更新版本。

`package.json` 的 `version` 使用标准语义版本，`displayVersion` 用于界面、安装包和公开发布名称；发布时同步更新版本与更新记录。

修复聊天识别、统计或安装行为时，请补充能复现问题的模拟数据测试。保持 PowerShell 安装脚本的 UTF-8 BOM，以兼容 Windows PowerShell 5.1。不要提交真实聊天日志、设置、账号文件、缓存、安装包或个人绝对路径。

问题反馈请包含状态条版本、Codex 版本、Windows 版本、复现步骤，以及设置页“运行诊断”的状态。确认是在自动跟随还是手动锁定模式，并说明是否同时打开多个 Codex 窗口。请先遮挡截图中的聊天标题、内容和账号信息；无需上传原始日志。可用 `npm run diagnose` 生成不包含聊天内容、ID 或用户路径的诊断摘要。

提交 PR 时简述具体问题、修复后的行为和验证结果。维持只读本机日志的设计，不增加遥测、账户访问或模型请求。贡献默认采用本仓库的 MIT 许可。
