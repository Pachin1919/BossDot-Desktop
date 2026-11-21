# BossDot

BossDot 是基于 [BossClaw v2.6.3](https://github.com/YanQuan-dozzy/Boss-Claw/releases/tag/v2.6.3) 二次开发的 Windows 求职工作台。它把线上意向读取、岗位与招呼语审核、定制简历和模型配置放在同一个 Electron 应用中。用户可以在桌面端操作，也可以经本机 MCP 控制桥读取状态、提交草稿和核对队列。

## BossDot 做了哪些改进

BossDot 沿用 BossClaw 的 Electron 主进程、React 和 TypeScript 界面、平台适配、岗位队列和 Skills。下表列出 BossDot 在这个底座上修改的部分。

| 领域 | BossDot 的改动 | 实现和验证入口 |
| --- | --- | --- |
| 内置浏览器 | 增加网页缩放按钮和记忆，修复 Windows 自绘标题栏拖动。仅把 HTTP(S) 链接交给系统浏览器，拦截误触发 Windows 应用选择弹窗的 `chrome-error://`。 | [BrowserView](desktop-app/src/components/BrowserView.tsx) · [桌面回归](qa/run-electron-ui-smoke.cjs) |
| 线上简历 | 从已登录的 BOSS 工作台读取求职意向、工作经历和项目经历。界面和 MCP 共用解析结果，过滤输出中的手机号等联系方式。 | [资料解析](desktop-app/src/lib/bossclaw/bossOnlineProfile.ts) · [MCP 动作](mcp/bossclaw-mcp/src/tools/control.mjs) |
| 任务可见性 | MCP 搜索可写入任务记录，日志显示成功或平台错误。对队列岗位运行分析时，将结果写回原岗位，并保留已有招呼草稿。岗位仍可由用户逐条审核。 | [控制运行时](desktop-app/src/lib/controlRuntime.ts) |
| 简历定制 | 复用原定制页和生成入口。逐句核对摘录、来源和事实，来源或复检不通过时保留预览。LangGraph 管理生成和验证节点，SQLite 保存检查点。支持 DOCX 与 PDF 导出。 | [证据检查](desktop-app/src/lib/bossclaw/tailorEvidence.ts) · [LangGraph](desktop-app/src/lib/bossclaw/tailorWorkflow.ts) · [导出与恢复回归](desktop-app/scripts/tailor-artifact-regression.mjs) |
| 模型接入 | OpenAI 官方端点使用 Responses API，兼容服务继续使用各自的协议。通过 Electron 网络栈读取系统代理，按端点取模型目录，支持搜索选择、权限和配额诊断。模型能力决定哪些控件可编辑。 | [服务商预设](desktop-app/src/lib/bossclaw/providerPresets.ts) · [请求适配](desktop-app/src/lib/bossclaw/llm.ts) · [设置页](desktop-app/src/pages/Settings.tsx) |
| Windows 桌面体验 | 使用独立的应用标识、图标和本机数据目录。更新绿色主题、导航和状态提示。保留原应用的 Skills 勾选与导入功能。 | [应用标识](desktop-app/resources/app-identity.json) · [主题](desktop-app/src/index.polish.css) · [Skills](desktop-app/src/lib/bossclaw/skills.ts) |

## 从源码构建

使用 Windows 10 或 11 和 Node.js 24。将仓库克隆到本机，运行下列命令。

```powershell
Set-Location desktop-app
npm ci
npm run package:dir
Set-Location ..
.\启动BossDot.cmd
```

在 **设置 → AI / LLM 配置** 选择服务商，填写 API Key，打开 **模型 ID** 下拉获取目录，再点 **测试连接**。到 **简历中心** 导入材料，到 **工作台 → 待确认** 检查岗位和草稿。可用的模型取决于服务商、账号和实际端点。

要通过 MCP 使用应用，运行 `启动BossDot-Agent.cmd`。加载仓库的 [MCP 配置](.mcp.json) 后，可以调用 `bossclaw_app_state` 读取状态，经 `bossclaw_app_action` 查询模型目录、读取线上资料或管理本地队列。没有配置模型 API Key 时，在线 Agent 可以通过 `bossclaw_agent_tasks` 和 `bossclaw_agent_submit` 完成支持代答的 AI 任务。执行模式在应用设置中由用户控制。

模型调用会把生成所需的提示词与选取材料发给配置的服务商。登录状态、队列、简历存储和 LangGraph 检查点保存在本机。公开仓库的回归使用合成简历和岗位资料。

## 验证

完成 Windows 源码构建后，在仓库根目录运行这些命令。

```powershell
node qa/run-electron-ui-smoke.cjs
node qa/run-bossdot-chrome-error.cjs
node desktop-app/scripts/tailor-artifact-regression.mjs
npm run selftest --prefix mcp/bossclaw-mcp
```

Windows 桌面回归使用打包程序、隔离的测试配置和本地夹具，覆盖缩放、拖动、Skills、模型目录、任务记录、来源校验及文档导出。

## 来源与引用

- **代码底座**使用 YanQuan-dozzy 等贡献者维护的 [BossClaw v2.6.3](https://github.com/YanQuan-dozzy/Boss-Claw/releases/tag/v2.6.3)。BossDot 保留 [Apache-2.0 许可证](LICENSE) 和 [上游 NOTICE](NOTICE)。原版使用文档可在 [BossClaw 仓库](https://github.com/YanQuan-dozzy/Boss-Claw/tree/v2.6.3) 查看。
- **设计参考**包括 [BossHunter](https://github.com/shengjidaguai-china/BossHunter) 的沟通草稿审核和任务跟踪。BossHunter 的实现及 PolyForm Noncommercial 许可归原项目。
- **引用 BossDot**时使用 [CITATION.cff](CITATION.cff) 中的项目、上游代码和设计参考信息。
