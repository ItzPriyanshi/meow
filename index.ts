import { Elysia, t } from 'elysia'
import { staticPlugin } from '@elysiajs/static'
import { Innertube, Platform, Types, UniversalCache } from 'youtubei.js/web'
import ffmpeg from 'ffmpeg-static'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import instaHandler from './api/insta'
import instav2Handler from './api/instav2'
import fbHandler from './api/fb'
import pinHandler, { searchPinterest, getCacheStats, clearCaches } from './api/pin'
import ttHandler from './api/tt'
import xHandler from './api/x'

Platform.shim.eval = async (data: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
  const properties = []
  if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`)
  if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`)
  const code = `${data.output}
return { ${properties.join(', ')} }`
  return new Function(code)()
}

const PORT = 3040
const BUN_IDLE_TIMEOUT = 255
const EXPIRATION_SECONDS = 180
const MAX_CONCURRENT_DOWNLOADS = 16
const DOWNLOAD_CHUNK_SIZE_MB = 10
const COOKIE_FILE_PATH = 'cookies.txt'
const CACHE_EXPIRATION_MS = 3 * 60 * 1000

function getClientId(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const realIp = request.headers.get('x-real-ip')
  const cfConnecting = request.headers.get('cf-connecting-ip')
  return forwarded?.split(',')[0].trim() || realIp || cfConnecting || 'unknown'
}

type YTFormat = NonNullable<Awaited<ReturnType<Innertube['getBasicInfo']>>['streaming_data']>['formats'][number] & {
  content_length: number
  is_original?: boolean
  deciphered_url?: string
}

interface DownloadTask {
  index: number
  format: YTFormat
  start: number
  end: number
  description: string
  retries: number
}

interface DownloadSession {
  status: 'pending' | 'downloading' | 'merging' | 'completed' | 'error'
  videoFormat?: YTFormat
  audioFormat: YTFormat
  tempDir: string
  tempVideoFile?: string
  tempAudioFile: string
  finalFilename: string
  finalFilePath: string
  videoTasks: DownloadTask[]
  audioTasks: DownloadTask[]
  error?: string
  isAudioOnly: boolean
  createdAt: number
  cleanupTimeoutId: NodeJS.Timeout | null
}

interface CacheEntry {
  timestamp: number
  data: any
}

const downloadSessions = new Map<string, DownloadSession>()
const infoCache = new Map<string, CacheEntry>()
let yt: Innertube

async function getCookieFileContent(cookieFilePath: string): Promise<string> {
  const cookieFile = Bun.file(cookieFilePath)
  if (!(await cookieFile.exists())) {
    console.warn(`🔴 WARNING: Cookie file not found at '${cookieFilePath}'`)
    return ''
  }
  try {
    const content = await cookieFile.text()
    console.log(`✅ Cookies loaded from ${cookieFilePath}`)
    return content
  } catch (err) {
    console.error('Error reading cookies:', err)
    return ''
  }
}

function getVideoId(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname.includes('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v')
      const m = u.pathname.match(/^/(shorts|live|embed)/([a-zA-Z0-9_-]{11})/)
      if (m) return m[2]
    }
    if (u.hostname.includes('youtu.be')) return u.pathname.split('/')[1]
  } catch {}
  return null
}

function formatBytes(bytes: number, decimals = 2): string {
  if (!bytes) return '0 Bytes'
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${['Bytes', 'KiB', 'MiB', 'GiB'][i]}`
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds >= 60) {
    const m = Math.floor(totalSeconds / 60)
    return `${m} minute${m > 1 ? 's' : ''}`
  }
  const s = Math.floor(totalSeconds)
  return `${s} second${s > 1 ? 's' : ''}`
}

async function downloadAndCombineManager(sessionId: string, tasks: DownloadTask[], destinationFile: string) {
  const startTime = performance.now()
  const totalSize = tasks.reduce((sum, t) => sum + (t.end - t.start + 1), 0)
  const actualWorkers = Math.min(tasks.length, MAX_CONCURRENT_DOWNLOADS)
  console.log(`[${sessionId}] Starting combined download of ${tasks.length} chunks for ${destinationFile.split('/').pop()}...`)
  const downloadedChunks = new Map<number, Buffer>()
  let chunksWritten = 0
  const writer = Bun.file(destinationFile).writer()
  const processTask = async (task: DownloadTask, workerId: number) => {
    let attempt = 0
    const url = task.format.deciphered_url
    if (!url) throw new Error(`Task ${task.description} missing deciphered URL.`)
    while (attempt <= task.retries) {
      try {
        const resp = await fetch(url, { headers: { Range: `bytes=${task.start}-${task.end}` } })
        if (!resp.ok) throw new Error(`Fetch failed ${resp.status}`)
        const buf = Buffer.from(await resp.arrayBuffer())
        downloadedChunks.set(task.index, buf)
        while (downloadedChunks.has(chunksWritten)) {
          writer.write(downloadedChunks.get(chunksWritten)!)
          downloadedChunks.delete(chunksWritten)
          chunksWritten++
        }
        return
      } catch {
        if (attempt < task.retries) {
          attempt++
          await new Promise(r => setTimeout(r, 250 * attempt))
        } else throw new Error(`Task ${task.description} failed.`)
      }
    }
  }
  const tasksToProcess = [...tasks]
  const workers = Array.from({ length: actualWorkers }, (_, i) =>
    (async () => {
      const id = i + 1
      while (tasksToProcess.length > 0) {
        const task = tasksToProcess.shift()
        if (task) await processTask(task, id)
      }
    })()
  )
  await Promise.all(workers)
  await writer.end()
  const duration = (performance.now() - startTime) / 1000
  console.log(`[${sessionId}] Completed: ${formatBytes(totalSize)} in ${duration.toFixed(2)}s`)
}

async function cleanupSession(sessionId: string) {
  const session = downloadSessions.get(sessionId)
  if (session) {
    if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId)
    downloadSessions.delete(sessionId)
    await rm(session.tempDir, { recursive: true, force: true })
  }
}

function scheduleSessionCleanup(sessionId: string, delayMs: number) {
  const session = downloadSessions.get(sessionId)
  if (!session) return
  if (session.cleanupTimeoutId) clearTimeout(session.cleanupTimeoutId)
  session.cleanupTimeoutId = setTimeout(() => cleanupSession(sessionId), delayMs)
}

const app = new Elysia()
  .use(staticPlugin({ assets: 'public', prefix: '', alwaysStatic: true }))
  .onStart(async () => {
    await mkdir(join(process.cwd(), 'temp'), { recursive: true })
    const cookie = await getCookieFileContent(COOKIE_FILE_PATH)
    yt = await Innertube.create({ cookie, cache: new UniversalCache(true), player_id: '0004de42' })
    console.log('✅ Innertube ready')
  })
  .get('/', () => new Response(Bun.file('public/home.html')))
  .get('/robots.txt', () => new Response(['User-agent: *', 'Disallow: /'].join('
'), { headers: { 'Content-Type': 'text/plain' } }))
  .listen({ port: PORT, idleTimeout: BUN_IDLE_TIMEOUT })

console.log(`🦊 Elysia YouTube API running at http://localhost:${app.server?.port}`)