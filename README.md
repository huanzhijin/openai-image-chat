# openai-image-chat

一个本地可运行、支持局域网访问的 OpenAI-compatible 聊天 / 画图网页。

它把三件事放在一起：

- 现代化前端界面
- 本地 Node 代理
- 图片生成结果落盘

适合这些场景：

- 本地调用 OpenAI 或兼容接口
- 快速体验 gpt-image-2 / 图生图
- 给 QQ、飞书、网页或其它自动化流程提供本地图片文件
- 局域网内共享一个简单的 AI 画图工作台

## 主要特性

- 黑色系简洁 UI，桌面和手机都能用
- 聊天功能：转发到 `POST /chat/completions`
- 文生图：转发到 `POST /images/generations`
- 图生图：上传参考图后转发到 `POST /images/edits`
- 聊天模型可直接返回 base64 图片并自动保存到本地
- 支持自定义：
  - API Base URL
  - API Key
  - 聊天模型
  - 图像模型
  - 图片尺寸
  - 图片质量
  - 背景模式
  - 输出格式
  - 生成数量
- 默认监听 `0.0.0.0`，可在同一局域网内访问
- 生成图片会保存到本地目录，便于后续自动化处理

## 运行效果

- 前端入口：`http://127.0.0.1:8787`
- 开发前端：`http://127.0.0.1:5173`
- 健康检查：`GET /api/health`

## 项目结构

- `src/App.tsx`：页面逻辑
- `src/App.css`：界面样式
- `src/index.css`：全局样式
- `server.mjs`：本地静态服务 + OpenAI-compatible 代理 + 图片落盘
- `vite.config.ts`：开发代理配置
- `start-openai-image-chat.sh`：一键启动脚本
- `.env.example`：环境变量示例

## 环境要求

- Node.js 18+，推荐 20+
- pnpm
- 一个可用的 OpenAI 或 OpenAI-compatible 服务

## 快速开始

```bash
cp .env.example .env
pnpm install
pnpm build
pnpm start
```

启动后访问：

- 本机：`http://127.0.0.1:8787`
- 局域网：`http://你的局域网IP:8787`

查看局域网 IP：

```bash
hostname -I
```

## 开发模式

如果你想边改前端边看效果：

```bash
pnpm dev
pnpm server
```

对应地址：

- 前端：`http://127.0.0.1:5173`
- 代理：`http://127.0.0.1:8787`

> 开发模式下，Vite 会把 `/api` 请求代理到本地 Node 服务。

## 推荐生产运行方式

```bash
pnpm build
pnpm start
```

这是最稳定的方式：

- 前端资源由 `server.mjs` 提供
- `/api` 请求由本地代理处理
- 可以直接局域网分享

## 配置说明

复制 `.env.example` 为 `.env` 后修改：

```txt
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-2
OPENCLAW_IMAGE_OUTPUT_DIR=./outputs/openai-image-chat
PUBLIC_BASE_URL=
HOST=0.0.0.0
PORT=8787
```

### 字段说明

- `OPENAI_API_KEY`
  - 服务端默认 API Key
  - 为空时，也可以在网页里手动输入
- `OPENAI_BASE_URL`
  - OpenAI 或兼容服务的根地址
  - 例如 `https://api.openai.com/v1`
- `OPENAI_CHAT_MODEL`
  - 聊天模型默认值
- `OPENAI_IMAGE_MODEL`
  - 图像模型默认值
- `OPENCLAW_IMAGE_OUTPUT_DIR`
  - 图片落盘目录
  - 默认是 `./outputs/openai-image-chat`
- `PUBLIC_BASE_URL`
  - 如果你希望保存的图片能通过 HTTP 直接访问，可以设置这个前缀
- `HOST`
  - 服务监听地址，默认 `0.0.0.0`
- `PORT`
  - 服务端口，默认 `8787`

## API 说明

### 代理 OpenAI-compatible 接口

当前代理开放这三个路径：

- `POST /api/openai/chat/completions`
- `POST /api/openai/images/generations`
- `POST /api/openai/images/edits`

请求时可通过请求头传入：

- `x-openai-base-url`
- `x-openai-api-key`
- `x-openai-chat-api-key`
- `x-openai-image-api-key`

如果不传，服务端会使用 `.env` 中的默认值。

### 聊天模型生图保存接口

`POST /api/chat-image/generate`

这个接口适合让聊天模型直接返回 base64 图片，再由本地服务自动保存到磁盘。

示例：

```bash
curl -sS http://127.0.0.1:8787/api/chat-image/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "画一只赛博朋克风格的虾，黑金配色",
    "size": "1536x1024",
    "count": 1,
    "filenamePrefix": "cyber-shrimp"
  }'
```

返回示例：

```json
{
  "ok": true,
  "model": "gpt-4.1-mini",
  "prompt": "画一只赛博朋克风格的虾，黑金配色",
  "count": 1,
  "images": [
    {
      "path": "./outputs/openai-image-chat/cyber-shrimp-xxx.png",
      "filename": "cyber-shrimp-xxx.png",
      "mimeType": "image/png"
    }
  ]
}
```

## 一键启动脚本

如果你想少敲命令，可以直接运行：

```bash
./start-openai-image-chat.sh
```

脚本会：

1. 切到项目目录
2. 检查 `pnpm`
3. 如果缺依赖则自动安装
4. 执行构建
5. 启动服务

## 局域网访问

1. 在电脑上启动服务
2. 找到本机局域网 IP
3. 手机或平板访问 `http://IP:8787`

如果访问失败，优先检查：

- 防火墙是否放行 8787
- 服务是否已经启动
- `.env` 是否配置正确
- 代理地址是否能访问上游 API

## 安全建议

- 不要把真实 API Key 提交到 GitHub
- 仓库里只保留 `.env.example`
- 如果要公网访问，建议额外加登录、HTTPS、访问控制和限流
- 如果多人共用一台机器，尽量把敏感配置放在服务端而不是浏览器里
- 如果你改了图片输出目录，请确认目录权限和暴露范围

## 开源前检查清单

建议确认下面这些内容没有被提交：

- `.env`
- 密钥
- 日志文件
- `dist/`
- `node_modules/`
- 个人 IP
- 绝对路径
- 临时产物

## 贡献

欢迎提交 Issue 和 Pull Request。贡献前建议先看：

- `CONTRIBUTING.md`
- `SECURITY.md`

## 许可证

MIT License，见 `LICENSE`。

## 反馈

如果你在兼容某个 OpenAI API 供应商时遇到问题，可以先检查：

- Base URL 是否正确
- API Key 是否有效
- 模型名是否被供应商支持
- 图片接口是否支持 `images/generations` / `images/edits`

如需新增兼容适配，也欢迎提 Issue。
