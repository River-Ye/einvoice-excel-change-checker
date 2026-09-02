import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startProcessing } = vi.hoisted(() => ({ startProcessing: vi.fn() }))
vi.mock('../runner', () => ({ startProcessing }))

import App from '../App.vue'

function selectedFile(name = '12345678_發票.xlsx') {
  const file = new File(['test'], name)
  Object.defineProperty(file, 'webkitRelativePath', { value: `申報資料/${name}` })
  return file
}

async function selectFiles(wrapper: ReturnType<typeof mount>, files: File[]) {
  const input = wrapper.get('input[type="file"]')
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

  it('提供三步驟、原生資料夾選擇與預設 8 號門檻', () => {
    const wrapper = mount(App)

    expect(wrapper.findAll('.step')).toHaveLength(3)
    expect(wrapper.get('label[for="source-folder"]').text()).toContain('選擇來源資料夾')
    expect(wrapper.get('input[type="file"]').attributes()).toHaveProperty('webkitdirectory')
    expect(wrapper.get('label[for="check-day"]').text()).toContain('異動檢查門檻')
    expect((wrapper.get('#check-day').element as HTMLSelectElement).value).toBe('8')
    expect(wrapper.get('button[data-action="start"]').text()).toBe('開始檢查')
    expect(wrapper.get('button[data-action="start"]').attributes('disabled')).toBeDefined()
  })

  it('完成後顯示結果、處理紀錄並提供下載', async () => {
    startProcessing.mockImplementation(
      (_files, _day, _records, onProgress: (value: object) => void) => {
        onProgress({ stage: 'analyzing', completed: 0, total: 1, currentFile: '申報資料/12345678_發票.xlsx' })
        return {
          cancel: vi.fn(),
          promise: Promise.resolve({
            rows: [
              { taxId: '12345678', fileName: '12345678_發票.xlsx', documentNumber: 'AB0001' },
            ],
            records: [
              {
                item: '申報資料/12345678_發票.xlsx',
                status: 'processed',
                changeCount: 1,
                message: '處理完成',
              },
            ],
            report: new ArrayBuffer(8),
          }),
        }
      },
    )
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    expect(wrapper.get('button[data-action="start"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('button[data-action="start"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('table[data-table="results"]').text()).toContain('統一編號')
    expect(wrapper.get('table[data-table="results"]').text()).toContain('檔案名稱')
    expect(wrapper.get('table[data-table="results"]').text()).toContain('發票號碼/折讓單號碼')
    expect(wrapper.text()).toContain('AB0001')
    expect(wrapper.get('details').text()).toContain('處理紀錄')
    expect(wrapper.get('a[download="營業稅資料變更通知.xlsx"]').text()).toBe('下載 Excel')
    wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report')
  })

  it('取消會終止目前工作並清除本次結果', async () => {
    const cancel = vi.fn()
    startProcessing.mockReturnValue({ cancel, promise: new Promise(() => undefined) })
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    await wrapper.get('button[data-action="start"]').trigger('click')

    expect(wrapper.get('progress').attributes('max')).toBe('1')
    await wrapper.get('button[data-action="cancel"]').trigger('click')

    expect(cancel).toHaveBeenCalledOnce()
    expect(wrapper.find('a[download]').exists()).toBe(false)
    expect(wrapper.text()).toContain('已取消')
  })

  it('第 101 個候選檔會阻止執行', async () => {
    const wrapper = mount(App)
    await selectFiles(
      wrapper,
      Array.from({ length: 101 }, (_, index) => selectedFile(`${String(index).padStart(8, '0')}_發票.xlsx`)),
    )

    expect(wrapper.text()).toContain('最多處理 100 個')
    expect(wrapper.get('button[data-action="start"]').attributes('disabled')).toBeDefined()
  })

  it('清楚說明空資料夾與無符合條件檔案', async () => {
    const wrapper = mount(App)
    await selectFiles(wrapper, [new File(['readme'], '說明.txt')])
    expect(wrapper.text()).toContain('沒有符合命名與大小條件的 Excel')

    await selectFiles(wrapper, [])
    expect(wrapper.text()).toContain('沒有選取資料夾')
  })

  it('產生報表時顯示不定進度，0 筆仍可下載並列出略過紀錄', async () => {
    let finish: ((result: object) => void) | undefined
    startProcessing.mockImplementation(
      (_files, _day, _records, onProgress: (value: object) => void) => {
        onProgress({ stage: 'building', completed: 1, total: 1, currentFile: '' })
        return {
          cancel: vi.fn(),
          promise: new Promise((resolve) => {
            finish = resolve
          }),
        }
      },
    )
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    await wrapper.get('button[data-action="start"]').trigger('click')

    expect(wrapper.get('progress').attributes('value')).toBeUndefined()
    expect(wrapper.text()).toContain('產生報表中')

    finish?.({
      rows: [],
      records: [
        { item: '損壞.xlsx', status: 'skipped', changeCount: 0, message: '檔案損壞' },
      ],
      report: new ArrayBuffer(1),
    })
    await flushPromises()

    expect(wrapper.text()).toContain('沒有找到門檻後的異動資料')
    expect(wrapper.find('table[data-table="results"]').exists()).toBe(false)
    expect(wrapper.get('.status').text()).toBe('略過')
    expect(wrapper.find('a[download]').exists()).toBe(true)
  })

  it('每頁只呈現 100 筆結果並可切到下一頁', async () => {
    startProcessing.mockReturnValue({
      cancel: vi.fn(),
      promise: Promise.resolve({
        rows: Array.from({ length: 101 }, (_, index) => ({
          taxId: '12345678',
          fileName: '12345678_發票.xlsx',
          documentNumber: `AB${String(index).padStart(4, '0')}`,
        })),
        records: [],
        report: new ArrayBuffer(1),
      }),
    })
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    await wrapper.get('button[data-action="start"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('table[data-table="results"] tbody tr')).toHaveLength(100)
    await wrapper.get('nav[aria-label="結果分頁"] button:last-child').trigger('click')
    expect(wrapper.findAll('table[data-table="results"] tbody tr')).toHaveLength(1)
    expect(wrapper.text()).toContain('第 2 / 2 頁')
  })

  it('報表建立失敗時顯示可讀錯誤且不提供下載', async () => {
    startProcessing.mockReturnValue({
      cancel: vi.fn(),
      promise: Promise.reject(new Error('無法建立活頁簿')),
    })
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    await wrapper.get('button[data-action="start"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('無法完成報表：無法建立活頁簿')
    expect(wrapper.find('a[download]').exists()).toBe(false)
  })

  it('跨月後若所選日期失效，更新月份並要求重新確認', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T15:59:00.000Z'))
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    await wrapper.get('#check-day').setValue('31')

    vi.setSystemTime(new Date('2026-08-31T16:01:00.000Z'))
    await wrapper.get('button[data-action="start"]').trigger('click')

    expect(wrapper.text()).toContain('2026 年 9 月')
    expect((wrapper.get('#check-day').element as HTMLSelectElement).value).toBe('8')
    expect(wrapper.text()).toContain('月份已更新，請重新確認')
    expect(startProcessing).not.toHaveBeenCalled()
  })

  it('跨月後日期仍有效時，以同一時間快照更新畫面並執行', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T15:59:00.000Z'))
    const wrapper = mount(App)
    await selectFiles(wrapper, [selectedFile()])
    startProcessing.mockReturnValue({ cancel: vi.fn(), promise: new Promise(() => undefined) })

    vi.setSystemTime(new Date('2026-08-31T16:01:00.000Z'))
    await wrapper.get('button[data-action="start"]').trigger('click')

    expect(wrapper.text()).toContain('2026 年 9 月')
    expect(startProcessing).toHaveBeenCalledWith(
      expect.any(Array),
      8,
      expect.any(Array),
      expect.any(Function),
      undefined,
      '2026-08-31T16:01:00.000Z',
    )
  })
})
