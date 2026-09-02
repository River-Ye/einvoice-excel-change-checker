import { describe, expect, it, vi } from 'vitest'
import { isProxy, reactive } from 'vue'

import { startProcessing, type RunProgress } from '../runner'

type WorkerMessage = MessageEvent<{
  id: number
  ok: boolean
  type?: 'analyze' | 'buildReport'
  rows?: Array<{ taxId: string; fileName: string; documentNumber: string }>
  file?: ArrayBuffer
  error?: string
}>

class FakeWorker {
  onmessage: ((event: WorkerMessage) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
}

function file(name: string, path = name) {
  return {
    name,
    size: 4,
    webkitRelativePath: path,
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
  } as unknown as File
}

async function nextTick() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('startProcessing', () => {
  it('送進 Worker 前會解除 Vue Proxy', async () => {
    const worker = new FakeWorker()
    const record = reactive({
      item: '其他副檔名',
      status: 'skipped' as const,
      changeCount: 0,
      message: '已略過 1 個非 XLSX 檔案',
    })
    const task = startProcessing([], 8, [record], undefined, () => worker as unknown as Worker)
    const postedRecord = worker.postMessage.mock.calls[0]?.[0].records[0]

    expect(isProxy(record)).toBe(true)
    expect(isProxy(postedRecord)).toBe(false)
    expect(postedRecord).toEqual(record)

    const report = new ArrayBuffer(1)
    worker.onmessage?.({
      data: { id: 1, ok: true, type: 'buildReport', file: report },
    } as unknown as WorkerMessage)
    await expect(task.promise).resolves.toMatchObject({ report })
  })

  it('逐檔建立並終止 Worker，最後才建立報表', async () => {
    const workers: FakeWorker[] = []
    const progress: RunProgress[] = []
    const task = startProcessing(
      [file('12345678_a.xlsx', '來源/12345678_a.xlsx'), file('87654321_b.xlsx')],
      8,
      [],
      (value) => progress.push(value),
      () => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker as unknown as Worker
      },
      '2026-08-31T16:01:00.000Z',
    )

    await nextTick()
    expect(workers).toHaveLength(1)
    expect(workers[0]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'analyze', fileName: '12345678_a.xlsx', checkDay: 8 }),
      expect.any(Array),
    )

    workers[0]?.onmessage?.({
      data: {
        id: 1,
        ok: true,
        type: 'analyze',
        rows: [{ taxId: '12345678', fileName: '12345678_a.xlsx', documentNumber: 'AB001' }],
      },
    } as unknown as WorkerMessage)
    await nextTick()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    expect(workers).toHaveLength(2)
    expect(workers[1]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'analyze',
        now: '2026-08-31T16:01:00.000Z',
      }),
      expect.any(Array),
    )
    expect(workers[0]?.postMessage.mock.calls[0]?.[0].now).toBe('2026-08-31T16:01:00.000Z')

    workers[1]?.onmessage?.({ data: { id: 2, ok: false, error: '檔案損壞' } } as unknown as WorkerMessage)
    await nextTick()
    expect(workers[1]?.terminate).toHaveBeenCalledOnce()
    expect(workers).toHaveLength(3)
    expect(workers[2]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'buildReport',
        rows: [expect.objectContaining({ documentNumber: 'AB001' })],
        records: [
          expect.objectContaining({ item: '來源/12345678_a.xlsx', status: 'processed', changeCount: 1 }),
          expect.objectContaining({ item: '87654321_b.xlsx', status: 'skipped', message: '檔案損壞' }),
        ],
      }),
    )

    const report = new ArrayBuffer(8)
    workers[2]?.onmessage?.({
      data: { id: 3, ok: true, type: 'buildReport', file: report },
    } as unknown as WorkerMessage)
    await expect(task.promise).resolves.toEqual({
      rows: [{ taxId: '12345678', fileName: '12345678_a.xlsx', documentNumber: 'AB001' }],
      records: [
        expect.objectContaining({ status: 'processed', changeCount: 1 }),
        expect.objectContaining({ status: 'skipped', changeCount: 0 }),
      ],
      report,
    })
    expect(workers[2]?.terminate).toHaveBeenCalledOnce()
    expect(progress).toEqual([
      { stage: 'analyzing', completed: 0, total: 2, currentFile: '來源/12345678_a.xlsx' },
      { stage: 'analyzing', completed: 1, total: 2, currentFile: '87654321_b.xlsx' },
      { stage: 'building', completed: 2, total: 2, currentFile: '' },
    ])
  })

  it('取消時終止 Worker、拒絕工作並忽略遲到訊息', async () => {
    const worker = new FakeWorker()
    const task = startProcessing([file('12345678_a.xlsx')], 8, [], undefined, () => worker as unknown as Worker)

    await nextTick()
    task.cancel()
    expect(worker.terminate).toHaveBeenCalledOnce()
    await expect(task.promise).rejects.toMatchObject({ name: 'AbortError' })

    expect(() =>
      worker.onmessage?.({
        data: { id: 1, ok: true, type: 'analyze', rows: [] },
      } as unknown as WorkerMessage),
    ).not.toThrow()
  })
})
