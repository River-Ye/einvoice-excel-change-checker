import type { ChangeRow, ProcessingRecord } from './domain'
import { analyzeWorkbook, buildReport } from './workbook'

export type WorkerRequest =
  | {
      id: number
      type: 'analyze'
      file: ArrayBuffer
      fileName: string
      checkDay: number
      now?: string
    }
  | {
      id: number
      type: 'buildReport'
      rows: ChangeRow[]
      records: ProcessingRecord[]
    }

export type WorkerResponse =
  | { id: number; ok: true; type: 'analyze'; rows: ChangeRow[] }
  | { id: number; ok: true; type: 'buildReport'; file: ArrayBuffer }
  | { id: number; ok: false; error: string }

export function handleWorkerRequest(request: WorkerRequest): WorkerResponse {
  try {
    if (request.type === 'analyze') {
      return {
        id: request.id,
        ok: true,
        type: 'analyze',
        rows: analyzeWorkbook(request.file, {
          fileName: request.fileName,
          checkDay: request.checkDay,
          now: request.now,
        }),
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
