import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element #root not found')
}

try {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  rootElement.innerHTML = `
    <div style="min-height:100vh;padding:24px;background:#121110;color:#eee9e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <h1 style="margin:0 0 12px;font-size:22px;">页面启动失败</h1>
      <p style="color:#98a2b3;line-height:1.6;">浏览器执行前端代码时出错。请刷新页面；如果仍失败，把下面错误发给开发者。</p>
      <pre style="white-space:pre-wrap;word-break:break-word;padding:14px;border-radius:12px;background:#1a1917;color:#ffd08a;">${message}</pre>
    </div>
  `
}
