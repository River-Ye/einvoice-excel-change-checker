import { relativeFilePath, type ChangeRow, type ProcessingRecord } from './domain'
import type { WorkerResponse } from './excel.worker'

export interface RunProgress {
  stage: 'analyzing' | 'building'
  completed: number
  total: number
  currentFile: string
}

export interface RunResult {
  rows: ChangeRow[]
  records: ProcessingRecord[]
  report: ArrayBuffer
}

export interface ProcessingTask {
  promise: Promise<RunResult>
  cancel: () => void
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const abortError = () => new DOMException('已取消', 'AbortError')

export function startProcessing(
  files: File[],
  checkDay: number,
  initialRecords: ProcessingRecord[],
  onProgress: (progress: RunProgress) => void = () => undefined,
  createWorker: () => Worker = () =>
    new Worker(new URL('./excel.worker.ts', import.meta.url), { type: 'module' }),
  startedAt = new Date().toISOString(),
): ProcessingTask {
  let activeWorker: Worker | null = null
  let rejectActive: ((reason: unknown) => void) | null = null
  let rejectAbort: (reason: unknown) => void = () => undefined
  let canceled = false
  let requestId = 0

  const abort = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })

  const request = (message: object, transfer: Transferable[] = []) => {
    const id = ++requestId
    const worker = createWorker()
    activeWorker = worker

    return new Promise<WorkerResponse>((resolve, reject) => {
      rejectActive = reject
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (!canceled && data.id === id) resolve(data)
      }
      worker.onerror = (event) => reject(new Error(event.message || 'Worker 執行失敗'))
      if (transfer.length) worker.postMessage({ id, ...message }, transfer)
      else worker.postMessage({ id, ...message })
    }).finally(() => {
      if (activeWorker === worker) {
        worker.terminate()
        activeWorker = null
      }
      rejectActive = null
    })
  }

  const run = async (): Promise<RunResult> => {
    const rows: ChangeRow[] = []
    const records = initialRecords.map((record) => ({ ...record }))

    for (let index = 0; index < files.length; index += 1) {
      if (canceled) throw abortError()
      const file = files[index] as File
      const item = relativeFilePath(file)
      onProgress({ stage: 'analyzing', completed: index, total: files.length, currentFile: item })

      try {
        const buffer = await file.arrayBuffer()
        if (canceled) throw abortError()
        const response = await request(
          { type: 'analyze', file: buffer, fileName: file.name, checkDay, now: startedAt },
          [buffer],
        )
        if (!response.ok) throw new Error(response.error)
        if (response.type !== 'analyze') throw new Error('Worker 回傳格式錯誤')
        rows.push(...response.rows)
        records.push({
          item,
          status: 'processed',
          changeCount: response.rows.length,
          message: response.rows.length ? '處理完成' : '沒有異動資料',
        })
      } catch (error) {
        if (canceled || (error instanceof DOMException && error.name === 'AbortError')) throw error
        records.push({ item, status: 'skipped', changeCount: 0, message: errorMessage(error) })
      }
    }

    if (canceled) throw abortError()
    onProgress({ stage: 'building', completed: files.length, total: files.length, currentFile: '' })
    const response = await request({ type: 'buildReport', rows, records })
    if (!response.ok) throw new Error(response.error)
    if (response.type !== 'buildReport') throw new Error('Worker 回傳格式錯誤')
    return { rows, records, report: response.file }
  }

  return {
    promise: Promise.race([run(), abort]),
    cancel() {
      if (canceled) return
      canceled = true
      activeWorker?.terminate()
      activeWorker = null
      rejectActive?.(abortError())
      rejectAbort(abortError())
    },
  }
}
