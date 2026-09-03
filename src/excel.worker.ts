import { detectFileKind, type ChangeRow, type ProcessingRecord } from './domain'
import { analyzeWorkbook, buildReport } from './workbook'

export type AnalyzeOutcome =
  | { outcome: 'processed'; rows: ChangeRow[] }
  | { outcome: 'workbook-skipped' | 'non-workbook'; message: string; rows: ChangeRow[] }

export type WorkerRequest =
  | {
      id: number
      type: 'analyze'
      file: ArrayBuffer
      relativePath: string
      checkDate: string
    }
  | {
      id: number
      type: 'buildReport'
      rows: ChangeRow[]
      records: ProcessingRecord[]
    }

export type WorkerResponse =
  | ({ id: number; ok: true; type: 'analyze' } & AnalyzeOutcome)
  | { id: number; ok: true; type: 'buildReport'; file: ArrayBuffer }
  | { id: number; ok: false; error: string }

export function handleWorkerRequest(request: WorkerRequest): WorkerResponse {
  try {
    if (request.type === 'analyze') {
      try {
        return {
          id: request.id,
          ok: true,
          type: 'analyze',
          outcome: 'processed',
          rows: analyzeWorkbook(request.file, {
            relativePath: request.relativePath,
            checkDate: request.checkDate,
          }),
        }
      } catch (error) {
        const kind = detectFileKind(request.file)
        if (kind !== 'ooxml' && kind !== 'xls') throw error
        const message = error instanceof Error ? error.message : '無法處理 Excel 活頁簿'
        return {
          id: request.id,
          ok: true,
          type: 'analyze',
          outcome: message.startsWith('無法讀取 Excel') ? 'non-workbook' : 'workbook-skipped',
          message: message.startsWith('無法讀取 Excel') ? '不是 Excel 活頁簿' : message,
          rows: [],
        }
      }
    }

    return {
      id: request.id,
      ok: true,
      type: 'buildReport',
      file: buildReport(request.rows, request.records),
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : '處理 Excel 時發生未知錯誤',
    }
  }
}

if (typeof document === 'undefined') {
  const workerScope = self as unknown as {
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
    postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void
  }

  workerScope.onmessage = ({ data }) => {
    const response = handleWorkerRequest(data)
    workerScope.postMessage(
      response,
      response.ok && response.type === 'buildReport' ? [response.file] : undefined,
    )
  }
}
