# Chrome Web Store 发布资料草稿

## 名称

PDF AI Sidebar

## 简短说明

在 Chrome PDF 阅读器中框选文字，结合整篇 PDF 上下文向 MiniMax 或 DeepSeek 提问。

## 详细说明

PDF AI Sidebar 是一个基于 Chrome Manifest V3 的 PDF 阅读助手。

- 在 PDF 中框选段落后，通过右键菜单打开侧边栏
- 默认使用 MiniMax-M3，也可切换到 DeepSeek
- 用户手动选择同一份 PDF，扩展使用 PDF.js 提取全文
- 将选中段落、PDF 全文和问题提交给用户选择的 MiniMax 或 DeepSeek
- 支持流式回答，适合解释概念、梳理上下文和总结段落作用
- API Key 由用户自行配置，不内置在扩展代码中

扩展不提供开发者自有的 AI 代理服务器，也不收集广告或遥测数据。使用前请阅读隐私政策，并确认你有权将相关 PDF 内容提交给所选 AI 服务商。

## 类别建议

生产力工具

## 隐私披露要点

处理：网页内容、用户提供内容、身份验证信息（API Key）。

用途：提供 PDF 阅读解释和 AI 问答功能。

分享对象：用户主动选择的 MiniMax 或 DeepSeek API；无开发者自有服务器。

隐私政策 URL：发布前将 `PRIVACY_POLICY.md` 发布到一个公开 HTTPS 地址后填写。
