import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Icon } from './Icon'
import { PROMPT_CASES as BUILTIN_PROMPT_CASES, PROMPT_CASE_SOURCE } from './promptCases'
import { PROMPT_INSPIRATION_CATEGORIES, PROMPT_LIBRARY_SOURCE } from './promptInspiration'

type Role = 'system' | 'user' | 'assistant'

type GeneratedImage = {
  id?: string
  url: string
  objectUrl?: string
  dataUrl?: string
  revisedPrompt?: string
  extension?: OutputFormat
}

type ChatAttachment = {
  id: string
  name: string
  mimeType: string
  dataUrl: string
  objectUrl: string
}

type RetryAction =
  | { kind: 'chat'; content: string; attachments?: ChatAttachment[] }
  | { kind: 'image'; mode: ImageMode; prompt: string; editImage?: ChatAttachment }

type ChatMessage = {
  id: string
  role: Role
  content: string
  images?: GeneratedImage[]
  imageIds?: string[]
  attachments?: ChatAttachment[]
  imagePrompt?: string
  retryAction?: RetryAction
  createdAt: number
}

type ImageHistoryItem = GeneratedImage & {
  id: string
  prompt: string
  createdAt: number
}

type ImageSize = '1024x1024' | '1536x1024' | '1024x1536' | 'auto'

type ImageQuality = 'low' | 'medium' | 'high' | 'auto'

type OutputFormat = 'png' | 'jpeg' | 'webp' | 'gif'

type ResponseMode = 'auto' | 'b64_json' | 'url'

type ImageBackground = 'auto' | 'transparent' | 'opaque'

type ImageModeration = 'auto' | 'low'

type ComposerMode = 'image' | 'edit' | 'chat'

type AppView = 'thread' | 'gallery'

type ImageMode = 'openai' | 'edit'

type PromptLibraryMode = 'templates' | 'cases'

type ServerConfig = {
  defaultBaseUrl: string
  defaultChatModel: string
  defaultImageModel: string
  chatModels?: string[]
  imageModels?: string[]
  hasChatApiKey: boolean
  hasImageApiKey: boolean
}

const CHAT_MODEL_OPTIONS = [
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.5-xhigh',
] as const
const SIZE_OPTIONS: ReadonlyArray<{ value: ImageSize; label: string; short: string; px: string; ratio: string }> = [
  { value: '1536x1024', label: '横图', short: '横 3:2', px: '1536×1024', ratio: '3 / 2' },
  { value: '1024x1536', label: '竖图', short: '竖 2:3', px: '1024×1536', ratio: '2 / 3' },
  { value: '1024x1024', label: '方图', short: '方 1:1', px: '1024×1024', ratio: '1 / 1' },
  { value: 'auto', label: '自动', short: '自动比例', px: 'auto', ratio: '4 / 3' },
]

const QUALITY_OPTIONS: ReadonlyArray<{ value: ImageQuality; label: string }> = [
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
  { value: 'auto', label: '自动' },
]

const COMPOSER_MODES: ReadonlyArray<{ value: ComposerMode; label: string; icon: 'image' | 'edit' | 'chat' }> = [
  { value: 'image', label: '生成图片', icon: 'image' },
  { value: 'edit', label: '图生图', icon: 'edit' },
  { value: 'chat', label: '聊天', icon: 'chat' },
]

const STARTER_PROMPTS = [
  '广州雨夜的街景，远处是广州塔，湿漉漉的路面倒映霓虹，电影感，35mm 镜头',
  '一只橘猫趴在旧木窗台上打盹，午后斜阳，柔和胶片质感',
  '极简风精品咖啡品牌海报，大面积留白，奶咖色调，中文标题“慢一点”',
  '俯瞰清晨云雾里的江南水乡，白墙黛瓦，水墨与写实结合',
]

const DEFAULT_PROMPT_INSPIRATION_CATEGORY_ID = PROMPT_INSPIRATION_CATEGORIES[0]?.id || 'ui'

const DEFAULT_SYSTEM_PROMPT =
  '你是一个本地网页里的 AI 助手。回答要简洁、准确、实用。涉及图片生成时，优先根据用户意图完善提示词，再调用图像模型。'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_CHAT_MODEL = CHAT_MODEL_OPTIONS[0]
const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
const IMAGE_MODEL_OPTIONS = [
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.6-flare',
  'gpt-image-2.6-sunburst',
  'chatgpt-image-latest',
  'gpt-image-1-mini',
  'gpt-image-1.5',
] as const
const MESSAGE_STORAGE_KEY = 'openai-image-chat.messages'
const MESSAGE_DB_NAME = 'openai-image-chat-db'
const MESSAGE_DB_STORE = 'messages'
const MESSAGE_DB_KEY = 'current'
const IMAGE_HISTORY_DB_KEY = 'image-history'

const createId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const createTimestamp = () => Date.now()

const DATA_IMAGE_URL_PATTERN = /data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+/gi
const MARKDOWN_DATA_IMAGE_PATTERN = /!\[[^\]]*\]\s*\(\s*data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+\s*\)/gi

const normalizeDataImageUrl = (value: string) => {
  const commaIndex = value.indexOf(',')
  if (commaIndex === -1) return value.trim()

  return `${value.slice(0, commaIndex + 1)}${value.slice(commaIndex + 1).replace(/\s+/g, '')}`
}

const getImageExtension = (url: string): OutputFormat => {
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.exec(url)
  if (!match) return 'png'
  return match[1].toLowerCase() === 'jpg' ? 'jpeg' : (match[1].toLowerCase() as OutputFormat)
}

const extractDataImagesFromText = (content: string) => {
  const images: GeneratedImage[] = []
  const seen = new Set<string>()
  let cleanedContent = content.replace(MARKDOWN_DATA_IMAGE_PATTERN, (match) => {
    const imageMatch = match.match(DATA_IMAGE_URL_PATTERN)
    if (imageMatch?.[0]) {
      const url = normalizeDataImageUrl(imageMatch[0])
      if (!seen.has(url)) {
        seen.add(url)
        images.push({ url, extension: getImageExtension(url) })
      }
    }
    return ''
  })

  cleanedContent = cleanedContent.replace(DATA_IMAGE_URL_PATTERN, (match) => {
    const url = normalizeDataImageUrl(match)
    if (!seen.has(url)) {
      seen.add(url)
      images.push({ url, extension: getImageExtension(url) })
    }
    return ''
  })

  return {
    content: cleanedContent.replace(/\n{3,}/g, '\n\n').trim(),
    images,
  }
}

const createStarterMessages = (): ChatMessage[] => [
  {
    id: createId(),
    role: 'assistant',
    content:
      '已就绪。这里是本地黑色系 AI 画图工作台：默认使用 gpt-image-2，支持文生图、图生图、OpenAI-compatible API 地址切换，并通过本地代理避免浏览器 CORS 问题。',
    createdAt: Date.now(),
  },
]

const isRole = (value: unknown): value is Role => value === 'system' || value === 'user' || value === 'assistant'

const normalizeMessagesFromValue = (value: unknown): ChatMessage[] => {
  try {
    if (!Array.isArray(value) || !value.length) return createStarterMessages()

    const restored = value
      .map((item) => {
        const message = item as Partial<ChatMessage>
        if (!isRole(message.role) || typeof message.content !== 'string') return null

        const attachments = Array.isArray(message.attachments)
          ? message.attachments
              .map((attachment) => {
                const value = attachment as Partial<ChatAttachment>
                if (typeof value.name !== 'string' || typeof value.dataUrl !== 'string') return null
                return {
                  id: typeof value.id === 'string' ? value.id : createId(),
                  name: value.name,
                  mimeType: typeof value.mimeType === 'string' ? value.mimeType : 'image/*',
                  dataUrl: value.dataUrl,
                  objectUrl: value.dataUrl,
                }
              })
              .filter(Boolean) as ChatAttachment[]
          : undefined

        const images = Array.isArray(message.images)
          ? message.images
              .map((image) => {
                const value = image as Partial<GeneratedImage>
                const stableUrl =
                  typeof value.dataUrl === 'string'
                    ? value.dataUrl
                    : typeof value.url === 'string' && !value.url.startsWith('blob:')
                      ? value.url
                      : ''
                if (!stableUrl) return null
                return {
                  id: typeof value.id === 'string' ? value.id : undefined,
                  url: stableUrl,
                  dataUrl: typeof value.dataUrl === 'string' ? value.dataUrl : undefined,
                  revisedPrompt: typeof value.revisedPrompt === 'string' ? value.revisedPrompt : undefined,
                  extension:
                    value.extension === 'png' || value.extension === 'jpeg' || value.extension === 'webp' || value.extension === 'gif'
                      ? value.extension
                      : undefined,
                }
              })
              .filter(Boolean) as GeneratedImage[]
          : undefined

        const retryAction = (() => {
          const action = message.retryAction as Partial<RetryAction> | undefined
          if (!action || typeof action.kind !== 'string') return undefined
          if (action.kind === 'chat' && typeof action.content === 'string') {
            return {
              kind: 'chat' as const,
              content: action.content,
              attachments: Array.isArray(action.attachments) ? (action.attachments as ChatAttachment[]) : undefined,
            }
          }
          if (action.kind === 'image' && typeof action.prompt === 'string') {
            return {
              kind: 'image' as const,
              mode: action.mode === 'edit' ? 'edit' : 'openai',
              prompt: action.prompt,
              editImage: action.editImage as ChatAttachment | undefined,
            }
          }
          return undefined
        })()

        return {
          id: typeof message.id === 'string' ? message.id : createId(),
          role: message.role,
          content: message.content,
          attachments: attachments?.length ? attachments : undefined,
          images: images?.length ? images : undefined,
          imageIds: Array.isArray(message.imageIds)
            ? message.imageIds.filter((id): id is string => typeof id === 'string')
            : images?.map((image) => image.id).filter((id): id is string => Boolean(id)),
          imagePrompt: typeof message.imagePrompt === 'string' ? message.imagePrompt : undefined,
          retryAction,
          createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
        }
      })
      .filter(Boolean) as ChatMessage[]

    return restored.length ? restored : createStarterMessages()
  } catch {
    return createStarterMessages()
  }
}

const restoreMessages = (): ChatMessage[] => {
  try {
    const raw = localStorage.getItem(MESSAGE_STORAGE_KEY)
    if (!raw) return createStarterMessages()
    return normalizeMessagesFromValue(JSON.parse(raw))
  } catch {
    return createStarterMessages()
  }
}

const toSerializableGeneratedImage = ({ id, url, dataUrl, revisedPrompt, extension }: GeneratedImage) => ({
  id,
  url: dataUrl || url,
  dataUrl: dataUrl || (url.startsWith('data:image/') ? url : undefined),
  revisedPrompt,
  extension,
})

const toSerializableMessages = (messages: ChatMessage[]) =>
  messages.map((message) => ({
    ...message,
    // 聊天记录像 OpenAI Chat 一样只保存文本 + 图片引用；大图数据存在独立图片库，刷新后按 imageIds 回填。
    attachments: undefined,
    images: undefined,
    imageIds: message.imageIds || message.images?.map((image) => image.id).filter(Boolean),
    retryAction: message.retryAction
      ? {
          ...message.retryAction,
          attachments:
            message.retryAction.kind === 'chat'
              ? message.retryAction.attachments?.map(({ id, name, mimeType, dataUrl }) => ({
                  id,
                  name,
                  mimeType,
                  dataUrl,
                  objectUrl: dataUrl,
                }))
              : undefined,
          editImage:
            message.retryAction.kind === 'image' && message.retryAction.editImage
              ? {
                  ...message.retryAction.editImage,
                  objectUrl: message.retryAction.editImage.dataUrl,
                }
              : undefined,
        }
      : undefined,
  }))

const toSerializableImageHistory = (history: ImageHistoryItem[]) =>
  history.map((item) => ({
    ...toSerializableGeneratedImage(item),
    id: item.id,
    prompt: item.prompt,
    createdAt: item.createdAt,
  }))

const persistMessages = (messages: ChatMessage[]) => {
  try {
    localStorage.setItem(MESSAGE_STORAGE_KEY, JSON.stringify(toSerializableMessages(messages)))
  } catch {
    // localStorage 容量很小，大图历史以 IndexedDB 为准。
  }
}

const openMessageDb = () =>
  new Promise<IDBDatabase>((resolveDb, rejectDb) => {
    if (typeof indexedDB === 'undefined') {
      rejectDb(new Error('IndexedDB is not available'))
      return
    }

    const request = indexedDB.open(MESSAGE_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(MESSAGE_DB_STORE)) {
        db.createObjectStore(MESSAGE_DB_STORE)
      }
    }
    request.onsuccess = () => resolveDb(request.result)
    request.onerror = () => rejectDb(request.error || new Error('打开 IndexedDB 失败'))
  })

const saveValueToIndexedDb = async (key: string, value: unknown) => {
  const db = await openMessageDb()
  await new Promise<void>((resolveSave, rejectSave) => {
    const transaction = db.transaction(MESSAGE_DB_STORE, 'readwrite')
    const store = transaction.objectStore(MESSAGE_DB_STORE)
    store.put(value, key)
    transaction.oncomplete = () => resolveSave()
    transaction.onerror = () => rejectSave(transaction.error || new Error('保存 IndexedDB 失败'))
  }).finally(() => db.close())
}

const loadValueFromIndexedDb = async (key: string) => {
  const db = await openMessageDb()
  return new Promise<unknown>((resolveLoad, rejectLoad) => {
    const transaction = db.transaction(MESSAGE_DB_STORE, 'readonly')
    const store = transaction.objectStore(MESSAGE_DB_STORE)
    const request = store.get(key)
    request.onsuccess = () => resolveLoad(request.result)
    request.onerror = () => rejectLoad(request.error || new Error('读取 IndexedDB 失败'))
  }).finally(() => db.close())
}

const deleteValueFromIndexedDb = async (key: string) => {
  const db = await openMessageDb()
  await new Promise<void>((resolveClear, rejectClear) => {
    const transaction = db.transaction(MESSAGE_DB_STORE, 'readwrite')
    const store = transaction.objectStore(MESSAGE_DB_STORE)
    store.delete(key)
    transaction.oncomplete = () => resolveClear()
    transaction.onerror = () => rejectClear(transaction.error || new Error('清空 IndexedDB 失败'))
  }).finally(() => db.close())
}

const saveMessagesToIndexedDb = (messages: ChatMessage[]) =>
  saveValueToIndexedDb(MESSAGE_DB_KEY, toSerializableMessages(messages))

const loadMessagesFromIndexedDb = async () => {
  const value = await loadValueFromIndexedDb(MESSAGE_DB_KEY)

  if (!Array.isArray(value) || !value.length) return null

  return normalizeMessagesFromValue(value)
}

const clearMessagesFromIndexedDb = () => deleteValueFromIndexedDb(MESSAGE_DB_KEY)

const normalizeImageHistory = (value: unknown): ImageHistoryItem[] => {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => {
      const image = item as Partial<ImageHistoryItem>
      const stableUrl =
        typeof image.dataUrl === 'string'
          ? image.dataUrl
          : typeof image.url === 'string' && !image.url.startsWith('blob:')
            ? image.url
            : ''
      if (!stableUrl) return null

      return {
        id: typeof image.id === 'string' ? image.id : createId(),
        url: stableUrl,
        dataUrl: typeof image.dataUrl === 'string' ? image.dataUrl : undefined,
        revisedPrompt: typeof image.revisedPrompt === 'string' ? image.revisedPrompt : undefined,
        extension:
          image.extension === 'png' || image.extension === 'jpeg' || image.extension === 'webp' || image.extension === 'gif'
            ? image.extension
            : getImageExtension(stableUrl),
        prompt: typeof image.prompt === 'string' ? image.prompt : image.revisedPrompt || '生成图片',
        createdAt: typeof image.createdAt === 'number' ? image.createdAt : Date.now(),
      }
    })
    .filter(Boolean) as ImageHistoryItem[]
}

const saveImageHistoryToIndexedDb = (history: ImageHistoryItem[]) =>
  saveValueToIndexedDb(IMAGE_HISTORY_DB_KEY, toSerializableImageHistory(history))

const loadImageHistoryFromIndexedDb = async () => normalizeImageHistory(await loadValueFromIndexedDb(IMAGE_HISTORY_DB_KEY))

const createImageHistoryFromMessages = (messages: ChatMessage[]): ImageHistoryItem[] =>
  messages.flatMap((message) =>
    (message.images || []).map((image) => ({
      ...image,
      id: image.id || createId(),
      prompt: image.revisedPrompt || message.imagePrompt || message.content || '生成图片',
      createdAt: message.createdAt,
    })),
  )

const readLocal = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`))
    reader.readAsDataURL(file)
  })

const normalizeImageFileForEdit = (file: File) =>
  new Promise<File>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) {
        reject(new Error('浏览器不支持图片转换，无法准备图生图参考图。'))
        return
      }
      context.drawImage(image, 0, 0)
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('参考图转换失败，请重新选择 PNG、JPEG 或 WebP 图片。'))
          return
        }
        resolve(new File([blob], 'reference-image.png', { type: 'image/png' }))
      }, 'image/png')
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('无法读取参考图，请选择有效的 PNG、JPEG 或 WebP 图片。'))
    }
    image.src = objectUrl
  })

const buildChatAttachments = async (files: File[]) =>
  Promise.all(
    files.slice(0, 4).map(async (file) => {
      const dataUrl = await readFileAsDataUrl(file)
      const objectUrl = URL.createObjectURL(file)
      return {
        id: createId(),
        name: file.name,
        mimeType: file.type || 'image/*',
        dataUrl,
        objectUrl,
      }
    }),
  )


function App() {
  const [serverConfig, setServerConfig] = useState<ServerConfig>({
    defaultBaseUrl: DEFAULT_BASE_URL,
    defaultChatModel: DEFAULT_CHAT_MODEL,
    defaultImageModel: DEFAULT_IMAGE_MODEL,
    hasChatApiKey: false,
    hasImageApiKey: false,
  })
  const [chatApiKey, setChatApiKey] = useState(() => readLocal('openai-image-chat.chatApiKey', ''))
  const [imageApiKey, setImageApiKey] = useState(() => readLocal('openai-image-chat.imageApiKey', ''))
  const [baseUrl, setBaseUrl] = useState(() => readLocal('openai-image-chat.baseUrl', DEFAULT_BASE_URL))
  const [chatModel, setChatModel] = useState(() => readLocal('openai-image-chat.chatModel', DEFAULT_CHAT_MODEL))
  const [saveChatModelAsDefault, setSaveChatModelAsDefault] = useState(false)
  const [isSavingDefaultChatModel, setIsSavingDefaultChatModel] = useState(false)
  const [imageModel, setImageModel] = useState(() => readLocal('openai-image-chat.imageModel', DEFAULT_IMAGE_MODEL))
  const [composerMode, setComposerMode] = useState<ComposerMode>(() => {
    const saved = readLocal('openai-image-chat.composerMode', 'image')
    return saved === 'chat' || saved === 'edit' ? saved : 'image'
  })
  const imageMode: ImageMode = composerMode === 'edit' ? 'edit' : 'openai'
  const [responseMode, setResponseMode] = useState<ResponseMode>('auto')
  const [imageSize, setImageSize] = useState<ImageSize>('1536x1024')
  const [imageQuality, setImageQuality] = useState<ImageQuality>('high')
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('png')
  const [frameCount, setFrameCount] = useState(9)
  const [frameDuration, setFrameDuration] = useState(200)
  const [background, setBackground] = useState<ImageBackground>('auto')
  const [moderation, setModeration] = useState<ImageModeration>('auto')
  const [imageCount, setImageCount] = useState(1)
  const [outputCompression, setOutputCompression] = useState(90)
  const [systemPrompt, setSystemPrompt] = useState(() => readLocal('openai-image-chat.systemPrompt', DEFAULT_SYSTEM_PROMPT))
  const [chatInput, setChatInput] = useState('')
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([])
  const [imagePrompt, setImagePrompt] = useState('一幅广州雨天的写实城市风景图，广州塔远景，地面有雨水反光，电影感。')
  const [selectedPromptCategoryId, setSelectedPromptCategoryId] = useState(() =>
    readLocal('openai-image-chat.promptCategoryId', DEFAULT_PROMPT_INSPIRATION_CATEGORY_ID),
  )
  const [rawSelectedPromptTitle, setRawSelectedPromptTitle] = useState('')
  const [promptSearch, setPromptSearch] = useState(() => readLocal('openai-image-chat.promptSearch', ''))
  const [promptLibraryMode, setPromptLibraryMode] = useState<PromptLibraryMode>(
    () => (readLocal('openai-image-chat.promptLibraryMode', 'templates') === 'cases' ? 'cases' : 'templates'),
  )
  const [selectedCaseCategory, setSelectedCaseCategory] = useState(() => readLocal('openai-image-chat.caseCategory', '全部'))
  const [caseSearch, setCaseSearch] = useState(() => readLocal('openai-image-chat.caseSearch', ''))
  const [rawSelectedCaseNumber, setRawSelectedCaseNumber] = useState<number | null>(null)
  const [isPromptPreviewExpanded, setIsPromptPreviewExpanded] = useState(
    () => readLocal('openai-image-chat.promptPreviewExpanded', 'true') === 'true',
  )
  const [editImageFile, setEditImageFile] = useState<File | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>(() => restoreMessages())
  const [promptCases, setPromptCases] = useState(BUILTIN_PROMPT_CASES)
  const [promptCasesUpdatedAt, setPromptCasesUpdatedAt] = useState('')
  const [promptCasesSyncing, setPromptCasesSyncing] = useState(false)
  const [imageHistory, setImageHistory] = useState<ImageHistoryItem[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [status, setStatusText] = useState('')
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [view, setView] = useState<AppView>('thread')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryDetailOpen, setLibraryDetailOpen] = useState(false)
  const [paramsSheetOpen, setParamsSheetOpen] = useState(false)
  const [isInspectorOpen, setIsInspectorOpen] = useState(() => readLocal('openai-image-chat.inspectorOpen', 'true') === 'true')
  const [pendingSince, setPendingSince] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [isDragOver, setIsDragOver] = useState(false)
  const [previewImage, setPreviewImage] = useState<GeneratedImage | null>(null)
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const toastSeqRef = useRef(0)
  const setStatus = (text: string) => {
    setStatusText(text)
    toastSeqRef.current += 1
    setToast({ id: toastSeqRef.current, text })
  }
  const generatedImageUrlsRef = useRef<Set<string>>(new Set())
  const messagesContainerRef = useRef<HTMLElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const storageHydratedRef = useRef(false)
  const initialMessagesRef = useRef(messages)

  const generatedImageHistory = useMemo(
    () => [...imageHistory].sort((left, right) => right.createdAt - left.createdAt),
    [imageHistory],
  )

  const promptCategories = PROMPT_INSPIRATION_CATEGORIES

  const selectedPromptCategory = useMemo(
    () => promptCategories.find((category) => category.id === selectedPromptCategoryId) ?? promptCategories[0],
    [promptCategories, selectedPromptCategoryId],
  )

  const allPromptItems = useMemo(
    () => promptCategories.flatMap((category) => category.items.map((item) => ({ ...item, categoryId: category.id, categoryName: category.name }))),
    [promptCategories],
  )

  const caseCategories = useMemo(() => {
    const counts = new Map<string, number>()
    promptCases.forEach((item) => counts.set(item.category, (counts.get(item.category) ?? 0) + 1))
    return ['全部', ...Array.from(counts.entries()).sort((left, right) => right[1] - left[1]).map(([category]) => category)]
  }, [promptCases])

  const filteredPromptCases = useMemo(() => {
    const keyword = caseSearch.trim().toLowerCase()
    return promptCases.filter((item) => {
      if (selectedCaseCategory !== '全部' && item.category !== selectedCaseCategory) return false
      if (!keyword) return true
      const haystack = [item.number, item.title, item.category, item.source, item.prompt].join(' ').toLowerCase()
      return haystack.includes(keyword)
    })
  }, [caseSearch, promptCases, selectedCaseCategory])

  const selectedPromptCase = useMemo(() => {
    if (!filteredPromptCases.length) return undefined
    return filteredPromptCases.find((item) => item.number === rawSelectedCaseNumber) ?? filteredPromptCases[0]
  }, [filteredPromptCases, rawSelectedCaseNumber])

  const filteredPromptItems = useMemo(() => {
    const items = selectedPromptCategory?.items ?? []
    const keyword = promptSearch.trim().toLowerCase()
    if (!keyword) return items
    return items.filter((item) => {
      const haystack = [item.title, item.summary, item.prompt, item.tags.join(' ')].join(' ').toLowerCase()
      return haystack.includes(keyword)
    })
  }, [promptSearch, selectedPromptCategory])

  const selectedPromptTitle = useMemo(() => {
    if (!filteredPromptItems.length) return ''
    return filteredPromptItems.find((item) => item.title === rawSelectedPromptTitle)?.title ?? filteredPromptItems[0].title
  }, [filteredPromptItems, rawSelectedPromptTitle])

  const selectedPromptItem = useMemo(() => {
    if (!filteredPromptItems.length) return undefined
    return filteredPromptItems.find((item) => item.title === selectedPromptTitle) ?? filteredPromptItems[0]
  }, [filteredPromptItems, selectedPromptTitle])

  const availableChatModels = useMemo(() => {
    const models = [...CHAT_MODEL_OPTIONS]
    serverConfig.chatModels?.forEach((model) => {
      if (model && !models.includes(model as (typeof CHAT_MODEL_OPTIONS)[number])) models.push(model as (typeof CHAT_MODEL_OPTIONS)[number])
    })
    if (chatModel && !models.includes(chatModel as (typeof CHAT_MODEL_OPTIONS)[number])) models.push(chatModel as (typeof CHAT_MODEL_OPTIONS)[number])
    return models
  }, [chatModel, serverConfig.chatModels])

  const availableImageModels = useMemo(() => {
    const models: string[] = [...IMAGE_MODEL_OPTIONS]
    serverConfig.imageModels?.forEach((model) => {
      if (model && !models.includes(model)) models.push(model)
    })
    if (imageModel && !models.includes(imageModel)) models.push(imageModel)
    return models
  }, [imageModel, serverConfig.imageModels])

  const isCurrentDefaultChatModel = chatModel === serverConfig.defaultChatModel


  const messagesWithHydratedImages = useMemo(() => {
    if (!imageHistory.length) return messages
    const imageMap = new Map(imageHistory.map((image) => [image.id, image]))
    return messages.map((message) => {
      if (!message.imageIds?.length) return message
      const hydratedImages = message.imageIds.map((id) => imageMap.get(id)).filter(Boolean) as ImageHistoryItem[]
      return {
        ...message,
        images: hydratedImages.length ? hydratedImages : message.images,
      }
    })
  }, [imageHistory, messages])

  const syncPromptCases = async (force = false) => {
    setPromptCasesSyncing(true)
    try {
      const response = await fetch(`/api/prompt-cases${force ? '?refresh=1' : ''}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (Array.isArray(data.cases) && data.cases.length) {
        setPromptCases(data.cases)
        setPromptCasesUpdatedAt(data.updatedAt || '')
        setStatus(`提示词案例库已同步，共 ${data.cases.length} 个案例`)
      }
    } catch {
      // 内置案例继续可用。
    } finally {
      setPromptCasesSyncing(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    fetch('/api/prompt-cases').then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }).then((data) => {
      if (!cancelled && Array.isArray(data.cases) && data.cases.length) {
        setPromptCases(data.cases)
        setPromptCasesUpdatedAt(data.updatedAt || '')
        setStatusText(`提示词案例库已同步，共 ${data.cases.length} 个案例`)
      }
    }).catch(() => { /* 内置案例继续可用。 */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const loadServerConfig = async () => {
      try {
        const response = await fetch('/api/config')
        if (!response.ok) return
        const data = (await response.json()) as ServerConfig
        setServerConfig(data)

        const hasSavedBaseUrl = Boolean(localStorage.getItem('openai-image-chat.baseUrl'))
        const hasSavedChatModel = Boolean(localStorage.getItem('openai-image-chat.chatModel'))
        const hasSavedImageModel = Boolean(localStorage.getItem('openai-image-chat.imageModel'))

        if (!hasSavedBaseUrl && data.defaultBaseUrl) setBaseUrl(data.defaultBaseUrl)
        if (!hasSavedChatModel && data.defaultChatModel) setChatModel(data.defaultChatModel)
        if (!hasSavedImageModel && data.defaultImageModel) setImageModel(data.defaultImageModel)
      } catch {
        // 静默失败：纯静态预览时仍可显示界面，但接口调用需要本地 server.mjs。
      }
    }

    void loadServerConfig()
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.baseUrl', baseUrl)
    } catch {
      // ignore
    }
  }, [baseUrl])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.chatModel', chatModel)
    } catch {
      // ignore
    }
  }, [chatModel])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.imageModel', imageModel)
    } catch {
      // ignore
    }
  }, [imageModel])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.chatApiKey', chatApiKey)
    } catch {
      // ignore
    }
  }, [chatApiKey])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.imageApiKey', imageApiKey)
    } catch {
      // ignore
    }
  }, [imageApiKey])

  useEffect(() => {
    let cancelled = false

    const hydrateMessages = async () => {
      try {
        const storedMessages = await loadMessagesFromIndexedDb()
        const nextMessages = storedMessages?.length ? storedMessages : initialMessagesRef.current
        const storedImageHistory = await loadImageHistoryFromIndexedDb()

        if (!cancelled) {
          if (storedMessages?.length) {
            setMessages(storedMessages)
          }
          setImageHistory(storedImageHistory.length ? storedImageHistory : createImageHistoryFromMessages(nextMessages))
        }
      } catch {
        if (!cancelled) {
          setImageHistory(createImageHistoryFromMessages(initialMessagesRef.current))

        }
        // IndexedDB 不可用时继续使用 localStorage 恢复。
      } finally {
        if (!cancelled) storageHydratedRef.current = true
      }
    }

    void hydrateMessages()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!storageHydratedRef.current) return
    persistMessages(messages)
    void saveMessagesToIndexedDb(messages)
  }, [messages])

  useEffect(() => {
    if (!storageHydratedRef.current) return
    void saveImageHistoryToIndexedDb(imageHistory)
  }, [imageHistory])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.inspectorOpen', String(isInspectorOpen))
      localStorage.setItem('openai-image-chat.composerMode', composerMode)
      localStorage.setItem('openai-image-chat.systemPrompt', systemPrompt)
    } catch {
      // ignore
    }
  }, [isInspectorOpen, composerMode, systemPrompt])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (pendingSince === null) return
    const timer = window.setInterval(() => setNowTick(createTimestamp()), 1000)
    return () => window.clearInterval(timer)
  }, [pendingSince])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (previewImage) setPreviewImage(null)
      else if (libraryOpen) setLibraryOpen(false)
      else if (settingsOpen) setSettingsOpen(false)
      else if (paramsSheetOpen) setParamsSheetOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewImage, libraryOpen, settingsOpen, paramsSheetOpen])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.promptPreviewExpanded', String(isPromptPreviewExpanded))
    } catch {
      // ignore
    }
  }, [isPromptPreviewExpanded])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.promptCategoryId', selectedPromptCategoryId)
    } catch {
      // ignore
    }
  }, [selectedPromptCategoryId])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.promptSearch', promptSearch)
    } catch {
      // ignore
    }
  }, [promptSearch])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.promptLibraryMode', promptLibraryMode)
    } catch {
      // ignore
    }
  }, [promptLibraryMode])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.caseCategory', selectedCaseCategory)
    } catch {
      // ignore
    }
  }, [selectedCaseCategory])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.caseSearch', caseSearch)
    } catch {
      // ignore
    }
  }, [caseSearch])


  const editImagePreview = useMemo(() => {
    if (!editImageFile) return ''
    return URL.createObjectURL(editImageFile)
  }, [editImageFile])

  useEffect(() => {
    if (!editImagePreview) return
    return () => URL.revokeObjectURL(editImagePreview)
  }, [editImagePreview])

  const normalizedBaseUrl = useMemo(() => {
    const trimmed = baseUrl.trim()
    if (!trimmed) return ''
    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  }, [baseUrl])

  const hasCredential = Boolean(chatApiKey.trim() || imageApiKey.trim() || serverConfig.hasChatApiKey || serverConfig.hasImageApiKey)
  const canSubmit = hasCredential && normalizedBaseUrl.length > 0
  const isBusy = chatLoading || imageLoading

  const chatProxyHeaders = useMemo(() => {
    const nextHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-OpenAI-Base-URL': normalizedBaseUrl,
    }

    if (chatApiKey.trim()) {
      nextHeaders['X-OpenAI-Chat-Api-Key'] = chatApiKey.trim()
    }

    return nextHeaders
  }, [chatApiKey, normalizedBaseUrl])

  const imageProxyHeaders = useMemo(() => {
    const nextHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-OpenAI-Base-URL': normalizedBaseUrl,
    }
    if (imageApiKey.trim()) nextHeaders['X-OpenAI-Image-Api-Key'] = imageApiKey.trim()
    return nextHeaders
  }, [imageApiKey, normalizedBaseUrl])

  const imageEditProxyHeaders = useMemo(() => {
    const nextHeaders: Record<string, string> = {
      'X-OpenAI-Base-URL': normalizedBaseUrl,
    }

    if (imageApiKey.trim()) {
      nextHeaders['X-OpenAI-Image-Api-Key'] = imageApiKey.trim()
    }

    return nextHeaders
  }, [imageApiKey, normalizedBaseUrl])

  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    if (!shouldAutoScrollRef.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages])

  function cleanupGeneratedImageUrls() {
    for (const url of generatedImageUrlsRef.current) {
      URL.revokeObjectURL(url)
    }
    generatedImageUrlsRef.current.clear()
  }

  const handleMessagesScroll: React.UIEventHandler<HTMLElement> = (event) => {
    const target = event.currentTarget
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    shouldAutoScrollRef.current = distanceToBottom < 64
  }

  const openImageComposer = () => {
    setComposerMode((mode) => (mode === 'chat' ? 'image' : mode))
    setLibraryOpen(false)
    setView('thread')
    window.setTimeout(() => composerInputRef.current?.focus(), 60)
  }

  const applyPromptInspiration = (prompt: string) => {
    setImagePrompt(prompt)
    openImageComposer()
    setStatus('已将灵感模板填入绘图提示词，可继续改写后生成')
  }

  const appendPromptInspiration = (prompt: string) => {
    setImagePrompt((current) => {
      const trimmed = current.trim()
      return trimmed ? `${trimmed}\n\n${prompt}` : prompt
    })
    openImageComposer()
    setStatus('已把灵感模板追加到绘图提示词')
  }

  const applyRandomPromptInspiration = () => {
    if (!allPromptItems.length) return
    const randomItem = allPromptItems[Math.floor(Math.random() * allPromptItems.length)]
    setPromptLibraryMode('templates')
    setSelectedPromptCategoryId(randomItem.categoryId)
    setRawSelectedPromptTitle(randomItem.title)
    setIsPromptPreviewExpanded(true)
    setLibraryDetailOpen(true)
    setStatus(`已随机选择灵感模板：${randomItem.categoryName} / ${randomItem.title}`)
  }

  const applyPromptCase = (prompt: string) => {
    setImagePrompt(prompt)
    openImageComposer()
    setStatus('已将完整案例提示词填入绘图提示词，可继续改写后生成')
  }

  const appendPromptCase = (prompt: string) => {
    setImagePrompt((current) => {
      const trimmed = current.trim()
      return trimmed ? `${trimmed}\n\n${prompt}` : prompt
    })
    openImageComposer()
    setStatus('已把完整案例提示词追加到绘图提示词')
  }

  const applyRandomPromptCase = () => {
    if (!promptCases.length) return
    const randomItem = promptCases[Math.floor(Math.random() * promptCases.length)]
    setPromptLibraryMode('cases')
    setSelectedCaseCategory(randomItem.category)
    setRawSelectedCaseNumber(randomItem.number)
    setIsPromptPreviewExpanded(true)
    setLibraryDetailOpen(true)
    setStatus(`已随机选择完整案例：例 ${randomItem.number} / ${randomItem.title}`)
  }

  const pushMessage = (message: Omit<ChatMessage, 'id' | 'createdAt'>) => {
    setMessages((prev) => [
      ...prev,
      {
        ...message,
        id: createId(),
        createdAt: Date.now(),
      },
    ])
  }

  const parseError = async (response: Response) => {
    const fallback = `${response.status} ${response.statusText}`
    try {
      const data = await response.json()
      return data?.error?.message || data?.message || JSON.stringify(data)
    } catch {
      try {
        return (await response.text()) || fallback
      } catch {
        return fallback
      }
    }
  }

  const collectImages = (data: unknown) => {
    const outputMime = outputFormat === 'jpeg' ? 'jpeg' : outputFormat
    const items = Array.isArray((data as { data?: unknown[] })?.data) ? (data as { data: unknown[] }).data : []

    return items
      .map((rawItem) => {
        const item = rawItem as { b64_json?: string; url?: string; revised_prompt?: string }
        if (item?.b64_json) {
          const normalizedBase64 = item.b64_json.replace(/\s+/g, '')
          if (outputMime === 'gif' && !/^R0lGOD[dh]/.test(normalizedBase64)) {
            throw new Error('服务商没有返回 GIF 数据，可能不支持 GIF 预览。')
          }
          const dataUrl = `data:image/${outputMime};base64,${normalizedBase64}`
          const byteCharacters = atob(normalizedBase64)
          const byteNumbers = new Array(byteCharacters.length)
          for (let index = 0; index < byteCharacters.length; index += 1) {
            byteNumbers[index] = byteCharacters.charCodeAt(index)
          }
          const blob = new Blob([new Uint8Array(byteNumbers)], { type: `image/${outputMime}` })
          const objectUrl = URL.createObjectURL(blob)
          generatedImageUrlsRef.current.add(objectUrl)

          return {
            url: objectUrl,
            objectUrl,
            dataUrl,
            revisedPrompt: item.revised_prompt,
            extension: outputMime,
          }
        }
        if (item?.url) {
          return {
            url: item.url,
            revisedPrompt: item.revised_prompt,
            extension: outputFormat,
          }
        }
        return null
      })
      .filter(Boolean) as GeneratedImage[]
  }

  const archiveBrowserImage = async (image: GeneratedImage) => {
    let dataUrl = image.dataUrl || (image.url.startsWith('data:image/') ? image.url : '')
    if (!dataUrl) {
      const response = await fetch(image.url)
      if (!response.ok) throw new Error('图片链接下载失败')
      const blob = await response.blob()
      dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('图片读取失败'))
        reader.readAsDataURL(blob)
      })
    }
    const response = await fetch('/api/archive-image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }),
    })
    if (!response.ok) throw new Error('图片归档失败')
  }

  const addImagesToHistory = (images: GeneratedImage[], prompt: string, createdAt?: number) => {
    const timestamp = createdAt ?? createTimestamp()
    const historyItems = images.map((image) => ({
      ...image,
      id: image.id || createId(),
      prompt: image.revisedPrompt || prompt || '生成图片',
      createdAt: timestamp,
    }))
    if (historyItems.length) {
      setImageHistory((prev) => [...prev, ...historyItems])
    }
    return historyItems
  }

  const removeImageHistoryItem = (imageId: string) => {
    setImageHistory((prev) => prev.filter((image) => image.id !== imageId))
    setMessages((prev) =>
      prev.map((message) => ({
        ...message,
        images: message.images?.filter((image) => image.id !== imageId),
        imageIds: message.imageIds?.filter((id) => id !== imageId),
      })),
    )
    setPreviewImage((current) => (current && 'id' in current && current.id === imageId ? null : current))
    setStatus('已删除图片记录')
  }

  const handleSendChat = async (retryAction?: Extract<RetryAction, { kind: 'chat' }>) => {
    const content = (retryAction?.content ?? chatInput).trim()
    const attachments = retryAction?.attachments ?? chatAttachments
    if ((!content && !attachments.length) || !canSubmit || chatLoading) return

    const nextUserMessage: Omit<ChatMessage, 'id' | 'createdAt'> = {
      role: 'user',
      content: content || `已上传 ${attachments.length} 张图片。`,
      attachments,
    }

    const history = [...messages, { ...nextUserMessage, id: 'temp', createdAt: createTimestamp() }]

    pushMessage(nextUserMessage)
    if (!retryAction) {
      setChatInput('')
      setChatAttachments([])
    }
    setChatLoading(true)
    setView('thread')
    setStatus('聊天请求发送中…')

    try {
      const payload = {
        model: chatModel.trim() || serverConfig.defaultChatModel || DEFAULT_CHAT_MODEL,
        messages: [
          ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt.trim() }] : []),
          ...history
          .filter((item) => item.content.trim() && item.role !== 'system')
          .map((item) => {
            if (item.role === 'user' && item.attachments?.length) {
              const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = []
              if (item.content.trim()) {
                parts.push({ type: 'text', text: item.content })
              }
              item.attachments.forEach((attachment) => {
                parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl } })
              })
              return { role: item.role, content: parts }
            }
            return { role: item.role, content: item.content }
          }),
        ],
      }

      const response = await fetch('/api/openai/chat/completions', {
        method: 'POST',
        headers: chatProxyHeaders,
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        throw new Error(await parseError(response))
      }

      const data = await response.json()
      const answer = data?.choices?.[0]?.message?.content
      const rawAnswer = typeof answer === 'string' && answer.trim() ? answer.trim() : ''
      const extracted = rawAnswer ? extractDataImagesFromText(rawAnswer) : { content: '', images: [] }

      const chatArchiveResults = await Promise.allSettled(extracted.images.map(archiveBrowserImage))
      const chatArchiveFailed = chatArchiveResults.some((result) => result.status === 'rejected')
      const historyItems = addImagesToHistory(extracted.images, content)
      pushMessage({
        role: 'assistant',
        content:
          (extracted.content ||
          (historyItems.length
            ? `图片生成完成，共 ${historyItems.length} 张。`
            : '接口已返回，但没有拿到可显示的文本内容。')) + (chatArchiveFailed ? ' 注意：图片归档失败，请立即手动下载。' : ''),
        images: historyItems.length ? historyItems : undefined,
        imageIds: historyItems.map((image) => image.id),
      })
      setStatus('聊天完成')
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      pushMessage({
        role: 'assistant',
        content: `聊天失败：${message}`,
        retryAction: { kind: 'chat', content, attachments },
      })
      setStatus('聊天失败')
    } finally {
      setChatLoading(false)
    }
  }

  const buildCommonImagePayload = () => {
    const payload: Record<string, unknown> = {
      model: imageModel.trim() || serverConfig.defaultImageModel || DEFAULT_IMAGE_MODEL,
      prompt: imagePrompt.trim(),
      n: imageCount,
      size: imageSize,
      quality: imageQuality,
      output_format: outputFormat,
    }

    if (outputFormat === 'gif') {
      payload.frame_count = frameCount
      payload.frame_duration_ms = frameDuration
    }
    if (background !== 'auto') payload.background = background
    if (moderation !== 'auto') payload.moderation = moderation
    if ((outputFormat === 'jpeg' || outputFormat === 'webp') && Number.isFinite(outputCompression)) {
      payload.output_compression = outputCompression
    }
    if (responseMode !== 'auto' && outputFormat !== 'gif') {
      payload.response_format = responseMode
    }

    return payload
  }

  const handleGenerateImage = async (retryAction?: Extract<RetryAction, { kind: 'image' }>) => {
    const prompt = (retryAction?.prompt ?? imagePrompt).trim()
    const mode = retryAction?.mode ?? imageMode
    const retryEditFile = retryAction?.editImage
      ? await fetch(retryAction.editImage.dataUrl)
          .then((response) => response.blob())
          .then((blob) => new File([blob], retryAction.editImage?.name || 'retry-image.png', { type: retryAction.editImage?.mimeType || blob.type }))
      : null
    const selectedEditImageFile = retryEditFile || editImageFile
    const currentEditImageFile = mode === 'edit' && selectedEditImageFile
      ? await normalizeImageFileForEdit(selectedEditImageFile)
      : selectedEditImageFile
    if (!prompt || !canSubmit || imageLoading) return

    if (mode === 'edit' && !currentEditImageFile) {
      setStatus('图生图需要先上传一张参考图。')
      openImageComposer()
      return
    }

    pushMessage({
      role: 'user',
      content: mode === 'edit'
        ? `图生图：${prompt}`
        : `生成图片：${prompt}`,
    })

    setImageLoading(true)
    const startedAt = createTimestamp()
    setPendingSince(startedAt)
    setNowTick(startedAt)
    setView('thread')
    setStatus(mode === 'edit' ? '图生图处理中…这一步可能需要几十秒。' : '图像模型生成中…')

    try {
      let response: Response

      if (mode === 'edit' && currentEditImageFile) {
        const payload = buildCommonImagePayload()
        const formData = new FormData()
        Object.entries(payload).forEach(([key, value]) => {
          formData.append(key, String(value))
        })
        // OpenAI-compatible image-edit APIs expect the standard `image` part.
        // Sending `image[]` works with a few gateways, but JuCode rejects it
        // because it does not recognize the field as an uploaded image.
        formData.append('image', currentEditImageFile, currentEditImageFile.name || 'reference-image.png')
        response = await fetch('/api/openai/images/edits', {
          method: 'POST',
          headers: imageEditProxyHeaders,
          body: formData,
        })
      } else {
        response = await fetch('/api/openai/images/generations', {
          method: 'POST',
          headers: imageProxyHeaders,
          body: JSON.stringify({ ...buildCommonImagePayload(), model: imageModel.trim() || serverConfig.defaultImageModel || DEFAULT_IMAGE_MODEL }),
        })
      }

      if (!response.ok) {
        throw new Error(await parseError(response))
      }

      const data = await response.json()
      const images = collectImages(data)
      const archiveWarnings: string[] = []
      const items = Array.isArray(data?.data) ? data.data : []
      for (let index = 0; index < images.length; index += 1) {
        if (!items[index]?.openclaw_saved_filename) {
          try {
            await archiveBrowserImage(images[index])
          } catch {
            archiveWarnings.push(`第 ${index + 1} 张图片归档失败，请立即手动下载。`)
          }
        }
      }

      if (!images.length) {
        throw new Error('接口返回成功，但没有拿到图片数据。请尝试将“返回模式”改为 auto，或检查兼容接口实现。')
      }

      const historyItems = addImagesToHistory(images, prompt)
      pushMessage({
        role: 'assistant',
              content: `${mode === 'edit' ? '图生图' : '图像模型'}生成完成，共 ${historyItems.length} 张。${archiveWarnings.length ? ` 注意：${archiveWarnings.join(' ')}` : ''}`,
        images: historyItems,
        imageIds: historyItems.map((image) => image.id),
        imagePrompt: prompt,
      })
      setStatus(mode === 'edit' ? '图生图完成' : '图像模型生成完成')
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      const editImageRetryAttachment =
        mode === 'edit' && currentEditImageFile
          ? {
              id: createId(),
              name: currentEditImageFile.name,
              mimeType: currentEditImageFile.type || 'image/*',
              dataUrl: await readFileAsDataUrl(currentEditImageFile),
              objectUrl: URL.createObjectURL(currentEditImageFile),
            }
          : undefined
      if (editImageRetryAttachment?.objectUrl) generatedImageUrlsRef.current.add(editImageRetryAttachment.objectUrl)
      pushMessage({
        role: 'assistant',
              content: `${mode === 'edit' ? '图生图' : '图像模型'}生成失败：${message}`,
        retryAction: { kind: 'image', mode, prompt, editImage: editImageRetryAttachment },
      })
      setStatus(mode === 'edit' ? '图生图失败' : '图像模型生成失败')
    } finally {
      setImageLoading(false)
      setPendingSince(null)
    }
  }

  const handleRetry = async (action: RetryAction) => {
    if (action.kind === 'chat') {
      await handleSendChat(action)
      return
    }
    await handleGenerateImage(action)
  }

  const handleReset = () => {
    cleanupGeneratedImageUrls()
    try {
      localStorage.removeItem(MESSAGE_STORAGE_KEY)
    } catch {
      // ignore
    }
    void clearMessagesFromIndexedDb().catch(() => undefined)
    setMessages(createStarterMessages())
    setStatus('已清空聊天记录，图片记录已保留')
  }

  const handleComposerSubmit = () => {
    if (composerMode === 'chat') void handleSendChat()
    else void handleGenerateImage()
  }

  const onComposerKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
    // 触屏设备上回车换行，用发送按钮提交；桌面端 Enter 发送，Shift+Enter 换行。
    if ((!isTouch && !event.shiftKey) || event.metaKey || event.ctrlKey) {
      event.preventDefault()
      handleComposerSubmit()
    }
  }

  const setReferenceFile = (file: File) => {
    setEditImageFile(file)
    setComposerMode('edit')
    setStatus(`已设为参考图：${file.name}`)
  }

  const handleComposerDrop: React.DragEventHandler<HTMLElement> = async (event) => {
    event.preventDefault()
    setIsDragOver(false)
    const files = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    if (composerMode === 'chat') {
      const attachments = await buildChatAttachments(files.slice(0, Math.max(0, 4 - chatAttachments.length)))
      attachments.forEach((attachment) => generatedImageUrlsRef.current.add(attachment.objectUrl))
      setChatAttachments((prev) => [...prev, ...attachments])
      setStatus(`已添加 ${attachments.length} 张图片`)
      return
    }
    setReferenceFile(files[0])
  }

  const applyImageAsReference = async (image: GeneratedImage) => {
    try {
      const response = await fetch(image.dataUrl || image.url)
      const blob = await response.blob()
      setReferenceFile(new File([blob], `reference.${image.extension || 'png'}`, { type: blob.type || 'image/png' }))
      setPreviewImage(null)
      setView('thread')
      window.setTimeout(() => composerInputRef.current?.focus(), 60)
    } catch {
      setStatus('这张图片无法读取，请先下载后再手动上传。')
    }
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus('已复制提示词')
    } catch {
      setStatus('复制失败，浏览器未授权剪贴板')
    }
  }

  const reusePrompt = (text: string) => {
    setImagePrompt(text)
    openImageComposer()
    setPreviewImage(null)
    setStatus('已把提示词放回输入框')
  }

  const handleUseServerDefaults = () => {
    setBaseUrl(serverConfig.defaultBaseUrl || DEFAULT_BASE_URL)
    setChatModel(serverConfig.defaultChatModel || DEFAULT_CHAT_MODEL)
    setImageModel(serverConfig.defaultImageModel || DEFAULT_IMAGE_MODEL)
    setSaveChatModelAsDefault(false)
    setStatus('已切换为服务端默认配置')
  }

  const handleChatModelCommit = async (value: string) => {
    const nextModel = value.trim()
    if (!nextModel) {
      setChatModel(serverConfig.defaultChatModel || DEFAULT_CHAT_MODEL)
      return
    }
    setChatModel(nextModel)
    if (!saveChatModelAsDefault || nextModel === serverConfig.defaultChatModel) return

    setIsSavingDefaultChatModel(true)
    setStatus('正在更新默认聊天模型…')

    try {
      const response = await fetch('/api/config/chat-model', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultChatModel: nextModel }),
      })

      if (!response.ok) {
        throw new Error(await parseError(response))
      }

      const data = (await response.json()) as ServerConfig
      setServerConfig(data)
      setStatus(`默认聊天模型已更新为 ${nextModel}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      setStatus(`默认聊天模型更新失败：${message}`)
    } finally {
      setIsSavingDefaultChatModel(false)
    }
  }

  const handleSaveChatModelAsDefaultToggle = async (checked: boolean) => {
    setSaveChatModelAsDefault(checked)
    if (!checked || isCurrentDefaultChatModel) return

    setIsSavingDefaultChatModel(true)
    setStatus('正在保存当前聊天模型为默认值…')

    try {
      const response = await fetch('/api/config/chat-model', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultChatModel: chatModel }),
      })

      if (!response.ok) {
        throw new Error(await parseError(response))
      }

      const data = (await response.json()) as ServerConfig
      setServerConfig(data)
      setStatus(`默认聊天模型已更新为 ${chatModel}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      setStatus(`默认聊天模型更新失败：${message}`)
      setSaveChatModelAsDefault(false)
    } finally {
      setIsSavingDefaultChatModel(false)
    }
  }

  const handleEditFileChange: React.ChangeEventHandler<HTMLInputElement> = (event) => {
    const file = event.target.files?.[0] || null
    setEditImageFile(file)
    if (file) {
      setStatus(`已选择参考图：${file.name}`)
    }
  }

  const handleChatAttachmentChange: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return

    try {
      const attachments = await buildChatAttachments(files)
      attachments.forEach((attachment) => generatedImageUrlsRef.current.add(attachment.objectUrl))
      setChatAttachments((prev) => [...prev, ...attachments])
      setStatus(`已添加 ${attachments.length} 张图片到聊天输入`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片读取失败'
      setStatus(message)
    }
  }

  const handleChatPaste: React.ClipboardEventHandler<HTMLTextAreaElement> = async (event) => {
    const imageFiles = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))

    if (!imageFiles.length) return

    event.preventDefault()

    if (composerMode !== 'chat') {
      setReferenceFile(imageFiles[0])
      return
    }

    try {
      const remainingSlots = Math.max(0, 4 - chatAttachments.length)
      if (!remainingSlots) {
        setStatus('聊天输入最多附带 4 张图片，请先移除后再粘贴。')
        return
      }

      const attachments = await buildChatAttachments(imageFiles.slice(0, remainingSlots))
      attachments.forEach((attachment) => generatedImageUrlsRef.current.add(attachment.objectUrl))
      setChatAttachments((prev) => [...prev, ...attachments])
      setStatus(`已从剪贴板添加 ${attachments.length} 张图片`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '剪贴板图片读取失败'
      setStatus(message)
    }
  }

  const removeChatAttachment = (attachmentId: string) => {
    setChatAttachments((prev) => {
      const next = prev.filter((item) => item.id !== attachmentId)
      const removed = prev.find((item) => item.id === attachmentId)
      if (removed?.objectUrl) {
        URL.revokeObjectURL(removed.objectUrl)
        generatedImageUrlsRef.current.delete(removed.objectUrl)
      }
      return next
    })
  }

  const isStarterOnly =
    messagesWithHydratedImages.length === 1 &&
    messagesWithHydratedImages[0].role === 'assistant' &&
    !messagesWithHydratedImages[0].images?.length &&
    !messagesWithHydratedImages[0].retryAction
  const pendingSeconds = pendingSince ? Math.max(0, Math.floor((nowTick - pendingSince) / 1000)) : 0
  const pendingAspect = imageSize === '1536x1024' ? '3 / 2' : imageSize === '1024x1536' ? '2 / 3' : '1 / 1'
  const sizeLabel = SIZE_OPTIONS.find((option) => option.value === imageSize)?.short || imageSize
  const qualityLabel = QUALITY_OPTIONS.find((option) => option.value === imageQuality)?.label || imageQuality
  const paramSummary = `${sizeLabel} · ${qualityLabel} · ${imageCount} 张`
  const composerValue = composerMode === 'chat' ? chatInput : imagePrompt
  const composerBusy = composerMode === 'chat' ? chatLoading : imageLoading
  const composerCanSend =
    canSubmit &&
    !composerBusy &&
    (composerMode === 'chat'
      ? Boolean(chatInput.trim() || chatAttachments.length)
      : Boolean(imagePrompt.trim()) && (composerMode !== 'edit' || Boolean(editImageFile)))
  const previewIndex = previewImage?.id ? generatedImageHistory.findIndex((item) => item.id === previewImage.id) : -1
  const previewPrompt = previewImage
    ? previewImage.revisedPrompt || (previewIndex >= 0 ? generatedImageHistory[previewIndex].prompt : '')
    : ''

  const openParams = () => {
    if (window.matchMedia('(max-width: 1079px)').matches) setParamsSheetOpen(true)
    else setIsInspectorOpen(true)
  }

  const stepPreview = (delta: number) => {
    if (previewIndex < 0) return
    const next = generatedImageHistory[(previewIndex + delta + generatedImageHistory.length) % generatedImageHistory.length]
    if (next) setPreviewImage(next)
  }

  const formatTime = (value: number) =>
    new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  const splitRequestTag = (content: string) => {
    const match = /^(生成图片|图生图|请根据以下提示使生成图片|请参考上传图片进行图生图)：/.exec(content)
    if (!match) return { tag: '', text: content }
    return { tag: match[1].includes('参考') || match[1] === '图生图' ? '图生图' : '生成图片', text: content.slice(match[0].length) }
  }

  const paramsPanel = (
    <div className="params">
      <div className="params-head">
        <h2>画面参数</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            setParamsSheetOpen(false)
            if (!window.matchMedia('(max-width: 1079px)').matches) setIsInspectorOpen(false)
          }}
          aria-label="收起参数面板"
          title="收起"
        >
          <Icon name="close" />
        </button>
      </div>

      <div className="param">
        <span className="param-label">比例</span>
        <div className="size-grid" role="radiogroup" aria-label="图片尺寸">
          {SIZE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={imageSize === option.value}
              className={`size-opt ${imageSize === option.value ? 'on' : ''}`}
              onClick={() => setImageSize(option.value)}
            >
              <span className="size-glyph" style={{ aspectRatio: option.ratio }} />
              <span className="size-name">{option.label}</span>
              <span className="size-px">{option.px}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="param">
        <span className="param-label">质量</span>
        <Segmented value={imageQuality} options={QUALITY_OPTIONS} onChange={setImageQuality} label="图片质量" />
      </div>

      <div className="param">
        <span className="param-label">数量</span>
        <Segmented
          value={String(imageCount)}
          options={[1, 2, 3, 4].map((count) => ({ value: String(count), label: `${count}` }))}
          onChange={(value) => setImageCount(Number(value))}
          label="生成数量"
        />
      </div>

      <div className="param">
        <span className="param-label">格式</span>
        <Segmented
          value={outputFormat}
          options={[
            { value: 'png', label: 'PNG' },
            { value: 'jpeg', label: 'JPEG' },
            { value: 'webp', label: 'WebP' },
            { value: 'gif', label: 'GIF' },
          ]}
          onChange={(value) => setOutputFormat(value as OutputFormat)}
          label="输出格式"
        />
        {outputFormat === 'gif' ? (
          <>
            <p className="hint">GIF 动图需要模型和服务商支持，生成更慢、费用更高。</p>
            <div className="two">
              <label className="field">
                <span>帧数 2–16</span>
                <input type="number" min={2} max={16} value={frameCount} onChange={(event) => setFrameCount(Math.min(16, Math.max(2, Math.round(Number(event.target.value) || 2))))} />
              </label>
              <label className="field">
                <span>每帧毫秒</span>
                <input type="number" min={10} max={655350} step={10} value={frameDuration} onChange={(event) => setFrameDuration(Math.min(655350, Math.max(10, Math.round((Number(event.target.value) || 10) / 10) * 10)))} />
              </label>
            </div>
          </>
        ) : null}
        {outputFormat === 'jpeg' || outputFormat === 'webp' ? (
          <label className="field range-field">
            <span>
              压缩质量 <output>{outputCompression}</output>
            </span>
            <input type="range" min={0} max={100} value={outputCompression} onChange={(event) => setOutputCompression(Number(event.target.value))} />
          </label>
        ) : null}
      </div>

      <label className="field">
        <span>图像模型</span>
        <input
          type="text"
          list="image-model-options"
          placeholder={DEFAULT_IMAGE_MODEL}
          value={imageModel}
          onChange={(event) => setImageModel(event.target.value)}
        />
        <datalist id="image-model-options">
          {availableImageModels.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </label>

      <details className="advanced">
        <summary>更多选项</summary>
        <div className="advanced-body">
          <div className="param">
            <span className="param-label">背景</span>
            <Segmented
              value={background}
              options={[
                { value: 'auto', label: '自动' },
                { value: 'opaque', label: '不透明' },
                { value: 'transparent', label: '透明' },
              ]}
              onChange={(value) => setBackground(value as ImageBackground)}
              label="背景"
            />
          </div>
          <div className="param">
            <span className="param-label">审核强度</span>
            <Segmented
              value={moderation}
              options={[
                { value: 'auto', label: '默认' },
                { value: 'low', label: '宽松' },
              ]}
              onChange={(value) => setModeration(value as ImageModeration)}
              label="审核强度"
            />
          </div>
          <div className="param">
            <span className="param-label">返回方式</span>
            <Segmented
              value={responseMode}
              options={[
                { value: 'auto', label: '自动' },
                { value: 'b64_json', label: 'Base64' },
                { value: 'url', label: '链接' },
              ]}
              onChange={(value) => setResponseMode(value as ResponseMode)}
              label="返回方式"
            />
            <p className="hint">拿不到图片时先改回“自动”。</p>
          </div>
        </div>
      </details>
    </div>
  )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Image Chat</span>
        </div>

        <div className="view-switch" role="tablist" aria-label="切换视图">
          <button type="button" role="tab" aria-selected={view === 'thread'} className={view === 'thread' ? 'on' : ''} onClick={() => setView('thread')}>
            对话
          </button>
          <button type="button" role="tab" aria-selected={view === 'gallery'} className={view === 'gallery' ? 'on' : ''} onClick={() => setView('gallery')}>
            作品{generatedImageHistory.length ? <span className="count">{generatedImageHistory.length}</span> : null}
          </button>
        </div>

        <div className="topbar-actions">
          <button type="button" className="top-btn" onClick={() => { setLibraryOpen(true); setLibraryDetailOpen(false) }}>
            <Icon name="spark" />
            <span className="top-btn-label">灵感库</span>
          </button>
          <button type="button" className="top-btn" onClick={() => setSettingsOpen(true)} aria-label="设置">
            <Icon name="settings" />
            <span className="top-btn-label">设置</span>
            <span className={`conn-dot ${canSubmit ? 'ok' : 'bad'}`} title={canSubmit ? '接口已配置' : '缺少 API Key 或 Base URL'} />
          </button>
        </div>
      </header>

      <div className={`body ${isInspectorOpen ? '' : 'inspector-closed'}`}>
        <main className="stage">
          {view === 'thread' ? (
            <section className="thread" ref={messagesContainerRef} onScroll={handleMessagesScroll} aria-live="polite">
              <div className="thread-inner">
                {isStarterOnly ? (
                  <div className="empty">
                    <h1>今天想画点什么？</h1>
                    <p>在下面写一段画面描述，按 Enter 生成。拿不准就从灵感库挑一个模板，或者试试这些：</p>
                    <div className="suggestions">
                      {STARTER_PROMPTS.map((prompt) => (
                        <button key={prompt} type="button" className="suggestion" onClick={() => reusePrompt(prompt)}>
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messagesWithHydratedImages.map((message) => {
                    if (message.role === 'user') {
                      const { tag, text } = splitRequestTag(message.content)
                      return (
                        <article key={message.id} className="msg user">
                          <div className="bubble">
                            {tag ? <span className={`req-tag ${tag === '图生图' ? 'edit' : ''}`}>{tag}</span> : null}
                            <p>{text}</p>
                            {message.attachments?.length ? (
                              <div className="attach-row">
                                {message.attachments.map((attachment) => (
                                  <button
                                    key={attachment.id}
                                    type="button"
                                    className="attach-thumb"
                                    onClick={() => setPreviewImage({ url: attachment.objectUrl })}
                                    aria-label={`查看附件 ${attachment.name}`}
                                  >
                                    <img src={attachment.objectUrl} alt={attachment.name} />
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <time className="msg-time">{formatTime(message.createdAt)}</time>
                        </article>
                      )
                    }

                    return (
                      <article key={message.id} className={`msg assistant ${message.retryAction ? 'failed' : ''}`}>
                        {message.content ? <p className="msg-text">{message.content}</p> : null}
                        {message.images?.length ? (
                          <div className={`shots n${Math.min(message.images.length, 4)}`}>
                            {message.images.map((image, index) => (
                              <figure className="shot" key={`${message.id}-${index}`}>
                                <button type="button" className="shot-open" onClick={() => setPreviewImage(image)} aria-label="查看大图">
                                  <img src={image.url} alt={image.revisedPrompt || message.imagePrompt || '生成的图片'} loading="lazy" />
                                </button>
                                <div className="shot-actions">
                                  <a className="chip-btn" href={image.url} download={`generated-${message.createdAt}-${index + 1}.${image.extension || outputFormat}`}>
                                    <Icon name="download" size={15} />
                                    下载
                                  </a>
                                  <button type="button" className="chip-btn" onClick={() => void applyImageAsReference(image)}>
                                    <Icon name="edit" size={15} />
                                    以此改图
                                  </button>
                                </div>
                              </figure>
                            ))}
                          </div>
                        ) : null}
                        {message.imagePrompt ? (
                          <div className="msg-tools">
                            <button type="button" className="text-btn" onClick={() => reusePrompt(message.imagePrompt as string)}>
                              <Icon name="reuse" size={14} />
                              复用提示词
                            </button>
                            <button type="button" className="text-btn" onClick={() => void copyText(message.imagePrompt as string)}>
                              <Icon name="copy" size={14} />
                              复制
                            </button>
                          </div>
                        ) : null}
                        {message.retryAction ? (
                          <div className="msg-tools">
                            <button
                              type="button"
                              className="retry-btn"
                              disabled={isBusy || !canSubmit}
                              onClick={() => handleRetry(message.retryAction as RetryAction)}
                            >
                              <Icon name="refresh" size={15} />
                              重试
                            </button>
                          </div>
                        ) : null}
                        <time className="msg-time">{formatTime(message.createdAt)}</time>
                      </article>
                    )
                  })
                )}

                {imageLoading ? (
                  <article className="msg assistant">
                    <div className="developing" style={{ aspectRatio: pendingAspect }}>
                      <div className="developing-grain" />
                      <div className="developing-label">
                        <strong>正在生成</strong>
                        <span>{pendingSeconds} 秒 · 通常需要 20–60 秒</span>
                      </div>
                    </div>
                  </article>
                ) : null}
                {chatLoading ? (
                  <article className="msg assistant">
                    <div className="typing" aria-label="正在回复">
                      <i />
                      <i />
                      <i />
                    </div>
                  </article>
                ) : null}
              </div>
            </section>
          ) : (
            <section className="gallery" aria-label="作品">
              {generatedImageHistory.length ? (
                <div className="gallery-grid">
                  {generatedImageHistory.map((image) => (
                    <figure className="tile" key={image.id}>
                      <button type="button" className="tile-open" onClick={() => setPreviewImage(image)} aria-label="查看大图">
                        <img src={image.url} alt={image.prompt || '生成的图片'} loading="lazy" />
                      </button>
                      <figcaption>
                        <span className="tile-prompt">{image.prompt}</span>
                        <span className="tile-meta">
                          <time>{formatTime(image.createdAt)}</time>
                          <span className="tile-actions">
                            <a className="icon-btn sm" href={image.url} download={`generated-${image.createdAt}.${image.extension || outputFormat}`} aria-label="下载" title="下载">
                              <Icon name="download" size={16} />
                            </a>
                            <button type="button" className="icon-btn sm" onClick={() => void applyImageAsReference(image)} aria-label="以此改图" title="以此改图">
                              <Icon name="edit" size={16} />
                            </button>
                            <button type="button" className="icon-btn sm danger" onClick={() => removeImageHistoryItem(image.id)} aria-label="删除" title="删除">
                              <Icon name="trash" size={16} />
                            </button>
                          </span>
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <h1>还没有作品</h1>
                  <p>生成的图片都会保存在这里，刷新页面也不会丢。</p>
                  <button type="button" className="btn primary" onClick={() => setView('thread')}>
                    去生成第一张
                  </button>
                </div>
              )}
            </section>
          )}

          {view === 'thread' ? (
            <section
              className={`composer ${isDragOver ? 'drag' : ''}`}
              onDragOver={(event) => {
                event.preventDefault()
                setIsDragOver(true)
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={(event) => void handleComposerDrop(event)}
            >
              {!hasCredential ? (
                <div className="notice">
                  <span>还没有可用的 API Key。在设置里填写，或在服务端 .env 中配置。</span>
                  <button type="button" className="text-btn" onClick={() => setSettingsOpen(true)}>
                    打开设置
                  </button>
                </div>
              ) : null}
              <div className="composer-card">
                <div className="mode-tabs" role="tablist" aria-label="输入模式">
                  {COMPOSER_MODES.map((mode) => (
                    <button
                      key={mode.value}
                      type="button"
                      role="tab"
                      aria-selected={composerMode === mode.value}
                      className={composerMode === mode.value ? 'on' : ''}
                      onClick={() => setComposerMode(mode.value)}
                    >
                      <Icon name={mode.icon} size={15} />
                      {mode.label}
                    </button>
                  ))}
                </div>

                {composerMode === 'edit' ? (
                  <div className="ref-row">
                    {editImagePreview ? (
                      <div className="ref-thumb">
                        <img src={editImagePreview} alt="参考图" />
                        <button type="button" className="ref-remove" onClick={() => setEditImageFile(null)} aria-label="移除参考图">
                          <Icon name="close" size={13} />
                        </button>
                      </div>
                    ) : null}
                    <label className="ref-pick">
                      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleEditFileChange} />
                      <Icon name="image" size={16} />
                      {editImagePreview ? '更换参考图' : '选择参考图'}
                    </label>
                    {!editImagePreview ? <span className="hint">也可以拖入或粘贴图片</span> : null}
                  </div>
                ) : null}

                {composerMode === 'chat' && chatAttachments.length ? (
                  <div className="ref-row">
                    {chatAttachments.map((attachment) => (
                      <div className="ref-thumb" key={attachment.id}>
                        <img src={attachment.objectUrl} alt={attachment.name} />
                        <button type="button" className="ref-remove" onClick={() => removeChatAttachment(attachment.id)} aria-label={`移除 ${attachment.name}`}>
                          <Icon name="close" size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                <textarea
                  ref={composerInputRef}
                  className="composer-input"
                  rows={2}
                  value={composerValue}
                  placeholder={
                    composerMode === 'chat'
                      ? '和模型聊点什么，可粘贴图片'
                      : composerMode === 'edit'
                        ? '说明要怎么改，例如：保持人物姿势，把背景换成雨夜街道'
                        : '描述你想要的画面：主体、场景、光线、风格'
                  }
                  onChange={(event) => (composerMode === 'chat' ? setChatInput(event.target.value) : setImagePrompt(event.target.value))}
                  onKeyDown={onComposerKeyDown}
                  onPaste={handleChatPaste}
                  aria-label="输入框"
                />

                <div className="composer-bar">
                  <div className="bar-left">
                    {composerMode === 'chat' ? (
                      <label className="icon-btn" title="添加图片" aria-label="添加图片">
                        <input type="file" accept="image/*" multiple onChange={handleChatAttachmentChange} />
                        <Icon name="paperclip" />
                      </label>
                    ) : (
                      <>
                        <button type="button" className="chip-btn" onClick={() => { setLibraryOpen(true); setLibraryDetailOpen(false) }}>
                          <Icon name="spark" size={15} />
                          灵感
                        </button>
                        <button type="button" className="chip-btn params-chip" onClick={openParams}>
                          <Icon name="sliders" size={15} />
                          {paramSummary}
                        </button>
                      </>
                    )}
                  </div>
                  <div className="bar-right">
                    <span className="kbd-hint">Enter 发送 · Shift+Enter 换行</span>
                    <button
                      type="button"
                      className="send-btn"
                      disabled={!composerCanSend}
                      onClick={handleComposerSubmit}
                      aria-label={composerMode === 'chat' ? '发送' : '生成'}
                    >
                      {composerBusy ? <span className="spinner" /> : <Icon name={composerMode === 'chat' ? 'send' : 'spark'} />}
                      <span>{composerMode === 'chat' ? '发送' : composerBusy ? '生成中' : '生成'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </section>
          ) : null}
        </main>

        <aside className={`inspector ${paramsSheetOpen ? 'sheet-open' : ''}`} aria-label="画面参数">
          <div className="sheet-handle" aria-hidden="true" />
          {paramsPanel}
        </aside>
        {paramsSheetOpen ? <div className="scrim sheet-scrim" onClick={() => setParamsSheetOpen(false)} /> : null}
      </div>

      {settingsOpen ? (
        <div className="modal-wrap" role="dialog" aria-modal="true" aria-label="设置" onClick={() => setSettingsOpen(false)}>
          <div className="modal settings" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>设置</h2>
              <button type="button" className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="关闭">
                <Icon name="close" />
              </button>
            </div>
            <div className="modal-body">
              <section className="set-group">
                <h3>接口连接</h3>
                <label className="field">
                  <span>API Base URL</span>
                  <input type="text" placeholder="https://api.openai.com/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
                </label>
                <div className="two">
                  <label className="field">
                    <span>聊天 API Key</span>
                    <input
                      type="password"
                      placeholder={serverConfig.hasChatApiKey ? '服务端已配置，可留空' : 'sk-...'}
                      value={chatApiKey}
                      onChange={(event) => setChatApiKey(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <label className="field">
                    <span>画图 API Key</span>
                    <input
                      type="password"
                      placeholder={serverConfig.hasImageApiKey ? '服务端已配置，可留空' : 'sk-...'}
                      value={imageApiKey}
                      onChange={(event) => setImageApiKey(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                </div>
                <p className="hint">Key 只保存在这台设备的浏览器里，请求经本地代理转发，不会写进前端代码。</p>
              </section>

              <section className="set-group">
                <h3>聊天</h3>
                <label className="field">
                  <span>聊天模型</span>
                  <input
                    type="text"
                    list="chat-model-options"
                    placeholder={serverConfig.defaultChatModel || DEFAULT_CHAT_MODEL}
                    value={chatModel}
                    onChange={(event) => setChatModel(event.target.value)}
                    onBlur={(event) => void handleChatModelCommit(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                    disabled={isSavingDefaultChatModel}
                  />
                  <datalist id="chat-model-options">
                    {availableChatModels.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={saveChatModelAsDefault}
                    disabled={isSavingDefaultChatModel}
                    onChange={(event) => void handleSaveChatModelAsDefaultToggle(event.target.checked)}
                  />
                  <span>
                    设为服务端默认聊天模型
                    <small>当前默认：{serverConfig.defaultChatModel || DEFAULT_CHAT_MODEL}。勾选后会写入服务端 .env</small>
                  </span>
                </label>
                <label className="field">
                  <span>System Prompt</span>
                  <textarea rows={3} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} />
                </label>
              </section>

              <section className="set-group">
                <h3>数据</h3>
                <div className="set-actions">
                  <button type="button" className="btn" onClick={handleUseServerDefaults}>
                    恢复服务端默认配置
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={isBusy}
                    onClick={() => {
                      if (window.confirm('清空全部对话记录？作品里的图片会保留。')) {
                        handleReset()
                        setSettingsOpen(false)
                      }
                    }}
                  >
                    清空对话
                  </button>
                </div>
                <p className="hint">
                  {status ? `最近状态：${status}。` : ''}局域网内其他设备用本机 IP 加端口即可访问。
                </p>
              </section>
            </div>
          </div>
        </div>
      ) : null}

      {libraryOpen ? (
        <div className="modal-wrap" role="dialog" aria-modal="true" aria-label="提示词灵感库" onClick={() => setLibraryOpen(false)}>
          <div className={`modal library ${libraryDetailOpen ? 'detail' : ''}`} onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>提示词灵感</h2>
              <div className="lib-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={promptLibraryMode === 'templates'} className={promptLibraryMode === 'templates' ? 'on' : ''} onClick={() => { setPromptLibraryMode('templates'); setLibraryDetailOpen(false) }}>
                  模板
                </button>
                <button type="button" role="tab" aria-selected={promptLibraryMode === 'cases'} className={promptLibraryMode === 'cases' ? 'on' : ''} onClick={() => { setPromptLibraryMode('cases'); setLibraryDetailOpen(false) }}>
                  案例 <span className="count">{promptCases.length}</span>
                </button>
              </div>
              <button type="button" className="icon-btn" onClick={() => setLibraryOpen(false)} aria-label="关闭">
                <Icon name="close" />
              </button>
            </div>

            <div className="lib-toolbar">
              {promptLibraryMode === 'templates' ? (
                <>
                  <select value={selectedPromptCategory?.id || ''} onChange={(event) => setSelectedPromptCategoryId(event.target.value)} aria-label="模板分类">
                    {promptCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                  <input type="search" placeholder="搜索：海报、电商、国风…" value={promptSearch} onChange={(event) => setPromptSearch(event.target.value)} />
                  <button type="button" className="chip-btn" onClick={() => { applyRandomPromptInspiration(); setLibraryDetailOpen(true) }} title="随机挑一个模板并填入">
                    <Icon name="dice" size={15} />
                    随机
                  </button>
                </>
              ) : (
                <>
                  <select value={selectedCaseCategory} onChange={(event) => setSelectedCaseCategory(event.target.value)} aria-label="案例分类">
                    {caseCategories.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  <input type="search" placeholder="搜索编号、标题、关键词" value={caseSearch} onChange={(event) => setCaseSearch(event.target.value)} />
                  <button type="button" className="chip-btn" onClick={() => { applyRandomPromptCase(); setLibraryDetailOpen(true) }} title="随机挑一个案例并填入">
                    <Icon name="dice" size={15} />
                    随机
                  </button>
                  <button type="button" className="chip-btn" onClick={() => void syncPromptCases(true)} disabled={promptCasesSyncing} title="从来源仓库同步最新案例">
                    <Icon name="refresh" size={15} />
                    {promptCasesSyncing ? '同步中' : '同步'}
                  </button>
                </>
              )}
            </div>

            <div className="lib-body">
              <div className="lib-list">
                {promptLibraryMode === 'templates' ? (
                  <>
                    {selectedPromptCategory ? <p className="hint lib-note">{selectedPromptCategory.description}</p> : null}
                    {filteredPromptItems.length ? (
                      filteredPromptItems.map((item) => (
                        <button
                          key={item.title}
                          type="button"
                          className={`lib-item ${selectedPromptItem?.title === item.title ? 'on' : ''}`}
                          onClick={() => {
                            setRawSelectedPromptTitle(item.title)
                            setLibraryDetailOpen(true)
                          }}
                        >
                          <strong>{item.title}</strong>
                          <span>{item.summary}</span>
                        </button>
                      ))
                    ) : (
                      <p className="hint lib-note">这个分类下没有匹配的模板，换个关键词试试。</p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="hint lib-note">
                      显示 {Math.min(filteredPromptCases.length, 80)} / {filteredPromptCases.length} 个
                      {promptCasesUpdatedAt ? `，同步于 ${new Date(promptCasesUpdatedAt).toLocaleDateString('zh-CN')}` : ''}
                    </p>
                    {filteredPromptCases.length ? (
                      <div className="case-grid">
                        {filteredPromptCases.slice(0, 80).map((item) => (
                          <button
                            key={item.number}
                            type="button"
                            className={`case-card ${selectedPromptCase?.number === item.number ? 'on' : ''}`}
                            onClick={() => {
                              setRawSelectedCaseNumber(item.number)
                              setLibraryDetailOpen(true)
                            }}
                          >
                            <span className="case-thumb">
                              <img
                                src={item.imageUrl}
                                alt=""
                                loading="lazy"
                                onError={(event) => {
                                  event.currentTarget.style.visibility = 'hidden'
                                }}
                              />
                              <span className="case-no">{item.number}</span>
                            </span>
                            <span className="case-title">{item.title}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="hint lib-note">没有匹配的案例，换个关键词试试。</p>
                    )}
                  </>
                )}
              </div>

              <div className="lib-detail">
                <button type="button" className="text-btn lib-back" onClick={() => setLibraryDetailOpen(false)}>
                  <Icon name="arrow-left" size={15} />
                  返回列表
                </button>
                {promptLibraryMode === 'templates' && selectedPromptItem ? (
                  <>
                    <h3>{selectedPromptItem.title}</h3>
                    <p className="hint">{selectedPromptItem.summary}</p>
                    <div className="tags">
                      {selectedPromptItem.tags.map((tag) => (
                        <span className="tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                    <pre className="prompt-text">{selectedPromptItem.prompt}</pre>
                    <p className="hint">方括号里的内容替换成你自己的需求。</p>
                    <div className="detail-actions">
                      <button type="button" className="btn" onClick={() => appendPromptInspiration(selectedPromptItem.prompt)}>
                        追加到输入框
                      </button>
                      <button type="button" className="btn primary" onClick={() => applyPromptInspiration(selectedPromptItem.prompt)}>
                        使用这个模板
                      </button>
                    </div>
                    <a className="source-link" href={PROMPT_LIBRARY_SOURCE} target="_blank" rel="noreferrer">
                      来源：awesome-gpt-image-2
                    </a>
                  </>
                ) : null}
                {promptLibraryMode === 'cases' && selectedPromptCase ? (
                  <>
                    <button
                      type="button"
                      className="case-hero"
                      onClick={() => window.open(selectedPromptCase.imageUrl, '_blank', 'noopener,noreferrer')}
                      aria-label="在新标签页打开示例图"
                    >
                      <img src={selectedPromptCase.imageUrl} alt={selectedPromptCase.title} loading="lazy" />
                    </button>
                    <h3>
                      例 {selectedPromptCase.number} · {selectedPromptCase.title}
                    </h3>
                    <p className="hint">
                      {selectedPromptCase.category}，来自 {selectedPromptCase.source}
                    </p>
                    {isPromptPreviewExpanded ? <pre className="prompt-text">{selectedPromptCase.prompt}</pre> : null}
                    <button type="button" className="text-btn" onClick={() => setIsPromptPreviewExpanded((value) => !value)}>
                      {isPromptPreviewExpanded ? '收起提示词' : '查看完整提示词'}
                    </button>
                    <div className="detail-actions">
                      <button type="button" className="btn" onClick={() => appendPromptCase(selectedPromptCase.prompt)}>
                        追加到输入框
                      </button>
                      <button type="button" className="btn primary" onClick={() => applyPromptCase(selectedPromptCase.prompt)}>
                        使用这个案例
                      </button>
                    </div>
                    <a className="source-link" href={PROMPT_CASE_SOURCE} target="_blank" rel="noreferrer">
                      来源：awesome-gpt-image-2
                    </a>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {previewImage ? (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="大图预览" onClick={() => setPreviewImage(null)}>
          <div className="lb-top" onClick={(event) => event.stopPropagation()}>
            <span className="lb-count">{previewIndex >= 0 ? `${previewIndex + 1} / ${generatedImageHistory.length}` : ''}</span>
            <div className="lb-actions">
              <a className="chip-btn" href={previewImage.url} download={`preview.${previewImage.extension || outputFormat}`}>
                <Icon name="download" size={15} />
                下载
              </a>
              {previewImage.id ? (
                <button type="button" className="chip-btn" onClick={() => void applyImageAsReference(previewImage)}>
                  <Icon name="edit" size={15} />
                  以此改图
                </button>
              ) : null}
              <button type="button" className="icon-btn" onClick={() => setPreviewImage(null)} aria-label="关闭">
                <Icon name="close" />
              </button>
            </div>
          </div>
          <div className="lb-stage">
            {previewIndex >= 0 && generatedImageHistory.length > 1 ? (
              <button type="button" className="lb-nav prev" onClick={(event) => { event.stopPropagation(); stepPreview(-1) }} aria-label="上一张">
                <Icon name="arrow-left" size={22} />
              </button>
            ) : null}
            <img className="lb-image" src={previewImage.url} alt={previewPrompt || '大图预览'} onClick={(event) => event.stopPropagation()} />
            {previewIndex >= 0 && generatedImageHistory.length > 1 ? (
              <button type="button" className="lb-nav next" onClick={(event) => { event.stopPropagation(); stepPreview(1) }} aria-label="下一张">
                <Icon name="arrow-right" size={22} />
              </button>
            ) : null}
          </div>
          {previewPrompt ? (
            <div className="lb-caption" onClick={(event) => event.stopPropagation()}>
              <p>{previewPrompt}</p>
              <div className="lb-caption-actions">
                <button type="button" className="text-btn" onClick={() => reusePrompt(previewPrompt)}>
                  <Icon name="reuse" size={14} />
                  复用提示词
                </button>
                <button type="button" className="text-btn" onClick={() => void copyText(previewPrompt)}>
                  <Icon name="copy" size={14} />
                  复制
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {toast ? (
        <div className="toast" key={toast.id} role="status">
          {toast.text}
        </div>
      ) : null}
    </div>
  )
}

type SegmentedOption = { value: string; label: string }

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: readonly SegmentedOption[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? 'on' : ''}
          onClick={() => onChange(option.value as T)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export default App
