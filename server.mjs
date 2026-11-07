import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const publicDir = resolve(__dirname, 'dist')
loadDotEnv(resolve(__dirname, '.env'))

// Read .env before deriving defaults so local configuration is effective.
const defaultOutputDir = resolve(process.env.OPENCLAW_IMAGE_OUTPUT_DIR || '/home/huan/.openclaw/workspace/outputs/openai-image-chat')
const promptCasesCacheFile = resolve(process.env.PROMPT_CASES_CACHE_FILE || join(__dirname, 'data', 'prompt-cases-cache.json'))
const promptCasesSourceUrl = 'https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/cases.json'
const promptCasesRefreshMs = 6 * 60 * 60 * 1000
let promptCasesCache = null
let promptCasesLastCheckedAt = 0
const publicBaseUrl = trimTrailingSlash(process.env.PUBLIC_BASE_URL || '')

const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 8787)
const defaultBaseUrl = trimTrailingSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
let defaultChatModel = process.env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini'
const defaultImageModel = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2'
const supportedImageModels = [
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-1.5',
  'gpt-image-1-mini',
  'gpt-image-2.6-flare',
  'gpt-image-2.6-sunburst',
  'chatgpt-image-latest',
]
const defaultChatApiKey = process.env.OPENAI_CHAT_API_KEY || process.env.OPENAI_API_KEY || ''
const defaultImageApiKey = process.env.OPENAI_IMAGE_API_KEY || process.env.OPENAI_API_KEY || ''
const allowedChatModels = new Set([
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.5-xhigh',
])

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
  '.gif': 'image/gif',
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

function normalizePromptCasesPayload(payload) {
  const cases = Array.isArray(payload?.cases) ? payload.cases : []
  return cases
    .map((item) => {
      const number = Number(item?.id)
      const imagePath = String(item?.image || '').trim()
      if (!Number.isFinite(number) || !item?.title || !item?.prompt) return null
      const imageName = imagePath.split('/').pop()
      return {
        number,
        title: String(item.title),
        category: String(item.category || '未分类'),
        source: String(item.sourceLabel || item.sourceUrl || '未提供'),
        imageUrl: imageName
          ? `https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/images/${encodeURIComponent(imageName)}`
          : '',
        prompt: String(item.prompt),
      }
    })
    .filter(Boolean)
}

function readPromptCasesCache() {
  if (!existsSync(promptCasesCacheFile)) return null
  try {
    const cached = JSON.parse(readFileSync(promptCasesCacheFile, 'utf8'))
    return Array.isArray(cached?.cases) ? cached : null
  } catch {
    return null
  }
}

async function refreshPromptCases(force = false) {
  const now = Date.now()
  if (!force && promptCasesCache && now - promptCasesLastCheckedAt < promptCasesRefreshMs) {
    return promptCasesCache
  }

  if (!promptCasesCache) promptCasesCache = readPromptCasesCache()
  promptCasesLastCheckedAt = now
  try {
    const response = await fetch(promptCasesSourceUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'openai-image-chat-prompt-sync' },
    })
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`)
    const upstream = await response.json()
    const cases = normalizePromptCasesPayload(upstream)
    if (!cases.length) throw new Error('GitHub cases.json did not contain usable cases')
    promptCasesCache = {
      repository: String(upstream.repository || 'https://github.com/freestylefly/awesome-gpt-image-2'),
      totalCases: cases.length,
      sourceSha: response.headers.get('etag') || '',
      updatedAt: new Date().toISOString(),
      cases,
    }
    mkdirSync(join(__dirname, 'data'), { recursive: true })
    writeFileSync(promptCasesCacheFile, JSON.stringify(promptCasesCache, null, 2))
  } catch (error) {
    console.warn(`[PROMPT CASES] sync failed, using cache: ${error instanceof Error ? error.message : error}`)
  }
  return promptCasesCache || { repository: promptCasesSourceUrl, totalCases: 0, cases: [] }
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
  const pattern = /data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+/gi

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
      const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.exec(dataUrl)
      images.push({
        dataUrl,
        extension: match?.[1]?.toLowerCase() === 'jpg' ? 'jpeg' : match?.[1]?.toLowerCase() || 'png',
      })
    }
  }

  return images
}

function detectImageMime(buffer) {
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return { extension: 'gif', mimeType: 'image/gif' }
  }
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
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(normalized)
  if (!match) {
    throw new Error('模型返回了图片标记，但不是有效的 data:image base64。')
  }

  const buffer = Buffer.from(match[2], 'base64')
  const detected = detectImageMime(buffer)
  if (!detected) {
    throw new Error('模型返回的 base64 不是有效的 PNG/JPEG/WebP/GIF 图片。')
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

async function buildImageEditMultipart(formData) {
  const boundary = `----openai-image-chat-${Math.random().toString(16).slice(2)}`
  const parts = []

  for (const [key, value] of formData.entries()) {
    if ((key === 'image' || key === 'image[]') && typeof value !== 'string') {
      const type = value.type === 'image/jpeg' || value.type === 'image/webp' ? value.type : 'image/png'
      const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png'
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference-image.${extension}"\r\nContent-Type: ${type}\r\n\r\n`))
      parts.push(Buffer.from(await value.arrayBuffer()))
      parts.push(Buffer.from('\r\n'))
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`))
    }
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
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

    // Model IDs are stored as an unquoted .env value; reject line breaks and
    // configuration metacharacters while allowing provider namespaces and aliases.
    if (nextChatModel.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(nextChatModel)) {
      sendJson(res, 400, { error: { message: '聊天模型名称格式无效。' } })
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
      imageModels: supportedImageModels,
      chatModels: [...allowedChatModels],
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
    const requestContentType = req.headers['content-type'] || ''
    console.log(`[PROXY] ${targetPath} content-type=${requestContentType} bytes=${body.length}`)
    let upstreamBody = body.length ? body : undefined
    const upstreamHeaders = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }

    // Rebuild multipart requests so the upstream receives a fresh boundary
    // and an explicit image/* part instead of application/octet-stream.
    if (targetPath === '/images/edits' && requestContentType.toLowerCase().startsWith('multipart/form-data;')) {
      const incoming = new Request(`http://localhost${targetPath}`, {
        method: 'POST',
        headers: { 'content-type': requestContentType },
        body,
      })
      const incomingForm = await incoming.formData()
      const upstreamForm = new FormData()
      for (const [key, value] of incomingForm.entries()) {
        if ((key !== 'image' && key !== 'image[]') || typeof value === 'string') {
          upstreamForm.append(key, String(value))
          continue
        }

        const sourceType = value.type === 'image/jpeg' || value.type === 'image/png' || value.type === 'image/webp'
          ? value.type
          : 'image/png'
        const imageBytes = await value.arrayBuffer()
        const extension = sourceType === 'image/jpeg' ? 'jpg' : sourceType === 'image/webp' ? 'webp' : 'png'
        // Use File (not only Blob) so both the filename and MIME type are
        // encoded in the multipart part. Some OpenAI-compatible gateways
        // inspect the part metadata and classify a Blob as octet-stream.
        const imageFile = new File([imageBytes], `reference-image.${extension}`, { type: sourceType })
        // Keep the standard OpenAI field name. Some compatible gateways
        // accept `image[]`, but JuCode's edit endpoint only recognizes
        // `image`; normalizing it here also makes old clients work.
        upstreamForm.append('image', imageFile)
      }
      // Let undici encode the FormData. It supplies the boundary and the
      // File part's image/* MIME header; hand-rolling this body caused some
      // compatible gateways to reclassify image[0] as octet-stream.
      upstreamBody = upstreamForm
    } else {
      upstreamHeaders['Content-Type'] = req.headers['content-type'] || 'application/json'
    }

    const upstreamResponse = await fetch(`${baseUrl}${targetPath}`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: upstreamBody,
    })

    const contentType = upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8'
    const text = await upstreamResponse.text()
    if (!upstreamResponse.ok) {
      console.error(`[UPSTREAM] ${targetPath} status=${upstreamResponse.status} response=${text.slice(0, 1000)}`)
    }

    if (upstreamResponse.ok && (targetPath === '/images/generations' || targetPath === '/images/edits')) {
      try {
        const result = JSON.parse(text)
        if (Array.isArray(result.data)) {
          for (const item of result.data) {
            try {
              let dataUrl = ''
              if (typeof item?.b64_json === 'string' && item.b64_json.trim()) {
                dataUrl = `data:image/png;base64,${item.b64_json}`
              } else if (typeof item?.url === 'string' && item.url.startsWith('data:image/')) {
                dataUrl = item.url
              } else if (typeof item?.url === 'string') {
                // Do not fetch arbitrary upstream URLs from the server (SSRF risk).
                item.openclaw_save_error = '图片以远程链接返回，未自动归档，请手动下载。'
              }
              if (dataUrl) {
                const saved = saveDataImage(dataUrl, { prefix: targetPath.endsWith('/edits') ? 'edit' : 'generated' })
                item.openclaw_saved_filename = saved.filename
              }
            } catch (error) {
              item.openclaw_save_error = '图片归档失败，请立即手动下载。'
              console.error(`[ARCHIVE] ${targetPath}: ${error instanceof Error ? error.message : error}`)
            }
          }
        }
        res.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(result))
        return
      } catch (error) {
        console.error(`[ARCHIVE] ${targetPath}: ${error instanceof Error ? error.message : error}`)
        res.writeHead(upstreamResponse.status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Image-Archive-Error': 'save-failed' })
        res.end(text)
        return
      }
    }

    res.writeHead(upstreamResponse.status, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    })
    res.end(text)
  } catch (error) {
    const msg = error instanceof Error ? error.message : '代理请求失败。'
    console.error(`[ERROR] /api/openai${targetPath}: ${msg}`)
    sendJson(res, 502, {
      error: { message: msg },
    })
  }
}

function parseSSEResponse(text) {
  const lines = text.split('\n')
  let lastJson = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data: ') && !trimmed.startsWith('data: [DONE]')) {
      try {
        lastJson = JSON.parse(trimmed.slice(6))
      } catch {
        // skip unparseable SSE lines
      }
    }
  }
  return lastJson
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
    data = text ? parseSSEResponse(text) : null
  }

  if (!upstreamResponse.ok) {
    const message = data?.error?.message || text || `上游接口返回 HTTP ${upstreamResponse.status}`
    throw new Error(message)
  }

  return data
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
  console.log(`[REQUEST] ${req.method} ${url.pathname}`)

  if (url.pathname === '/api/archive-image' && req.method === 'POST') {
    try {
      const { dataUrl } = JSON.parse((await readBody(req)).toString('utf8'))
      const saved = saveDataImage(dataUrl, { prefix: 'generated' })
      sendJson(res, 200, { filename: saved.filename })
    } catch (error) {
      console.error(`[ARCHIVE] browser image: ${error instanceof Error ? error.message : error}`)
      sendJson(res, 500, { error: { message: '图片归档失败，请手动下载。' } })
    }
    return
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === '/api/config') {
    sendJson(res, 200, {
      defaultBaseUrl,
      defaultChatModel,
      defaultImageModel,
      imageModels: supportedImageModels,
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

  if (url.pathname === '/api/prompt-cases') {
    const force = url.searchParams.get('refresh') === '1'
    const data = await refreshPromptCases(force)
    sendJson(res, 200, { ...data, sourceUrl: promptCasesSourceUrl, cached: Boolean(promptCasesCache) })
    return
  }

  if (url.pathname.startsWith('/api/openai/')) {
    await handleOpenAIProxy(req, res, url.pathname)
    return
  }

  handleStatic(req, res, url.pathname)
})

server.listen(port, host, () => {
  void refreshPromptCases(false)
  console.log(`openai-image-chat running on http://${host}:${port}`)
  console.log(`Default OpenAI base URL: ${defaultBaseUrl}`)
  console.log(`Default chat model: ${defaultChatModel}`)
  console.log(`Default image model: ${defaultImageModel}`)
})
