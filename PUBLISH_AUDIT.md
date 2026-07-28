# 发布前检查记录

检查日期：2026-07-28

## 敏感信息

- 已扫描项目源码，未发现 `sk-` 格式 API Key。
- `.gitignore` 排除 zip 包、日志、缓存和测试截图。
- API Key 由用户在扩展设置页自行配置，不写入仓库。

## 外部地址

| 地址 | 检查结果 | 说明 |
|---|---|---|
| MiniMax API 申请页 | 通过 | 可访问，作为插件引导入口 |
| MiniMax Chat Completions | 通过 | 接口地址使用 POST；直接 GET 不代表接口不可用 |
| DeepSeek Chat Completions | 通过 | 返回 401，说明服务可达但需要鉴权 |
| Chrome Side Panel 文档 | 待人工复核 | 官方文档页面可能受网络环境影响 |

## 功能说明准确性

- README 已明确当前预置 MiniMax-M3 和 DeepSeek。
- README 已说明 PDF 全文需要用户手动选择文件。
- README 已说明网页 Guide 会高亮目标元素，但不会自动执行密码、付款或危险提交。
- README 将 E2E 描述为测试脚本，不把当前环境未完成的自动化运行写成已通过结果。
