# 微信聊天分析站（WeChat Chat Insight）

选择一位好友和一个时间段，自动分析聊天节奏与关系信号，生成可执行的**策略决策树**，还能**直接向分析结果提问**。

## ✨ 两种使用方式

### 🌐 网页版（在线，任何电脑都能用）
打开 **[https://ktaxk.github.io/wechat-chat-insight/](https://ktaxk.github.io/wechat-chat-insight/)**，导入聊天记录即可分析。

> 浏览器出于安全限制无法直接读取微信，网页版通过**导入聊天记录**工作，支持三种格式：
> 1. wechat-cli 导出的 JSON（`{"messages": [...]}`）
> 2. 聊天文本：`[2026-09-17 17:40] 昵称: 内容`
> 3. CSV（含「时间 / 发送者 / 内容」三列，中英文表头均可）
>
> 发送者标记为「我 / me」的消息会被识别为你本人。文件只在你的浏览器里解析，不会上传。

### 💻 本机版（免安装 exe，自动读取微信）
从 [Releases](https://github.com/ktaxk/wechat-chat-insight/releases) 下载 `WeChatInsight.exe`，双击运行（浏览器自动打开）：
1. 选择微信账号 → 提取密钥（约 10 秒，需微信 4.x 已登录并运行，仅 Windows）
2. 搜索选择任意好友 / 群聊 → 选时间段和关系类型 → 分析

源码运行：`cd local && pip install -r requirements.txt && python server.py`（Python 3.10+）。

> ⚠️ 杀毒软件可能对 exe 误报（内存读取类工具的常见现象）。本仓库源码完全公开，可自行审计，或改用源码方式运行。

## 📊 功能

- **自动提取**（本机版）：微信 4.x 本地数据库自动解密，无需手工导出
- **分析引擎**（离线运行）：消息量 / 双方占比 / 每日节奏 / 24h 活跃分布 / 回复间隔 / 话题热度 / 主动开聊次数
- **信号灯**：绿灯（关系向好的证据）、黄灯（风险）、红灯（禁忌），每条附聊天原文佐证
- **策略决策树**：8 个场景分支（对方主动 / 我主动 / 冷场 / 情绪低落 / 推进见面 / 竞争者 / 升温节点 / 见面后），按「暧昧 / 朋友 / 职场 / 家人」四种关系生成不同策略，并自动引用对话原话
- **推进时间轴**：30 天分阶段行动路径
- **导出报告**：一键下载独立 HTML 报告
- **AI 深度分析 & 交互式问答（可选）**：填入你自己的 OpenAI 兼容 API Key 后，可生成叙事化深度分析，并就分析结果提问（"TA 对我有好感吗？""这条怎么回？"）。网页版的 Key 只保存在你的浏览器 localStorage；本机版的 Key 只保存在本机 `data/` 目录。

## 🔒 隐私

- 所有分析都在你自己的设备上完成：不注册、不收集、不存储任何聊天数据
- 网页版：聊天记录只在你的浏览器内存中处理
- 本机版：服务只绑定 127.0.0.1，密钥与配置仅存本机
- 唯一例外：启用 AI 功能时，聊天内容会发送到**你自己填写的** API 服务

## 📁 目录结构

```
├── web/                  # 前端（GitHub Pages 源，也是本机版 UI）
│   ├── index.html / style.css / app.js   # 双模式界面（本机后端 / 纯浏览器）
│   ├── engine.js         # 离线分析引擎（纯 JS，与后端同逻辑）
│   ├── importer.js       # 导入解析
│   └── llm.js            # 浏览器直连 LLM
├── local/                # 本机版后端（自动提取微信数据）
│   ├── server.py         # 纯标准库 HTTP 服务
│   ├── wechat_adapter.py # 微信适配（账户/密钥/消息）
│   ├── analysis.py       # 分析引擎（与 engine.js 同逻辑）
│   ├── ai_analysis.py    # AI 深度分析 + 检索式问答
│   └── vendor/wechat_cli # 内置解密核心（Apache-2.0，源自 wechat-cli-plus）
└── build/build_exe.bat   # PyInstaller 打包脚本
```

## 📜 合规声明

本工具仅供分析**你自己账号**的聊天记录。请勿用于读取他人设备或他人隐私，使用行为与后果由使用者自行负责。微信数据解密能力基于开源项目 [wechat-cli-plus](https://github.com/maomao3334/wechat-cli-plus)（Apache-2.0，见 `local/vendor/LICENSE`）。
