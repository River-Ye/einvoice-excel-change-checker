import { describe, expect, it, vi } from 'vitest'

import { startProcessing, type RunProgress } from '../runner'

type AnalyzeOutcome =
  | { outcome: 'processed'; rows: Array<{ taxId: string; fileName: string; documentNumber: string }> }
  | { outcome: 'workbook-skipped' | 'non-workbook'; message: string }

type WorkerMessage = MessageEvent<
  | ({ id: number; ok: true; type: 'analyze' } & AnalyzeOutcome)
  | { id: number; ok: true; type: 'buildReport'; file: ArrayBuffer }
  | { id: number; ok: false; error: string }
>

class FakeWorker {
  onmessage: ((event: WorkerMessage) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
}

const signatures = {
  ooxml: [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0],
  xls: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
} as const

function file(name: string, path: string, signature: readonly number[], size = 32) {
  const header = Uint8Array.from(signature).buffer
  return {
    name,
    size,
    webkitRelativePath: path,
    slice: vi.fn(() => ({ arrayBuffer: vi.fn().mockResolvedValue(header) })),
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(Math.min(size, 32))),
  } as unknown as File
}

async function nextTick(times = 12) {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

describe('startProcessing', () => {
  it('掃描所有檔案，只把內容候選循序送進 Worker，並傳完整路徑與日期但不傳統編', async () => {
    const processed = file('任意名稱.data', '來源/12345678/任意名稱.data', signatures.ooxml)
    const unsupported = file(
      '87654321_舊格式.bin',
      '來源/子資料/87654321_舊格式.bin',
      signatures.xls,
    )
    const archive = file('archive.zip', '來源/子資料/archive.zip', signatures.ooxml)
    const disguisedPdf = file('偽裝.xlsx', '來源/偽裝.xlsx', signatures.pdf)
    const workers: FakeWorker[] = []
    const progress: RunProgress[] = []
    const task = startProcessing(
      [disguisedPdf, unsupported, archive, processed],
      '2026-07-08',
      (value) => progress.push(value),
      () => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker as unknown as Worker
      },
    )
    void task.promise.catch(() => undefined)

    await nextTick()
    expect(workers).toHaveLength(1)
    expect(workers[0]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'analyze',
        relativePath: '來源/12345678/任意名稱.data',
        checkDate: '2026-07-08',
      }),
      expect.any(Array),
    )
    expect(workers[0]?.postMessage.mock.calls[0]?.[0]).not.toHaveProperty('taxId')
    expect(workers[0]?.postMessage.mock.calls[0]?.[0]).not.toHaveProperty('checkDay')
    expect(workers[0]?.postMessage.mock.calls[0]?.[0]).not.toHaveProperty('now')

    workers[0]?.onmessage?.({
      data: {
        id: 1,
        ok: true,
        type: 'analyze',
        outcome: 'processed',
        rows: [
          {
            taxId: '12345678',
            fileName: '來源/12345678/任意名稱.data',
            documentNumber: 'AB001',
          },
        ],
      },
    } as WorkerMessage)
    await nextTick()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    expect(workers).toHaveLength(2)
    expect(workers[1]?.postMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: 'analyze',
        relativePath: '來源/子資料/87654321_舊格式.bin',
        checkDate: '2026-07-08',
      }),
    )
    expect(workers[1]?.postMessage.mock.calls[0]?.[0]).not.toHaveProperty('taxId')

    workers[1]?.onmessage?.({
      data: {
        id: 2,
        ok: true,
        type: 'analyze',
        outcome: 'workbook-skipped',
        message: '找不到支援的工作表',
      },
    } as WorkerMessage)
    await nextTick()
    expect(workers).toHaveLength(3)
    expect(workers[2]?.postMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: 'analyze',
        relativePath: '來源/子資料/archive.zip',
        checkDate: '2026-07-08',
      }),
    )
    expect(workers[2]?.postMessage.mock.calls[0]?.[0]).not.toHaveProperty('taxId')

    workers[2]?.onmessage?.({
      data: {
        id: 3,
        ok: true,
        type: 'analyze',
        outcome: 'non-workbook',
        message: '不是 Excel 活頁簿',
      },
    } as WorkerMessage)
    await nextTick()

    expect(workers).toHaveLength(4)
    expect(workers[3]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'buildReport',
        rows: [expect.objectContaining({ documentNumber: 'AB001' })],
        records: [
          expect.objectContaining({
            item: '來源/12345678/任意名稱.data',
            status: 'processed',
            changeCount: 1,
          }),
          expect.objectContaining({
            item: '來源/子資料/87654321_舊格式.bin',
            status: 'skipped',
            message: '找不到支援的工作表',
          }),
          expect.objectContaining({
            item: 'PDF 檔案',
            status: 'skipped',
            message: expect.stringMatching(/1.*PDF/),
          }),
          expect.objectContaining({
            item: '無法確認的工作簿容器',
            status: 'skipped',
            message: expect.stringMatching(/1.*容器/),
          }),
        ],
      }),
    )

    const report = new ArrayBuffer(8)
    workers[3]?.onmessage?.({
      data: { id: 4, ok: true, type: 'buildReport', file: report },
    } as WorkerMessage)
    await expect(task.promise).resolves.toMatchObject({
      rows: [expect.objectContaining({ documentNumber: 'AB001' })],
      report,
      summary: {
        totalFiles: 4,
        scannedFiles: 4,
        excelFiles: 2,
        processedExcelFiles: 1,
        skippedExcelFiles: 1,
        nonExcelFiles: 2,
      },
    })

    for (const candidate of [processed, unsupported, archive]) {
      expect(candidate.slice).toHaveBeenCalledWith(0, 8)
      expect(candidate.arrayBuffer).toHaveBeenCalledOnce()
    }
    expect(disguisedPdf.slice).toHaveBeenCalledWith(0, 8)
    expect(disguisedPdf.arrayBuffer).not.toHaveBeenCalled()
    expect(progress[progress.length - 1]).toEqual({
      stage: 'building',
      completed: 4,
      total: 4,
      currentFile: '',
      summary: {
        totalFiles: 4,
        scannedFiles: 4,
        excelFiles: 2,
        processedExcelFiles: 1,
        skippedExcelFiles: 1,
        nonExcelFiles: 2,
      },
    })
  })

  it('超過 100 個檔案仍全部掃描，非 Excel 只建立合計紀錄', async () => {
    const files = Array.from({ length: 101 }, (_, index) =>
      file(
        `${index}.xlsx`,
        `來源/${String(index).padStart(3, '0')}.xlsx`,
        index < 51 ? signatures.pdf : [0x74, 0x65, 0x78, 0x74],
      ),
    )
    const workers: FakeWorker[] = []
    const task = startProcessing(files, '2026-07-08', undefined, () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker as unknown as Worker
    })
    void task.promise.catch(() => undefined)

    await vi.waitFor(() => expect(workers).toHaveLength(1))
    expect(workers[0]?.postMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: 'buildReport',
        records: [
          expect.objectContaining({ item: 'PDF 檔案', message: expect.stringMatching(/51.*PDF/) }),
          expect.objectContaining({
            item: '其他非 Excel 檔案',
            message: expect.stringMatching(/50.*非 Excel/),
          }),
        ],
      }),
    )
    workers[0]?.onmessage?.({
      data: { id: 1, ok: true, type: 'buildReport', file: new ArrayBuffer(1) },
    } as WorkerMessage)

    await expect(task.promise).resolves.toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({ item: 'PDF 檔案', message: expect.stringMatching(/51.*PDF/) }),
        expect.objectContaining({ item: '其他非 Excel 檔案', message: expect.stringMatching(/50.*非 Excel/) }),
      ]),
      summary: { totalFiles: 101, scannedFiles: 101, nonExcelFiles: 101 },
    })
    expect(files.every((item) => vi.mocked(item.arrayBuffer).mock.calls.length === 0)).toBe(true)
  })

  it('超過 100 MiB 的 Excel 候選只讀取檔頭並記錄略過', async () => {
    const huge = file(
      '大檔案',
      '來源/12345678/大檔案',
      signatures.ooxml,
      100 * 1024 * 1024 + 1,
    )
    const workers: FakeWorker[] = []
    const task = startProcessing([huge], '2026-07-08', undefined, () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker as unknown as Worker
    })
    void task.promise.catch(() => undefined)

    await vi.waitFor(() => expect(workers).toHaveLength(1))
    expect(huge.arrayBuffer).not.toHaveBeenCalled()
    expect(workers[0]?.postMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: 'buildReport',
        records: [
          expect.objectContaining({
            item: '來源/12345678/大檔案',
            message: '檔案超過 100 MiB',
          }),
        ],
      }),
    )
    workers[0]?.onmessage?.({
      data: { id: 1, ok: true, type: 'buildReport', file: new ArrayBuffer(1) },
    } as WorkerMessage)
    await expect(task.promise).resolves.toMatchObject({
      summary: { totalFiles: 1, scannedFiles: 1, excelFiles: 1, skippedExcelFiles: 1 },
    })
  })

  it('取消時終止 Worker、拒絕工作並忽略遲到訊息', async () => {
    const worker = new FakeWorker()
    const task = startProcessing(
      [file('invoice', '來源/12345678/invoice', signatures.ooxml)],
      '2026-07-08',
      undefined,
      () => worker as unknown as Worker,
    )
    void task.promise.catch(() => undefined)

    await nextTick()
    task.cancel()
    expect(worker.terminate).toHaveBeenCalledOnce()
    await expect(task.promise).rejects.toMatchObject({ name: 'AbortError' })

    expect(() =>
      worker.onmessage?.({
        data: { id: 1, ok: true, type: 'analyze', outcome: 'processed', rows: [] },
      } as unknown as WorkerMessage),
    ).not.toThrow()
  })
})
