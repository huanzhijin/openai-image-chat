import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
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

type MobilePanel = 'chat' | 'draw' | 'settings'

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
  const [imageMode, setImageMode] = useState<ImageMode>('openai')
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
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT)
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
  const [isPromptLibraryExpanded, setIsPromptLibraryExpanded] = useState(
    () => readLocal('openai-image-chat.promptLibraryExpanded', 'true') === 'true',
  )
  const [isPromptPreviewExpanded, setIsPromptPreviewExpanded] = useState(
    () => readLocal('openai-image-chat.promptPreviewExpanded', 'false') === 'true',
  )
  const [editImageFile, setEditImageFile] = useState<File | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>(() => restoreMessages())
  const [promptCases, setPromptCases] = useState(BUILTIN_PROMPT_CASES)
  const [promptCasesUpdatedAt, setPromptCasesUpdatedAt] = useState('')
  const [promptCasesSyncing, setPromptCasesSyncing] = useState(false)
  const [imageHistory, setImageHistory] = useState<ImageHistoryItem[]>([])
  const [isImageHistoryCollapsed, setIsImageHistoryCollapsed] = useState(() => readLocal('openai-image-chat.imageHistoryCollapsed', 'true') === 'true')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => readLocal('openai-image-chat.sidebarCollapsed', 'false') === 'true')
  const [chatLoading, setChatLoading] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [status, setStatus] = useState('等待输入')
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('draw')
  const [previewImage, setPreviewImage] = useState<GeneratedImage | null>(null)
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
        setStatus(`提示词案例库已同步，共 ${data.cases.length} 个案例`)
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
      localStorage.setItem('openai-image-chat.imageHistoryCollapsed', String(isImageHistoryCollapsed))
    } catch {
      // ignore
    }
  }, [isImageHistoryCollapsed])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.sidebarCollapsed', String(isSidebarCollapsed))
    } catch {
      // ignore
    }
  }, [isSidebarCollapsed])

  useEffect(() => {
    try {
      localStorage.setItem('openai-image-chat.promptLibraryExpanded', String(isPromptLibraryExpanded))
    } catch {
      // ignore
    }
  }, [isPromptLibraryExpanded])

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

  const applyPromptInspiration = (prompt: string) => {
    setImagePrompt(prompt)
    setMobilePanel('draw')
    setStatus('已将灵感模板填入绘图提示词，可继续改写后生成')
  }

  const appendPromptInspiration = (prompt: string) => {
    setImagePrompt((current) => {
      const trimmed = current.trim()
      return trimmed ? `${trimmed}\n\n${prompt}` : prompt
    })
    setMobilePanel('draw')
    setStatus('已把灵感模板追加到绘图提示词')
  }

  const applyRandomPromptInspiration = () => {
    if (!allPromptItems.length) return
    const randomItem = allPromptItems[Math.floor(Math.random() * allPromptItems.length)]
    setPromptLibraryMode('templates')
    setSelectedPromptCategoryId(randomItem.categoryId)
    setRawSelectedPromptTitle(randomItem.title)
    setIsPromptPreviewExpanded(true)
    setImagePrompt(randomItem.prompt)
    setMobilePanel('draw')
    setStatus(`已随机填入灵感模板：${randomItem.categoryName} / ${randomItem.title}`)
  }

  const applyPromptCase = (prompt: string) => {
    setImagePrompt(prompt)
    setMobilePanel('draw')
    setStatus('已将完整案例提示词填入绘图提示词，可继续改写后生成')
  }

  const appendPromptCase = (prompt: string) => {
    setImagePrompt((current) => {
      const trimmed = current.trim()
      return trimmed ? `${trimmed}\n\n${prompt}` : prompt
    })
    setMobilePanel('draw')
    setStatus('已把完整案例提示词追加到绘图提示词')
  }

  const applyRandomPromptCase = () => {
    if (!promptCases.length) return
    const randomItem = promptCases[Math.floor(Math.random() * promptCases.length)]
    setPromptLibraryMode('cases')
    setSelectedCaseCategory(randomItem.category)
    setRawSelectedCaseNumber(randomItem.number)
    setIsPromptPreviewExpanded(true)
    setImagePrompt(randomItem.prompt)
    setMobilePanel('draw')
    setStatus(`已随机填入完整案例：例 ${randomItem.number} / ${randomItem.title}`)
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
    setMobilePanel('chat')
    setStatus('聊天请求发送中…')

    try {
      const payload = {
        model: chatModel.trim() || serverConfig.defaultChatModel || DEFAULT_CHAT_MODEL,
        messages: history
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
      setMobilePanel('draw')
      return
    }

    pushMessage({
      role: 'user',
      content: mode === 'edit'
        ? `请参考上传图片进行图生图：${prompt}`
        : `请根据以下提示使生成图片：${prompt}`,
    })

    setImageLoading(true)
    setMobilePanel('chat')
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

  const onChatEnter: React.KeyboardEventHandler<HTMLTextAreaElement> = async (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      await handleSendChat()
    }
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

  return (
    <div className={`shell ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <nav className="mobile-tabs" aria-label="移动端功能切换">
        <button
          type="button"
          className={mobilePanel === 'draw' ? 'active' : ''}
          onClick={() => setMobilePanel('draw')}
        >
          绘图
        </button>
        <button
          type="button"
          className={mobilePanel === 'chat' ? 'active' : ''}
          onClick={() => setMobilePanel('chat')}
        >
          结果
        </button>
        <button
          type="button"
          className={mobilePanel === 'settings' ? 'active' : ''}
          onClick={() => setMobilePanel('settings')}
        >
          设置
        </button>
      </nav>

      <aside className={`sidebar panel ${mobilePanel === 'chat' ? 'mobile-hidden' : ''}`}>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setIsSidebarCollapsed((value) => !value)}
          aria-expanded={!isSidebarCollapsed}
          aria-label={isSidebarCollapsed ? '展开左侧栏' : '收起左侧栏'}
          title={isSidebarCollapsed ? '展开左侧栏' : '收起左侧栏'}
        >
          {isSidebarCollapsed ? '›' : '‹'}
        </button>
        <div className="sidebar-content">
        <div className="intro-card">
          <p className="eyebrow">OpenAI Compatible</p>
          <h1>openai-image-chat</h1>
          <p className="muted">
            本地聊天 + 画图网页。前端访问本地代理，再由代理调用 OpenAI-compatible API；默认模型为
            <strong> gpt-image-2</strong>，适合本机与局域网使用。
          </p>
        </div>

        <details className={`field-group highlight draw-section collapsible-section ${mobilePanel !== 'draw' ? 'mobile-section-hidden' : ''}`} open>
          <summary className="section-summary">
            <span className="section-title">绘图与图生图</span>
            <span className="summary-hint">文生图 / 图生图 / 尺寸 / 数量</span>
          </summary>
          <div className="settings-content">
          <div className="mode-switch">
            <button
              type="button"
              className={imageMode === 'openai' ? 'active' : ''}
              onClick={() => setImageMode('openai')}
            >
              文生图
            </button>
            <button
              type="button"
              className={imageMode === 'edit' ? 'active' : ''}
              onClick={() => setImageMode('edit')}
            >
              图生图
            </button>
          </div>

          {imageMode === 'edit' ? (
            <label className="upload-box">
              参考图片
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleEditFileChange} />
              {editImagePreview ? (
                <img className="preview-image" src={editImagePreview} alt="参考图预览" />
              ) : (
                <span className="muted small">支持 PNG / JPG / WebP。手机端可从相册选择。</span>
              )}
            </label>
          ) : null}

          <div className="grid two-col">
            <label>
              图片尺寸
              <select value={imageSize} onChange={(event) => setImageSize(event.target.value as ImageSize)}>
                <option value="1536x1024">1536×1024 横图</option>
                <option value="1024x1536">1024×1536 竖图</option>
                <option value="1024x1024">1024×1024 方图</option>
                <option value="auto">auto</option>
              </select>
            </label>
            <label>
              质量
              <select
                value={imageQuality}
                onChange={(event) => setImageQuality(event.target.value as ImageQuality)}
              >
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
                <option value="auto">auto</option>
              </select>
            </label>
          </div>
          <div className="grid two-col">
            <label>
              输出格式
              <select
                value={outputFormat}
                onChange={(event) => setOutputFormat(event.target.value as OutputFormat)}
              >
                <option value="png">png</option>
                <option value="jpeg">jpeg</option>
                <option value="webp">webp</option>
                <option value="gif">GIF 动图（预览）</option>
              </select>
            </label>
            <label>
              生成数量
              <input
                type="number"
                min={1}
                max={4}
                value={imageCount}
                onChange={(event) => setImageCount(Math.min(4, Math.max(1, Number(event.target.value) || 1)))}
              />
            </label>
          </div>
          {outputFormat === 'gif' ? (
            <>
              <p className="muted small">GIF 需要所选模型和服务商开通 GIF 预览权限；不支持时接口会返回错误。生成时间和费用可能增加。</p>
              <div className="grid two-col">
                <label>帧数（2–16）<input type="number" min={2} max={16} value={frameCount} onChange={(event) => setFrameCount(Math.min(16, Math.max(2, Math.round(Number(event.target.value) || 2))))} /></label>
                <label>每帧时长（毫秒）<input type="number" min={10} max={655350} step={10} value={frameDuration} onChange={(event) => setFrameDuration(Math.min(655350, Math.max(10, Math.round((Number(event.target.value) || 10) / 10) * 10)))} /></label>
              </div>
            </>
          ) : null}
          <div className="grid two-col">
            <label>
              背景
              <select value={background} onChange={(event) => setBackground(event.target.value as ImageBackground)}>
                <option value="auto">auto</option>
                <option value="opaque">opaque</option>
                <option value="transparent">transparent</option>
              </select>
            </label>
            <label>
              审核强度
              <select value={moderation} onChange={(event) => setModeration(event.target.value as ImageModeration)}>
                <option value="auto">auto</option>
                <option value="low">low</option>
              </select>
            </label>
          </div>
          <div className="grid two-col">
            <label>
              返回模式
              <select
                value={responseMode}
                onChange={(event) => setResponseMode(event.target.value as ResponseMode)}
              >
                <option value="auto">auto（推荐）</option>
                <option value="b64_json">b64_json</option>
                <option value="url">url</option>
              </select>
            </label>
            <label>
              JPEG/WebP 压缩
              <input
                type="number"
                min={0}
                max={100}
                value={outputCompression}
                onChange={(event) => setOutputCompression(Math.min(100, Math.max(0, Number(event.target.value) || 0)))}
              />
            </label>
          </div>
          <label>
            绘图提示词
            <textarea
              rows={5}
              value={imagePrompt}
              placeholder={imageMode === 'edit' ? '说明希望如何改图，例如：保持人物姿势，把背景换成赛博朋克夜景。' : '描述你想生成的图片。'}
              onChange={(event) => setImagePrompt(event.target.value)}
            />
          </label>

          <div className="prompt-library">
            <button
              type="button"
              className="prompt-library-header"
              onClick={() => setIsPromptLibraryExpanded((value) => !value)}
              aria-expanded={isPromptLibraryExpanded}
            >
              <span>
                <strong>提示词灵感库</strong>
                <span className="muted small">来自 awesome-gpt-image-2：模板 + {promptCases.length} 个完整案例</span>
              </span>
              <span className="prompt-library-toggle">{isPromptLibraryExpanded ? '收起' : '展开'}</span>
            </button>

            {isPromptLibraryExpanded ? (
              <div className="prompt-library-body">
                <div className="mode-switch prompt-library-mode-switch">
                  <button
                    type="button"
                    className={promptLibraryMode === 'templates' ? 'active' : ''}
                    onClick={() => setPromptLibraryMode('templates')}
                  >
                    精选模板
                  </button>
                  <button
                    type="button"
                    className={promptLibraryMode === 'cases' ? 'active' : ''}
                    onClick={() => setPromptLibraryMode('cases')}
                  >
                    完整案例 {promptCases.length}
                  </button>
                </div>

                {promptLibraryMode === 'templates' ? (
                  <>
                    <div className="grid two-col prompt-library-controls">
                      <label>
                        灵感分类
                        <select
                          value={selectedPromptCategory?.id || ''}
                          onChange={(event) => setSelectedPromptCategoryId(event.target.value)}
                        >
                          {promptCategories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        搜索关键词
                        <input
                          type="text"
                          placeholder="如：海报 / 电商 / 国风 / 人像"
                          value={promptSearch}
                          onChange={(event) => setPromptSearch(event.target.value)}
                        />
                      </label>
                    </div>

                    <div className="prompt-library-toolbar">
                      <div className="muted small">想快速找灵感时，可以直接随机抽一个模板。</div>
                      <button type="button" className="ghost inline" onClick={applyRandomPromptInspiration}>
                        随机模板
                      </button>
                    </div>

                    {selectedPromptCategory ? (
                      <div className="prompt-library-category-note muted small">{selectedPromptCategory.description}</div>
                    ) : null}

                    <div className="prompt-chip-list" role="tablist" aria-label="提示词模板列表">
                      {filteredPromptItems.map((item) => {
                        const isActive = selectedPromptItem?.title === item.title
                        return (
                          <button
                            key={item.title}
                            type="button"
                            className={`prompt-chip ${isActive ? 'active' : ''}`}
                            onClick={() => setRawSelectedPromptTitle(item.title)}
                          >
                            <span className="prompt-chip-title">{item.title}</span>
                            <span className="prompt-chip-summary">{item.summary}</span>
                          </button>
                        )
                      })}
                    </div>

                    {selectedPromptItem ? (
                      <div className="prompt-preview-card">
                        <div className="prompt-preview-head">
                          <div>
                            <div className="prompt-preview-title-row">
                              <strong>{selectedPromptItem.title}</strong>
                              <button
                                type="button"
                                className="ghost inline small-toggle"
                                onClick={() => setIsPromptPreviewExpanded((value) => !value)}
                              >
                                {isPromptPreviewExpanded ? '折叠模板' : '展开模板'}
                              </button>
                            </div>
                            <div className="muted small">{selectedPromptItem.summary}</div>
                          </div>
                          <a className="prompt-library-source muted small" href={PROMPT_LIBRARY_SOURCE} target="_blank" rel="noreferrer">
                            来源仓库
                          </a>
                        </div>
                        <div className="prompt-tag-row">
                          {selectedPromptItem.tags.map((tag) => (
                            <span className="prompt-tag" key={tag}>
                              {tag}
                            </span>
                          ))}
                        </div>
                        {isPromptPreviewExpanded ? <pre className="prompt-preview-text">{selectedPromptItem.prompt}</pre> : null}
                        <div className="actions prompt-preview-actions">
                          <button type="button" className="ghost" onClick={() => appendPromptInspiration(selectedPromptItem.prompt)}>
                            追加到提示词
                          </button>
                          <button type="button" className="primary" onClick={() => applyPromptInspiration(selectedPromptItem.prompt)}>
                            覆盖填入提示词
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="muted small">当前分类下没有匹配结果，换个关键词试试。</div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="grid two-col prompt-library-controls">
                      <label>
                        案例分类
                        <select value={selectedCaseCategory} onChange={(event) => setSelectedCaseCategory(event.target.value)}>
                          {caseCategories.map((category) => (
                            <option key={category} value={category}>
                              {category}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        搜索案例
                        <input
                          type="text"
                          placeholder="编号 / 标题 / 来源 / 提示词关键词"
                          value={caseSearch}
                          onChange={(event) => setCaseSearch(event.target.value)}
                        />
                      </label>
                    </div>

                    <div className="prompt-library-toolbar">
                      <div className="muted small">
                        当前显示 {filteredPromptCases.length} / {promptCases.length} 个完整案例。{promptCasesUpdatedAt ? ` 最近同步：${new Date(promptCasesUpdatedAt).toLocaleString()}` : ''}
                      </div>
                      <button type="button" className="ghost inline" onClick={() => void syncPromptCases(true)} disabled={promptCasesSyncing}>
                        {promptCasesSyncing ? '同步中…' : '同步案例库'}
                      </button>
                      <button type="button" className="ghost inline" onClick={applyRandomPromptCase}>
                        随机案例
                      </button>
                    </div>

                    <div className="prompt-case-list" role="listbox" aria-label="完整案例列表">
                      {filteredPromptCases.slice(0, 80).map((item) => {
                        const isActive = selectedPromptCase?.number === item.number
                        return (
                          <button
                            key={item.number}
                            type="button"
                            className={`prompt-case-chip ${isActive ? 'active' : ''}`}
                            onClick={() => setRawSelectedCaseNumber(item.number)}
                          >
                            <span className="prompt-case-number">例 {item.number}</span>
                            <span className="prompt-case-title">{item.title}</span>
                            <span className="prompt-case-category">{item.category}</span>
                          </button>
                        )
                      })}
                    </div>
                    {filteredPromptCases.length > 80 ? (
                      <div className="muted small">结果较多，仅展示前 80 条；继续输入关键词可缩小范围。</div>
                    ) : null}

                    {selectedPromptCase ? (
                      <div className="prompt-preview-card">
                        <div className="prompt-preview-head">
                          <div>
                            <div className="prompt-preview-title-row">
                              <strong>例 {selectedPromptCase.number}：{selectedPromptCase.title}</strong>
                              <button
                                type="button"
                                className="ghost inline small-toggle"
                                onClick={() => setIsPromptPreviewExpanded((value) => !value)}
                              >
                                {isPromptPreviewExpanded ? '折叠案例' : '展开案例'}
                              </button>
                            </div>
                            <div className="muted small">{selectedPromptCase.category} · 来源：{selectedPromptCase.source}</div>
                          </div>
                          <a className="prompt-library-source muted small" href={PROMPT_CASE_SOURCE} target="_blank" rel="noreferrer">
                            来源仓库
                          </a>
                        </div>
                        <button
                          type="button"
                          className="prompt-case-preview-image"
                          onClick={() => window.open(selectedPromptCase.imageUrl, '_blank', 'noopener,noreferrer')}
                          aria-label={`打开例 ${selectedPromptCase.number} 预览图`}
                        >
                          <img src={selectedPromptCase.imageUrl} alt={`例 ${selectedPromptCase.number}：${selectedPromptCase.title}`} loading="lazy" />
                        </button>
                        {isPromptPreviewExpanded ? <pre className="prompt-preview-text">{selectedPromptCase.prompt}</pre> : null}
                        <div className="actions prompt-preview-actions">
                          <button type="button" className="ghost" onClick={() => appendPromptCase(selectedPromptCase.prompt)}>
                            追加到提示词
                          </button>
                          <button type="button" className="primary" onClick={() => applyPromptCase(selectedPromptCase.prompt)}>
                            覆盖填入提示词
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="muted small">当前筛选下没有匹配案例，换个关键词试试。</div>
                    )}
                  </>
                )}
              </div>
            ) : null}
          </div>
          <div className="actions stacked">
            <button className="primary" disabled={!canSubmit || imageLoading} onClick={() => void handleGenerateImage()}>
              {imageLoading ? '生成中…' : imageMode === 'edit' ? '图生图' : '生成图片'}
            </button>
          </div>
          </div>
        </details>

        <details className={`field-group settings-section collapsible-section ${mobilePanel !== 'settings' ? 'mobile-section-hidden' : ''}`}>
          <summary className="section-summary">
            <span className="section-title">接口配置</span>
            <span className="summary-hint">可展开修改 Key / Base URL / 模型 / Prompt</span>
          </summary>
          <div className="settings-content">
            <label>
              API Key（聊天）
              <input
                type="password"
                placeholder={serverConfig.hasChatApiKey ? '服务端已配置，可留空' : 'sk-...'}
                value={chatApiKey}
                onChange={(event) => setChatApiKey(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              API Key（生图）
              <input
                type="password"
                placeholder={serverConfig.hasImageApiKey ? '服务端已配置，可留空' : 'sk-...'}
                value={imageApiKey}
                onChange={(event) => setImageApiKey(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              API Base URL
              <input
                type="text"
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
            <div className="grid two-col">
              <label className="model-field">
                聊天模型
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
                  {availableChatModels.map((model) => <option key={model} value={model} />)}
                </datalist>
                <span className="muted small">可选择候选模型或输入自定义模型名。服务端默认：{serverConfig.defaultChatModel || DEFAULT_CHAT_MODEL}</span>
              </label>
              <label>
                图像模型
                <input
                  type="text"
                  list="image-model-options"
                  placeholder={DEFAULT_IMAGE_MODEL}
                  value={imageModel}
                  onChange={(event) => setImageModel(event.target.value)}
                />
                <datalist id="image-model-options">
                  {availableImageModels.map((model) => (
                    <option key={model} value={model}>
                      {model === DEFAULT_IMAGE_MODEL ? '最新 GPT 画图模型' : '兼容模型'}
                    </option>
                  ))}
                </datalist>
                <span className="muted small">可从候选模型中选择，也可以直接输入兼容服务支持的模型名。</span>
              </label>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={saveChatModelAsDefault}
                disabled={isSavingDefaultChatModel}
                onChange={(event) => void handleSaveChatModelAsDefaultToggle(event.target.checked)}
              />
              <span>
                是否设置为默认聊天模型
                <small>{saveChatModelAsDefault ? '输入完成并离开输入框后，同步写入服务端 .env' : '勾选后会把当前聊天模型保存为默认值'}</small>
              </span>
            </label>
            <button className="ghost inline" type="button" onClick={handleUseServerDefaults}>
              使用服务端默认配置
            </button>
            <label>
              System Prompt
              <textarea
                rows={4}
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
              />
            </label>
          </div>
        </details>

        <div className="status-card">
          <span className={`dot ${canSubmit ? 'online' : 'offline'}`} />
          <div>
            <div className="section-title">状态</div>
            <div className="muted small">{status}</div>
            <div className="muted small">
              局域网访问：服务监听 0.0.0.0 后，用本机 IP + 端口访问。
            </div>
            {!hasCredential ? <div className="warning small">需要输入聊天/生图 API Key，或在服务端配置对应 Key。</div> : null}
          </div>
        </div>
        </div>
      </aside>

      <main className={`workspace panel ${mobilePanel !== 'chat' ? 'mobile-hidden' : ''}`}>
        <div className="workspace-header">
          <div>
            <p className="eyebrow">openai-image-chat Workspace</p>
            <h2>聊天与图片结果</h2>
          </div>
          <button className="ghost" onClick={handleReset} disabled={isBusy}>
            清空记录
          </button>
        </div>

        <section className="messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
          {messagesWithHydratedImages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-role">{message.role}</div>
              <div className="message-body">
                <p>{message.content}</p>
                {message.attachments?.length ? (
                  <div className="chat-attachment-grid">
                    {message.attachments.map((attachment) => (
                      <button
                        key={attachment.id}
                        type="button"
                        className="chat-attachment-card"
                        onClick={() => window.open(attachment.objectUrl, '_blank', 'noopener,noreferrer')}
                        aria-label={`打开附件 ${attachment.name}`}
                      >
                        <img src={attachment.objectUrl} alt={attachment.name} />
                        <span>{attachment.name}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {message.images?.length ? (
                  <div className="image-grid">
                    {message.images.map((image, index) => (
                      <div className="image-card" key={`${message.id}-${index}`}>
                        <button
                          type="button"
                          className="image-open"
                          onClick={() => setPreviewImage(image)}
                          aria-label="打开大图预览"
                        >
                          <img src={image.url} alt={image.revisedPrompt || message.imagePrompt || 'generated image'} />
                        </button>
                        <div className="image-meta">
                          <span>{image.revisedPrompt || message.imagePrompt}</span>
                          <a href={image.url} download={`generated-${message.createdAt}-${index + 1}.${image.extension || outputFormat}`}>
                            下载图片
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {message.retryAction ? (
                  <div className="message-actions">
                    <button
                      type="button"
                      className="retry-button"
                      disabled={isBusy || !canSubmit}
                      onClick={() => handleRetry(message.retryAction as RetryAction)}
                    >
                      重试
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </section>

        <section className={`image-history ${isImageHistoryCollapsed ? 'collapsed' : ''}`} aria-label="生成图片记录">
          <button
            type="button"
            className="image-history-header"
            onClick={() => setIsImageHistoryCollapsed((value) => !value)}
            aria-expanded={!isImageHistoryCollapsed}
            aria-controls="image-history-strip"
          >
            <span className="image-history-title">
              <span className="section-title">生成图片记录</span>
              <span className="muted small">
                {generatedImageHistory.length ? `${generatedImageHistory.length} 张` : '暂无生成记录'}
              </span>
            </span>
            <span className="image-history-toggle">{isImageHistoryCollapsed ? '展开' : '收起'}</span>
          </button>
          {!isImageHistoryCollapsed && generatedImageHistory.length ? (
            <div className="image-history-strip" id="image-history-strip">
              {generatedImageHistory.map((image) => (
                <div className="image-history-card" key={image.id}>
                  <button
                    type="button"
                    className="image-history-item"
                    onClick={() => setPreviewImage(image)}
                    title={image.prompt}
                    aria-label="打开历史生成图片大图"
                  >
                    <img src={image.url} alt={image.prompt || '历史生成图片'} />
                    <span>
                      {new Date(image.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="image-history-delete"
                    onClick={() => removeImageHistoryItem(image.id)}
                    aria-label="删除这张图片记录"
                    title="删除图片记录"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="composer">
          <label>
            聊天输入
            <textarea
              rows={5}
              placeholder="输入消息，Enter 发送，Shift + Enter 换行"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={onChatEnter}
              onPaste={handleChatPaste}
            />
          </label>
          <div className="chat-upload-row">
            <label className="chat-upload-button">
              <input type="file" accept="image/*" multiple onChange={handleChatAttachmentChange} />
              上传图片
            </label>
            <div className="chat-upload-hint muted small">
              可上传多张图片，或直接在输入框里粘贴图片（Ctrl/Cmd + V）。
            </div>
          </div>
          {chatAttachments.length ? (
            <div className="chat-attachment-strip">
              {chatAttachments.map((attachment) => (
                <div className="chat-attachment-thumb" key={attachment.id}>
                  <button
                    type="button"
                    className="chat-attachment-remove"
                    onClick={() => removeChatAttachment(attachment.id)}
                    aria-label={`移除 ${attachment.name}`}
                  >
                    ×
                  </button>
                  <img src={attachment.objectUrl} alt={attachment.name} />
                  <span>{attachment.name}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="actions">
            <button className="primary" disabled={!canSubmit || chatLoading} onClick={() => void handleSendChat()}>
              {chatLoading ? '发送中…' : '发送聊天'}
            </button>
          </div>
        </section>
      </main>
      {previewImage ? (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="大图预览" onClick={() => setPreviewImage(null)}>
          <div className="lightbox-toolbar" onClick={(event) => event.stopPropagation()}>
            <a className="lightbox-download" href={previewImage.url} download={`preview.${previewImage.extension || outputFormat}`}>
              下载
            </a>
            <button type="button" className="lightbox-close" onClick={() => setPreviewImage(null)}>
              关闭
            </button>
          </div>
          <img
            className="lightbox-image"
            src={previewImage.url}
            alt={previewImage.revisedPrompt || '大图预览'}
            onClick={(event) => event.stopPropagation()}
          />
          {previewImage.revisedPrompt ? (
            <div className="lightbox-caption" onClick={(event) => event.stopPropagation()}>
              {previewImage.revisedPrompt}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default App
