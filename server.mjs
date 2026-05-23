import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const publicDir = resolve(__dirname, 'dist')
const defaultOutputDir = resolve(process.env.OPENCLAW_IMAGE_OUTPUT_DIR || join(__dirname, 'outputs', 'openai-image-chat'))
const publicBaseUrl = trimTrailingSlash(process.env.PUBLIC_BASE_URL || '')

loadDotEnv(resolve(__dirname, '.env'))

const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 8787)
const defaultBaseUrl = trimTrailingSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
let defaultChatModel = process.env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini'
const defaultImageModel = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2'
const defaultChatApiKey = process.env.OPENAI_CHAT_API_KEY || process.env.OPENAI_API_KEY || ''
const defaultImageApiKey = process.env.OPENAI_IMAGE_API_KEY || process.env.OPENAI_API_KEY || ''
const allowedChatModels = new Set(['gpt-5.4-mini', 'gpt-5.4-xhigh', 'gpt-5.5', 'gpt-5.5-xhigh'])

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

const allowedProxyPaths = new Set([
  '/chat/completions',
  '/images/generations',
  '/images/edits',
])

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return

  const content = readFileSync(filePath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const index = line.indexOf('=')
    if (index === -1) continue

    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function updateDotEnvValue(filePath, key, value) {
  const serialized = `${key}=${value}`
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${serialized}\n`)
    return
  }

  const content = readFileSync(filePath, 'utf8')
  const lines = content.split(/\r?\n/)
  let updated = false
  const nextLines = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const index = line.indexOf('=')
    if (index === -1) return line
    const currentKey = line.slice(0, index).trim()
    if (currentKey !== key) return line
    updated = true
    return serialized
  })

  if (!updated) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== '') {
      nextLines.push(serialized)
    } else {
      nextLines.splice(Math.max(nextLines.length - 1, 0), 0, serialized)
    }
  }

  writeFileSync(filePath, `${nextLines.join('\n').replace(/\n*$/, '')}\n`)
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function normalizeDataImageUrl(value) {
  const trimmed = String(value || '').trim()
  const commaIndex = trimmed.indexOf(',')
  if (commaIndex === -1) return trimmed
  return `${trimmed.slice(0, commaIndex + 1)}${trimmed.slice(commaIndex + 1).replace(/\s+/g, '')}`
}

function extractDataImagesFromText(content) {
  const images = []
  const seen = new Set()
  const pattern = /data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+/gi

  String(content || '').replace(pattern, (match, rawExtension) => {
    const dataUrl = normalizeDataImageUrl(match)
    if (!seen.has(dataUrl)) {
      seen.add(dataUrl)
      images.push({
        dataUrl,
        extension: String(rawExtension).toLowerCase() === 'jpg' ? 'jpeg' : String(rawExtension).toLowerCase(),
      })
    }
    return ''
  })

  return images
}

function collectImagesFromOpenAIResponse(data) {
  const images = []
  if (!data || !Array.isArray(data.data)) return images

  for (const item of data.data) {
    if (typeof item?.b64_json === 'string' && item.b64_json.trim()) {
      images.push({ dataUrl: `data:image/png;base64,${item.b64_json.trim()}`, extension: 'png' })
      continue
    }
    if (typeof item?.url === 'string' && item.url.startsWith('data:image/')) {
      const dataUrl = normalizeDataImageUrl(item.url)
      const match = /^data:image\/(png|jpeg|jpg|webp);base64,/i.exec(dataUrl)
      images.push({
        dataUrl,
        extension: match?.[1]?.toLowerCase() === 'jpg' ? 'jpeg' : match?.[1]?.toLowerCase() || 'png',
      })
    }
  }

  return images
}

function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', mimeType: 'image/png' }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: 'webp', mimeType: 'image/webp' }
  }
  return null
}

function saveDataImage(dataUrl, options = {}) {
  const normalized = normalizeDataImageUrl(dataUrl)
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(normalized)
  if (!match) {
    throw new Error('模型返回了图片标记，但不是有效的 data:image base64。')
  }

  const buffer = Buffer.from(match[2], 'base64')
  const detected = detectImageMime(buffer)
  if (!detected) {
    throw new Error('模型返回的 base64 不是有效的 PNG/JPEG/WebP 图片。')
  }

  const safePrefix = sanitizeFilenamePart(options.prefix || 'chat-image') || 'chat-image'
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const filename = `${safePrefix}-${id}.${detected.extension}`
  const outputDir = resolve(options.outputDir || defaultOutputDir)
  mkdirSync(outputDir, { recursive: true })

  const filePath = resolve(outputDir, filename)
  if (!filePath.startsWith(outputDir)) {
    throw new Error('输出路径非法。')
  }

  writeFileSync(filePath, buffer)
  return {
    path: filePath,
    filename,
    mimeType: detected.mimeType,
    dataUrl: options.includeDataUrl ? `data:${detected.mimeType};base64,${buffer.toString('base64')}` : undefined,
    url: publicBaseUrl ? `${publicBaseUrl}/outputs/openai-image-chat/${encodeURIComponent(filename)}` : undefined,
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 50 * 1024 * 1024) {
        rejectBody(new Error('请求体过大，最大支持 50MB。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', rejectBody)
  })
}

function resolveStaticPath(pathname) {
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  const requestedPath = resolve(publicDir, safePath === '/' ? 'index.html' : `.${safePath}`)

  if (!requestedPath.startsWith(publicDir)) {
    return null
  }

  if (existsSync(requestedPath) && statSync(requestedPath).isFile()) {
    return requestedPath
  }

  const indexPath = join(publicDir, 'index.html')
  return existsSync(indexPath) ? indexPath : null
}

async function handleConfigUpdate(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Only PATCH/POST is allowed.' } })
    return
  }

  try {
    const rawBody = await readBody(req)
    const body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {}
    const nextChatModel = String(body.defaultChatModel || body.chatModel || '').trim()

    if (!nextChatModel) {
      sendJson(res, 400, { error: { message: '缺少 defaultChatModel。' } })
      return
    }

    if (!allowedChatModels.has(nextChatModel)) {
      sendJson(res, 400, {
        error: {
          message: `不支持的聊天模型：${nextChatModel}`,
          allowedModels: [...allowedChatModels],
        },
      })
      return
    }

    updateDotEnvValue(resolve(__dirname, '.env'), 'OPENAI_CHAT_MODEL', nextChatModel)
    defaultChatModel = nextChatModel
    process.env.OPENAI_CHAT_MODEL = nextChatModel

    sendJson(res, 200, {
      ok: true,
      defaultBaseUrl,
      defaultChatModel,
      defaultImageModel,
      hasChatApiKey: Boolean(defaultChatApiKey),
      hasImageApiKey: Boolean(defaultImageApiKey),
    })
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : '更新配置失败。',
      },
    })
  }
}

async function handleOpenAIProxy(req, res, pathname) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Only POST is allowed.' } })
    return
  }

  const targetPath = pathname.replace('/api/openai', '')
  if (!allowedProxyPaths.has(targetPath)) {
    sendJson(res, 404, { error: { message: `Unsupported proxy path: ${targetPath}` } })
    return
  }

  const baseUrl = trimTrailingSlash(req.headers['x-openai-base-url'] || defaultBaseUrl)
  const apiKey = String(
    req.headers['x-openai-chat-api-key'] ||
      req.headers['x-openai-image-api-key'] ||
      req.headers['x-openai-api-key'] ||
      (targetPath === '/chat/completions' ? defaultChatApiKey : defaultImageApiKey),
  ).trim()

  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    sendJson(res, 400, { error: { message: 'API Base URL 必须是 http(s) URL。' } })
    return
  }

  if (!apiKey) {
    sendJson(res, 401, { error: { message: '缺少 API Key：请在页面输入，或设置服务端 OPENAI_API_KEY。' } })
    return
  }

  try {
    const body = await readBody(req)
    const upstreamResponse = await fetch(`${baseUrl}${targetPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: body.length ? body : undefined,
    })

    const contentType = upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8'
    const text = await upstreamResponse.text()

    res.writeHead(upstreamResponse.status, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    })
    res.end(text)
  } catch (error) {
    sendJson(res, 502, {
      error: {
        message: error instanceof Error ? error.message : '代理请求失败。',
      },
    })
  }
}

async function callChatCompletion({ baseUrl, apiKey, payload }) {
  const upstreamResponse = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })

  const text = await upstreamResponse.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // keep text for error reporting
  }

  if (!upstreamResponse.ok) {
    const message = data?.error?.message || text || `上游接口返回 HTTP ${upstreamResponse.status}`
    throw new Error(message)
  }

  return data
}

async function handleChatImageGeneration(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Only POST is allowed.' } })
    return
  }

  const baseUrl = trimTrailingSlash(req.headers['x-openai-base-url'] || defaultBaseUrl)
  const apiKey = String(req.headers['x-openai-chat-api-key'] || req.headers['x-openai-api-key'] || defaultChatApiKey).trim()

  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    sendJson(res, 400, { error: { message: 'API Base URL 必须是 http(s) URL。' } })
    return
  }

  if (!apiKey) {
    sendJson(res, 401, { error: { message: '缺少聊天模型 API Key：请设置 OPENAI_CHAT_API_KEY 或 OPENAI_API_KEY。' } })
    return
  }

  try {
    const rawBody = await readBody(req)
    const body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {}
    const prompt = String(body.prompt || body.message || '').trim()
    if (!prompt) {
      sendJson(res, 400, { error: { message: '缺少 prompt。' } })
      return
    }

    const model = String(body.model || defaultChatModel || 'gpt-4.1-mini').trim()
    const count = Math.max(1, Math.min(Number(body.n || body.count || 1) || 1, 4))
    const size = String(body.size || '1536x1024').trim()
    const outputDir = body.outputDir ? String(body.outputDir) : defaultOutputDir
    const includeDataUrl = Boolean(body.includeDataUrl)
    const timeoutHint = body.timeoutHint ? String(body.timeoutHint) : '这次调用由自动化接口发起，请直接返回图片，不要只给绘图建议。'

    const userPrompt = [
      `请生成 ${count} 张图片。`,
      `图片尺寸/比例偏好：${size}。`,
      '必须把每张图片以 Markdown 图片或裸 data:image/png;base64,... / data:image/jpeg;base64,... 的形式返回。',
      '不要只描述图片，不要返回外链，不要省略 base64。',
      timeoutHint,
      '',
      '用户原始提示词：',
      prompt,
    ].join('\n')

    const messages = Array.isArray(body.messages)
      ? body.messages
      : [
          {
            role: 'system',
            content:
              '你是一个图片生成助手。用户请求画图时，你必须调用自身多模态/图片能力并在最终回复中直接包含生成后的 base64 data URL 图片。',
          },
          { role: 'user', content: userPrompt },
        ]

    const payload = {
      model,
      messages,
    }

    if (Number.isFinite(Number(body.temperature))) payload.temperature = Number(body.temperature)
    if (Number.isFinite(Number(body.max_tokens))) payload.max_tokens = Number(body.max_tokens)
    if (body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra)) {
      Object.assign(payload, body.extra)
    }

    const data = await callChatCompletion({ baseUrl, apiKey, payload })
    const answer = data?.choices?.[0]?.message?.content
    const rawAnswer = typeof answer === 'string' ? answer : ''
    const images = extractDataImagesFromText(rawAnswer)

    if (!images.length) {
      const directImages = collectImagesFromOpenAIResponse(data)
      images.push(...directImages)
    }

    if (!images.length) {
      sendJson(res, 502, {
        ok: false,
        error: {
          message: '聊天模型已返回，但没有解析到 base64 图片。',
          textPreview: rawAnswer.slice(0, 800),
        },
        upstream: data,
      })
      return
    }

    const saved = images.flatMap((image, index) => {
      try {
        return [
          saveDataImage(image.dataUrl, {
            outputDir,
            includeDataUrl,
            prefix: body.filenamePrefix || `chat-model-image-${index + 1}`,
          }),
        ]
      } catch {
        return []
      }
    })

    if (!saved.length) {
      sendJson(res, 502, {
        ok: false,
        error: {
          message: '聊天模型返回了图片片段，但没有任何一个是有效的 PNG/JPEG/WebP 文件。',
          textPreview: rawAnswer.slice(0, 800),
        },
        upstream: data,
      })
      return
    }

    sendJson(res, 200, {
      ok: true,
      model,
      prompt,
      count: saved.length,
      images: saved,
      text: rawAnswer.replace(/!\[[^\]]*\]\s*\(\s*data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+\s*\)/gi, '').replace(/data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+/gi, '').trim(),
      upstreamId: data?.id,
    })
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : '聊天模型生图失败。',
      },
    })
  }
}

function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Only GET/HEAD is allowed.')
    return
  }

  const filePath = resolveStaticPath(pathname)
  if (!filePath) {
    sendText(res, 404, 'dist not found. Please run `pnpm build` first.')
    return
  }

  const ext = extname(filePath).toLowerCase()
  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  createReadStream(filePath).pipe(res)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`)

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === '/api/config') {
    sendJson(res, 200, {
      defaultBaseUrl,
      defaultChatModel,
      defaultImageModel,
      chatModels: [...allowedChatModels],
      hasChatApiKey: Boolean(defaultChatApiKey),
      hasImageApiKey: Boolean(defaultImageApiKey),
    })
    return
  }

  if (url.pathname === '/api/config/chat-model') {
    await handleConfigUpdate(req, res)
    return
  }

  if (url.pathname === '/api/chat-image/generate') {
    await handleChatImageGeneration(req, res)
    return
  }

  if (url.pathname.startsWith('/api/openai/')) {
    await handleOpenAIProxy(req, res, url.pathname)
    return
  }

  handleStatic(req, res, url.pathname)
})

server.listen(port, host, () => {
  console.log(`openai-image-chat running on http://${host}:${port}`)
  console.log(`Default OpenAI base URL: ${defaultBaseUrl}`)
  console.log(`Default chat model: ${defaultChatModel}`)
  console.log(`Default image model: ${defaultImageModel}`)
})
