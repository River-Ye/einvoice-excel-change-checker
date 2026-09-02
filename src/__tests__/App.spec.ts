import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startProcessing } = vi.hoisted(() => ({ startProcessing: vi.fn() }))
vi.mock('../runner', () => ({ startProcessing }))

import App from '../App.vue'

const summary = (overrides: Record<string, number> = {}) => ({
  totalFiles: 1,
  scannedFiles: 1,
  excelFiles: 1,
  processedExcelFiles: 1,
  skippedExcelFiles: 0,
  nonExcelFiles: 0,
  ...overrides,
})

function selectedFile(name = '任意名稱', path = `申報資料/12345678/${name}`) {
  const file = new File(['test'], name)
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

async function selectFiles(wrapper: ReturnType<typeof mount>, files: File[]) {
  const input = wrapper.get('#source-folder')
  Object.defineProperty(input.element, 'files', { configurable: true, value: files })
  await input.trigger('change')
}

describe('App', () => {
  beforeEach(() => {
    startProcessing.mockReset()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:report'),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('以原生日曆帶入台北當月 8 日，且不限制可選年月日', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T16:30:00.000Z'))
    const wrapper = mount(App)

    expect(wrapper.findAll('.step')).toHaveLength(3)
    expect(wrapper.get('label[for="source-folder"]').text()).toContain('選擇來源資料夾')
    expect(wrapper.get('#source-folder').attributes()).toHaveProperty('webkitdirectory')
    expect(wrapper.get('label[for="check-date"]').text()).toContain('異動檢查門檻')
    const date = wrapper.get('#check-date')
    expect(date.attributes('type')).toBe('date')
    expect((date.element as HTMLInputElement).value).toBe('2026-08-08')
    expect(date.attributes('min')).toBeUndefined()
    expect(date.attributes('max')).toBeUndefined()
  })

  it('把子資料夾內所有檔案交給掃描，並原樣傳遞使用者選擇的過去日期', async () => {
    const files = [
      selectedFile('發票資料', '申報資料/12345678/發票資料'),
      selectedFile('說明.txt', '申報資料/附件/說明.txt'),
      selectedFile('偽裝.xlsx', '申報資料/深層/附件/偽裝.xlsx'),
    ]
    startProcessing.mockReturnValue({ cancel: vi.fn(), promise: new Promise(() => undefined) })
    const wrapper = mount(App)

    await selectFiles(wrapper, files)
    expect(wrapper.text()).toContain('3 個檔案')
    expect(wrapper.get('button[data-action="start"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('#check-date').setValue('2025-02-03')
    await wrapper.get('button[data-action="start"]').trigger('click')

    expect(startProcessing).toHaveBeenCalledWith(
      files,
      '2025-02-03',
      expect.any(Function),
      undefined,
    )
  })

  it('101 個以上的檔案不阻止執行', async () => {
    const files = Array.from({ length: 146 }, (_, index) =>
      selectedFile(`檔案-${index}`, `申報資料/子資料/${String(index).padStart(3, '0')}`),
    )
    startProcessing.mockReturnValue({ cancel: vi.fn(), promise: new Promise(() => undefined) })
    const wrapper = mount(App)

    await selectFiles(wrapper, files)
    expect(wrapper.text()).not.toContain('最多處理 100 個')
    expect(wrapper.get('button[data-action="start"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('button[data-action="start"]').trigger('click')
    expect(startProcessing).toHaveBeenCalledOnce()
    expect(startProcessing.mock.calls[0]?.[0]).toHaveLength(146)
  })

  it('執行中顯示全部檔案為分母的掃描摘要與目前路徑', async () => {
    startProcessing.mockImplementation(
      (_files, _checkDate, thirdArgument, legacyOnProgress) => {
        const onProgress =
          typeof thirdArgument === 'function' ? thirdArgument : legacyOnProgress
        onProgress({
          stage: 'analyzing',
          completed: 2,
          total: 4,
          currentFile: '申報資料/深層/目前檔案',
          summary: summary({
            totalFiles: 4,
            scannedFiles: 2,
            excelFiles: 1,
            processedExcelFiles: 1,
            nonExcelFiles: 1,
          }),
        })
        return { cancel: vi.fn(), promise: new Promise(() => undefined) }
      },
    )
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    await wrapper.get('button[data-action="start"]').trigger('click')

    expect(wrapper.get('progress').attributes('max')).toBe('4')
    expect(wrapper.text()).toContain('2 / 4')
    expect(wrapper.text()).toContain('申報資料/深層/目前檔案')
    expect(wrapper.text()).toMatch(/Excel\s*1/)
    expect(wrapper.text()).toMatch(/完成\s*1/)
    expect(wrapper.text()).toMatch(/非 Excel\s*1/)
  })

  it('完成後顯示完整相對路徑、掃描摘要、處理紀錄並提供下載', async () => {
    startProcessing.mockReturnValue({
      cancel: vi.fn(),
      promise: Promise.resolve({
        rows: [
          {
            taxId: '12345678',
            fileName: '申報資料/12345678/任意名稱',
            documentNumber: 'AB0001',
          },
        ],
        records: [
          {
            item: '申報資料/12345678/任意名稱',
            status: 'processed',
            changeCount: 1,
            message: '處理完成',
          },
          {
            item: '非 Excel 檔案',
            status: 'skipped',
            changeCount: 0,
            message: '已略過 1 個非 Excel 檔案',
          },
        ],
        report: new ArrayBuffer(8),
        summary: summary({ totalFiles: 2, scannedFiles: 2, nonExcelFiles: 1 }),
      }),
    })
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    await wrapper.get('button[data-action="start"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('table[data-table="results"]').text()).toContain(
      '申報資料/12345678/任意名稱',
    )
    expect(wrapper.text()).toContain('AB0001')
    expect(wrapper.text()).toMatch(/掃描\s*2/)
    expect(wrapper.text()).toMatch(/Excel\s*1/)
    expect(wrapper.get('details').text()).toContain('已略過 1 個非 Excel 檔案')
    expect(wrapper.get('a[download="營業稅資料變更通知.xlsx"]').text()).toBe('下載 Excel')
    wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report')
  })

  it('報表產生失敗時顯示錯誤且不提供部分下載', async () => {
    startProcessing.mockReturnValue({
      cancel: vi.fn(),
      promise: Promise.reject(new Error('無法產生報表')),
    })
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    await wrapper.get('button[data-action="start"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('.notice').text()).toContain('無法完成報表：無法產生報表')
    expect(wrapper.find('a[download]').exists()).toBe(false)
  })

  it('取消會終止目前工作並清除本次結果', async () => {
    const cancel = vi.fn()
    startProcessing.mockReturnValue({ cancel, promise: new Promise(() => undefined) })
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    await wrapper.get('button[data-action="start"]').trigger('click')
    await wrapper.get('button[data-action="cancel"]').trigger('click')

    expect(cancel).toHaveBeenCalledOnce()
    expect(wrapper.find('a[download]').exists()).toBe(false)
    expect(wrapper.text()).toContain('已取消')
  })

  it('0 筆異動仍可下載並列出略過紀錄', async () => {
    startProcessing.mockReturnValue({
      cancel: vi.fn(),
      promise: Promise.resolve({
        rows: [],
        records: [
          {
            item: '申報資料/12345678/不支援檔案',
            status: 'skipped',
            changeCount: 0,
            message: '找不到支援的工作表',
          },
        ],
        report: new ArrayBuffer(1),
        summary: summary({ processedExcelFiles: 0, skippedExcelFiles: 1 }),
      }),
    })
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    await wrapper.get('button[data-action="start"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('沒有找到門檻後的異動資料')
    expect(wrapper.find('table[data-table="results"]').exists()).toBe(false)
    expect(wrapper.get('.status').text()).toBe('略過')
    expect(wrapper.find('a[download]').exists()).toBe(true)
  })

  it('空資料夾維持不可執行並顯示清楚訊息', async () => {
    const wrapper = mount(App)
    await selectFiles(wrapper, [])

    expect(wrapper.text()).toContain('沒有選取資料夾')
    expect(wrapper.get('button[data-action="start"]').attributes('disabled')).toBeDefined()
  })
})
