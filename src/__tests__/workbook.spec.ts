import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'

import type { ProcessingRecord } from '../domain'
import { handleWorkerRequest } from '../excel.worker'
import { analyzeWorkbook, buildReport } from '../workbook'

const workbookBuffer = (
  sheets: Record<string, unknown[][]>,
  date1904 = false,
  bookType: 'xlsx' | 'xls' = 'xlsx',
): ArrayBuffer => {
  const workbook = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name)
  }
  if (date1904) workbook.Workbook = { WBProps: { date1904: true } }
  return XLSX.write(workbook, { bookType, type: 'array' }) as ArrayBuffer
}

const DEFAULT_PATH = '匯入資料/00123456/任意檔名.data'
const analyze = (buffer: ArrayBuffer, relativePath = DEFAULT_PATH, taxId = '00123456') =>
  analyzeWorkbook(buffer, { relativePath, taxId, checkDate: '2024-07-08' })

describe('analyzeWorkbook', () => {
  it('uses supported sheet priority and includes only rows strictly after the threshold', () => {
    const buffer = workbookBuffer({
      allowance: [
        ['折讓單號碼', '最後異動時間'],
        ['ALLOWANCE', '2024-07-09 00:00:00'],
      ],
      btb411w_xls1: [
        ['發票號碼', '最後異動時間'],
        ['NEW', '2024/07/09 00:00:00'],
      ],
      Invoice: [
        ['發票號碼', '最後異動時間'],
        ['BEFORE', '2024-07-07 23:59:59'],
        ['EQUAL', '2024-07-08 00:00:00'],
        [],
        ['AFTER', '2024-07-08 00:00:01'],
      ],
    })

    expect(analyze(buffer)).toEqual([
      { taxId: '00123456', fileName: DEFAULT_PATH, documentNumber: 'AFTER' },
    ])
  })

  it.each(['Invoice', 'btb411w_xls1', 'allowance'])('supports the %s sheet', (sheetName) => {
    const firstHeader = sheetName === 'allowance' ? '折讓單號碼' : '發票號碼'
    const buffer = workbookBuffer({
      [sheetName]: [
        [firstHeader, '最後異動時間'],
        ['00001234', '2024-07-09 12:34:56'],
      ],
    })

    expect(analyze(buffer)[0]?.documentNumber).toBe('00001234')
  })

  it('accepts an Excel date cell', () => {
    const buffer = workbookBuffer({
      Invoice: [
        ['發票號碼', '最後異動時間'],
        ['SERIAL', new Date('2024-07-09T04:00:00Z')],
      ],
    })

    expect(analyze(buffer)[0]?.documentNumber).toBe('SERIAL')
  })

  it('respects the Excel 1904 date system', () => {
    const july9In1904System =
      (Date.UTC(2024, 6, 9) - Date.UTC(1904, 0, 1)) / (24 * 60 * 60 * 1000)
    const buffer = workbookBuffer(
      {
        Invoice: [
          ['發票號碼', '最後異動時間'],
          ['DATE1904', july9In1904System],
        ],
      },
      true,
    )

    expect(analyze(buffer)[0]?.documentNumber).toBe('DATE1904')
  })

  it('reads a valid OOXML workbook regardless of its filename extension', () => {
    const buffer = workbookBuffer({
      Invoice: [
        ['發票號碼', '最後異動時間'],
        ['RENAMED', '2024-07-09 00:00:00'],
      ],
    })

    expect(analyze(buffer, '匯入資料/00123456/報表.pdf')).toEqual([
      { taxId: '00123456', fileName: '匯入資料/00123456/報表.pdf', documentNumber: 'RENAMED' },
    ])
  })

  it('reads a legacy binary XLS workbook', () => {
    const buffer = workbookBuffer(
      {
        Invoice: [
          ['發票號碼', '最後異動時間'],
          ['LEGACY', '2024-07-09 00:00:00'],
        ],
      },
      false,
      'xls',
    )

    expect(analyze(buffer, '匯入資料/00123456/無副檔名')).toEqual([
      { taxId: '00123456', fileName: '匯入資料/00123456/無副檔名', documentNumber: 'LEGACY' },
    ])
  })

  it.each([
    [{ Other: [['發票號碼', '最後異動時間']] }, '找不到支援的工作表'],
    [{ Invoice: [['', '最後異動時間']] }, '第一欄標題'],
    [{ Invoice: [['發票號碼', '異動時間']] }, '最後異動時間'],
    [
      {
        Invoice: [
          ['發票號碼', '最後異動時間'],
          ['', '2024-07-09 00:00:00'],
        ],
      },
      '號碼',
    ],
    [
      {
        Invoice: [
          ['發票號碼', '最後異動時間'],
          ['BROKEN', 'not-a-date'],
        ],
      },
      '日期',
    ],
    [
      {
        Invoice: [
          ['發票號碼', '最後異動時間'],
          ['IMPOSSIBLE', '2024-02-30T00:00:00Z'],
        ],
      },
      '日期',
    ],
  ])('rejects an invalid workbook without partial rows', (sheets, message) => {
    expect(() => analyze(workbookBuffer(sheets as Record<string, unknown[][]>))).toThrow(message as string)
  })

  it('reports a corrupt file with a friendly message', () => {
    expect(() => analyze(new TextEncoder().encode('not an xlsx').buffer)).toThrow('無法讀取 Excel')
  })

  it('requires a resolved tax ID only after confirming the workbook is readable', () => {
    const buffer = workbookBuffer({ Invoice: [['發票號碼', '最後異動時間']] })
    const invalidRows = workbookBuffer({
      Invoice: [
        ['發票號碼', '最後異動時間'],
        ['BROKEN', 'not-a-date'],
      ],
    })

    expect(() => analyzeWorkbook(buffer, {
      relativePath: '匯入資料/無法判定統編/報表',
      checkDate: '2024-07-08',
    })).toThrow('統一編號')
    expect(() => analyzeWorkbook(invalidRows, {
      relativePath: '匯入資料/無法判定統編/報表',
      checkDate: '2024-07-08',
    })).toThrow('最後異動日期無效')
    expect(() => analyzeWorkbook(new ArrayBuffer(0), {
      relativePath: '匯入資料/無法判定統編/壞檔',
      checkDate: '2024-07-08',
    })).toThrow('無法讀取 Excel')
  })
})

describe('buildReport', () => {
  it('builds two exact sheets, preserves strings, and neutralizes formulas', () => {
    const records: ProcessingRecord[] = [
      { item: '=danger.xlsx', status: 'processed', changeCount: 1, message: '+ok' },
      { item: '其他副檔名', status: 'skipped', changeCount: 0, message: '已略過 2 個檔案' },
    ]
    const buffer = buildReport(
      [
        {
          taxId: '00123456',
          fileName: '@source.xlsx',
          documentNumber: '-123',
        },
      ],
      records,
    )

    expect(buffer).toBeInstanceOf(ArrayBuffer)
    const workbook = XLSX.read(buffer, { type: 'array', cellFormula: true })
    expect(workbook.SheetNames).toEqual(['營業稅資料變更通知', '處理紀錄'])
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['營業稅資料變更通知']!, { header: 1, raw: true })).toEqual([
      ['統一編號', '檔案名稱', '發票號碼/折讓單號碼'],
      ['00123456', "'@source.xlsx", "'-123"],
    ])
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['處理紀錄']!, { header: 1, raw: true })).toEqual([
      ['檔案／項目', '處理結果', '異動筆數', '說明'],
      ["'=danger.xlsx", '已處理', '1', "'+ok"],
      ['其他副檔名', '已跳過', '0', '已略過 2 個檔案'],
    ])
    expect(workbook.Sheets['營業稅資料變更通知']?.A2?.f).toBeUndefined()
    expect(workbook.Sheets['營業稅資料變更通知']?.B2?.f).toBeUndefined()
    expect(workbook.Sheets['營業稅資料變更通知']?.C2?.f).toBeUndefined()
    expect(workbook.Sheets['營業稅資料變更通知']?.B2?.l).toBeUndefined()
    expect(workbook.Sheets['營業稅資料變更通知']?.C2?.l).toBeUndefined()
  })

  it('keeps headers when there are no changed rows', () => {
    const records: ProcessingRecord[] = [
      { item: '00123456_發票.xlsx', status: 'processed', changeCount: 0, message: '沒有異動資料' },
    ]
    const workbook = XLSX.read(buildReport([], records), { type: 'array' })
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['營業稅資料變更通知']!, { header: 1 })).toEqual([
      ['統一編號', '檔案名稱', '發票號碼/折讓單號碼'],
    ])
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['處理紀錄']!, { header: 1 })).toEqual([
      ['檔案／項目', '處理結果', '異動筆數', '說明'],
      ['00123456_發票.xlsx', '已處理', '0', '沒有異動資料'],
    ])
  })
})

describe('worker protocol', () => {
  it('handles analyze, report, and friendly error responses', () => {
    const input = workbookBuffer({
      Invoice: [
        ['發票號碼', '最後異動時間'],
        ['AB001', '2024-07-09 00:00:00'],
      ],
    })

    expect(
      handleWorkerRequest({
        id: 1,
        type: 'analyze',
        file: input,
        relativePath: '匯入資料/00123456/發票.bin',
        taxId: '00123456',
        checkDate: '2024-07-08',
      }),
    ).toEqual({
      id: 1,
      ok: true,
      type: 'analyze',
      outcome: 'processed',
      rows: [
        {
          taxId: '00123456',
          fileName: '匯入資料/00123456/發票.bin',
          documentNumber: 'AB001',
        },
      ],
    })

    const report = handleWorkerRequest({ id: 2, type: 'buildReport', rows: [], records: [] })
    expect(report).toMatchObject({ id: 2, ok: true, type: 'buildReport' })
    if (report.ok && report.type === 'buildReport') expect(report.file).toBeInstanceOf(ArrayBuffer)

    expect(
      handleWorkerRequest({
        id: 3,
        type: 'analyze',
        file: new ArrayBuffer(0),
        relativePath: '匯入資料/00123456/壞檔',
        taxId: '00123456',
        checkDate: '2024-07-08',
      }),
    ).toMatchObject({ id: 3, ok: false, error: expect.stringContaining('無法讀取 Excel') })
  })
})
