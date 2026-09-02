import {
  MAX_FILE_BYTES,
  detectFileKind,
  extractTaxId,
  getTaipeiThreshold,
  relativeFilePath,
  sortFiles,
  type ChangeRow,
  type ProcessingRecord,
} from './domain'
import type { WorkerResponse } from './excel.worker'

export interface RunSummary {
  totalFiles: number
  scannedFiles: number
  excelFiles: number
  processedExcelFiles: number
  skippedExcelFiles: number
  nonExcelFiles: number
}

export interface RunProgress {
  stage: 'analyzing' | 'building'
  completed: number
  total: number
  currentFile: string
  summary: RunSummary
}

export interface RunResult {
  rows: ChangeRow[]
  records: ProcessingRecord[]
  report: ArrayBuffer
  summary: RunSummary
}

export interface ProcessingTask {
  promise: Promise<RunResult>
  cancel: () => void
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const abortError = () => new DOMException('已取消', 'AbortError')
const skipped = (item: string, message: string): ProcessingRecord => ({
  item,
  status: 'skipped',
  changeCount: 0,
  message,
})

export function startProcessing(
  files: File[],
  checkDate: string,
  onProgress: (progress: RunProgress) => void = () => undefined,
  createWorker: () => Worker = () =>
    new Worker(new URL('./excel.worker.ts', import.meta.url), { type: 'module' }),
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
    getTaipeiThreshold(checkDate)
    const sortedFiles = sortFiles(files)
    const rows: ChangeRow[] = []
    const records: ProcessingRecord[] = []
    const nonExcel = { pdf: 0, other: 0, container: 0 }
    const summary: RunSummary = {
      totalFiles: sortedFiles.length,
      scannedFiles: 0,
      excelFiles: 0,
      processedExcelFiles: 0,
      skippedExcelFiles: 0,
      nonExcelFiles: 0,
    }
    const notify = (stage: RunProgress['stage'], currentFile = '') =>
      onProgress({
        stage,
        completed: summary.scannedFiles,
        total: summary.totalFiles,
        currentFile,
        summary: { ...summary },
      })

    for (const file of sortedFiles) {
      if (canceled) throw abortError()
      const item = relativeFilePath(file)
      notify('analyzing', item)

      try {
        const kind = detectFileKind(await file.slice(0, 8).arrayBuffer())
        if (canceled) throw abortError()

        if (kind !== 'ooxml' && kind !== 'xls') {
          summary.nonExcelFiles += 1
          nonExcel[kind === 'pdf' ? 'pdf' : 'other'] += 1
          continue
        }

        if (file.size > MAX_FILE_BYTES) {
          summary.excelFiles += 1
          summary.skippedExcelFiles += 1
          records.push(skipped(item, '檔案超過 100 MiB'))
          continue
        }

        const buffer = await file.arrayBuffer()
        if (canceled) throw abortError()
        const response = await request(
          {
            type: 'analyze',
            file: buffer,
            relativePath: item,
            taxId: extractTaxId(item),
            checkDate,
          },
          [buffer],
        )
        if (!response.ok) throw new Error(response.error)
        if (response.type !== 'analyze') throw new Error('Worker 回傳格式錯誤')

        if (response.outcome === 'non-workbook') {
          summary.nonExcelFiles += 1
          nonExcel.container += 1
          continue
        }

        summary.excelFiles += 1
        if (response.outcome === 'workbook-skipped') {
          summary.skippedExcelFiles += 1
          records.push(skipped(item, response.message))
          continue
        }

        summary.processedExcelFiles += 1
        rows.push(...response.rows)
        records.push({
          item,
          status: 'processed',
          changeCount: response.rows.length,
          message: response.rows.length ? '處理完成' : '沒有異動資料',
        })
      } catch (error) {
        if (canceled || (error instanceof DOMException && error.name === 'AbortError')) throw error
        summary.excelFiles += 1
        summary.skippedExcelFiles += 1
        records.push(skipped(item, errorMessage(error)))
      } finally {
        summary.scannedFiles += 1
      }
    }

    if (nonExcel.pdf) records.push(skipped('PDF 檔案', `已略過 ${nonExcel.pdf} 個 PDF 檔案`))
    if (nonExcel.other) {
      records.push(skipped('其他非 Excel 檔案', `已略過 ${nonExcel.other} 個其他非 Excel 檔案`))
    }
    if (nonExcel.container) {
      records.push(
        skipped(
          '無法確認的工作簿容器',
          `已略過 ${nonExcel.container} 個無法確認的工作簿容器`,
        ),
      )
    }
    if (canceled) throw abortError()
    notify('building')
    const response = await request({ type: 'buildReport', rows, records })
    if (!response.ok) throw new Error(response.error)
    if (response.type !== 'buildReport') throw new Error('Worker 回傳格式錯誤')
    return { rows, records, report: response.file, summary: { ...summary } }
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
