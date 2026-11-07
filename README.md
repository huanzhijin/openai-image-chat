# openai-image-chat

一个本地可运行、支持局域网访问的黑色系 OpenAI-compatible 聊天/画图网页。核心目标是让你快速使用 **gpt-image-2** 生成图片，同时可以在页面里切换 API Base URL、API Key 和模型名。

## 已实现功能

- 黑色系简约聊天界面
- 聊天功能：调用 `POST /chat/completions`
- 画图功能：调用 `POST /images/generations`
- 图生图功能：上传参考图后调用 `POST /images/edits`
- 默认图像模型：`gpt-image-2`
- 支持自定义：
  - API Key
  - API Base URL
  - 聊天模型
  - 图像模型
  - 图片尺寸：`1536x1024` / `1024x1536` / `1024x1024` / `auto`
  - 图片质量：`high` / `medium` / `low` / `auto`
  - 输出格式：`png` / `jpeg` / `webp`
  - 背景：`auto` / `opaque` / `transparent`
  - moderation：`auto` / `low`
  - 返回模式：`auto` / `b64_json` / `url`
  - 生成数量：1-4
- 本地 Node 代理：避免浏览器 CORS，也避免必须把 API Key 固定写进前端代码
- 服务监听 `0.0.0.0`，支持同一局域网设备访问

## 接口适配

默认按 OpenAI 官方/兼容接口风格实现：

- 聊天：`POST {BASE_URL}/chat/completions`
- 生图：`POST {BASE_URL}/images/generations`
- 图生图：`POST {BASE_URL}/images/edits`
图片生成直接调用 Jucode 图像模型的 `/images/generations`，不再通过聊天模型返回图片。图生图调用 `/images/edits`。

默认 Base URL：

```txt
https://api.openai.com/v1
```

如果你使用第三方 OpenAI-compatible 服务，把页面里的 **API Base URL** 改成对应地址即可。

## 开发运行

```bash
pnpm install
pnpm dev
```

开发服务器默认监听：

- 本机：`http://localhost:5173`
- 局域网：`http://你的局域网IP:5173`

> 开发模式下 Vite 会把 `/api` 请求代理给本地 Node 服务；需要另开一个终端启动代理：

```bash
pnpm server
```

## 推荐运行方式：生产构建 + 本地代理

```bash
pnpm install
pnpm build
pnpm start
```

默认监听：

- 本机：`http://localhost:8787`
- 局域网：`http://你的局域网IP:8787`

查看本机局域网 IP：

```bash
hostname -I
```

## 默认 Base URL / API Key 设置

在项目根目录创建 `.env` 文件即可设置默认参数：

```bash
cd /home/huan/.openclaw/master-workspace/projects/openai-image-chat
cp .env.example .env
nano .env
```

`.env` 示例：

```txt
OPENAI_API_KEY=sk-你的key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-2
HOST=0.0.0.0
PORT=8787
```

改完后重启服务：

```bash
pnpm start
```

说明：

- `OPENAI_BASE_URL` 会成为页面里的默认 API Base URL。
- `OPENAI_API_KEY` 只保存在服务端 `.env`，页面不会显示明文；页面 API Key 输入框可以留空。
- 如果页面里手动填了 API Key，会优先使用页面输入的 Key。
- 命令行环境变量优先级高于 `.env`。

## 环境变量

也可以启动前直接设置环境变量。

```bash
cp .env.example .env
```

支持变量：

```txt
OPENAI_API_KEY=你的 key，可留空并在页面输入
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-2
OPENCLAW_IMAGE_OUTPUT_DIR=/home/huan/.openclaw/workspace/outputs/openai-image-chat
PUBLIC_BASE_URL=
HOST=0.0.0.0
PORT=8787
```

直接命令行启动示例：

```bash
OPENAI_API_KEY=sk-xxx OPENAI_BASE_URL=https://api.openai.com/v1 pnpm start
```

## 局域网使用

1. 在电脑上运行：

   ```bash
   pnpm build
   pnpm start
   ```

2. 查看电脑 IP：

   ```bash
   hostname -I
   ```

3. 手机/平板/另一台电脑访问：

   ```txt
   http://电脑局域网IP:8787
   ```

如果访问不了，优先检查系统防火墙是否放行对应端口。

## 安全注意

- 内网自用可以在页面输入 API Key；如果多人共用局域网，建议只在可信网络使用。
- 如果你把 `OPENAI_API_KEY` 配在服务端，前端不会读取明文 Key，只会看到“服务端已配置”。
- 不建议直接公网暴露这个服务；如需公网使用，建议加登录鉴权和 HTTPS。

## 目录

- `src/App.tsx`：页面和业务逻辑
- `src/App.css`：黑色系界面样式
- `server.mjs`：本地静态服务 + OpenAI-compatible 代理，支持 `/chat/completions`、`/images/generations`、`/images/edits`
- `vite.config.ts`：开发服务器和局域网监听配置
- `.env.example`：环境变量示例

### GIF 动图（预览）

在绘图面板的输出格式中选择 GIF，可设置 2–16 帧和每帧时长。文生图和图生图均使用 Images API 的 `output_format=gif`、`frame_count` 和 `frame_duration_ms` 参数。生成结果可以预览、下载和归档。此功能要求所选模型及 API 服务商支持并开通 GIF 预览；第三方兼容接口可能不支持或有不同限制。GIF 不使用自定义压缩或 response_format。模型和账户的实际可用性请以上游响应为准。
