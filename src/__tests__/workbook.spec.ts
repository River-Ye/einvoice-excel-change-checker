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

const DEFAULT_PATH = '匯入資料/11112222/誤導統編_33334444.data'
const analyze = (buffer: ArrayBuffer, relativePath = DEFAULT_PATH) =>
  analyzeWorkbook(buffer, { relativePath, checkDate: '2024-07-08' })

describe('analyzeWorkbook', () => {
  it('uses supported sheet priority and includes only rows strictly after the threshold', () => {
    const buffer = workbookBuffer({
      allowance: [
        ['折讓單號碼', '最後異動時間', '買方統一編號'],
        ['ALLOWANCE', '2024-07-09 00:00:00', '55556666'],
      ],
      btb411w_xls1: [
        ['發票號碼', '最後異動時間', '買方統一編號'],
        ['NEW', '2024/07/09 00:00:00', '66667777'],
      ],
      Invoice: [
        ['發票號碼', '最後異動時間', '買方統一編號'],
        ['BEFORE', '2024-07-07 23:59:59', 'not-used'],
        ['EQUAL', '2024-07-08 00:00:00', null],
        [],
        ['AFTER', '2024-07-08 00:00:01', '87654321'],
      ],
    })

    expect(analyze(buffer)).toEqual([
      { taxId: '87654321', fileName: DEFAULT_PATH, documentNumber: 'AFTER' },
    ])
  })

  it.each(['Invoice', 'btb411w_xls1', 'allowance'])('supports the %s sheet', (sheetName) => {
    const firstHeader = sheetName === 'allowance' ? '折讓單號碼' : '發票號碼'
    const buffer = workbookBuffer({
      [sheetName]: [
        [firstHeader, '最後異動時間', '買方統一編號'],
        ['00001234', '2024-07-09 12:34:56', '12345678'],
      ],
    })

    expect(analyze(buffer)[0]?.documentNumber).toBe('00001234')
  })

  it('accepts an Excel date cell', () => {
    const buffer = workbookBuffer({
      Invoice: [
        ['發票號碼', '最後異動時間', '買方統一編號'],
        ['SERIAL', new Date('2024-07-09T04:00:00Z'), '12345678'],
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
          ['發票號碼', '最後異動時間', '買方統一編號'],
          ['DATE1904', july9In1904System, '12345678'],
        ],
      },
      true,
    )

    expect(analyze(buffer)[0]?.documentNumber).toBe('DATE1904')
  })

  it('reads a valid OOXML workbook regardless of its filename extension', () => {
    const buffer = workbookBuffer({
      Invoice: [
        ['發票號碼', '最後異動時間', '買方統一編號'],
        ['RENAMED', '2024-07-09 00:00:00', '87654321'],
      ],
    })

    expect(analyze(buffer, '匯入資料/11112222/33334444_報表.pdf')).toEqual([
      { taxId: '87654321', fileName: '匯入資料/11112222/33334444_報表.pdf', documentNumber: 'RENAMED' },
    ])
  })

  it('reads a legacy binary XLS workbook', () => {
    const buffer = workbookBuffer(
      {
        Invoice: [
          ['發票號碼', '最後異動時間', '買方統一編號'],
          ['LEGACY', '2024-07-09 00:00:00', '87654321'],
        ],
      },
      false,
      'xls',
    )

    expect(analyze(buffer, '匯入資料/11112222/33334444_無副檔名')).toEqual([
      { taxId: '87654321', fileName: '匯入資料/11112222/33334444_無副檔名', documentNumber: 'LEGACY' },
    ])
  })

  it.each([
    [{ Other: [['發票號碼', '最後異動時間', '買方統一編號']] }, '找不到支援的工作表'],
    [{ Invoice: [['', '最後異動時間', '買方統一編號']] }, '第一欄標題'],
    [{ Invoice: [['發票號碼', '異動時間', '買方統一編號']] }, '最後異動時間'],
    [{ Invoice: [['發票號碼', '最後異動時間', '買方統一編號 ']] }, '買方統一編號'],
    [
      {
        Invoice: [
          ['發票號碼', '最後異動時間', '買方統一編號'],
          ['', '2024-07-09 00:00:00', '12345678'],
        ],
      },
      '號碼',
    ],
    [
      {
        Invoice: [
          ['發票號碼', '最後異動時間', '買方統一編號'],
          ['BROKEN', 'not-a-date', '12345678'],
        ],
      },
      '日期',
    ],
    [
      {
        Invoice: [
          ['發票號碼', '最後異動時間', '買方統一編號'],
          ['IMPOSSIBLE', '2024-02-30T00:00:00Z', '12345678'],
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

  it('reads and trims the buyer tax ID independently for every changed row', () => {
    const buffer = workbookBuffer({
      Invoice: [
        ['發票號碼', '最後異動時間', '買方統一編號'],
        ['FIRST', '2024-07-08 00:00:01', ' 12345678 '],
        ['SECOND', '2024-07-09 00:00:00', '87654321'],
        ['ZERO', '2024-07-10 00:00:00', '0000000000'],
      ],
    })

    expect(analyze(buffer).map(({ taxId, documentNumber }) => ({ taxId, documentNumber }))).toEqual([
      { taxId: '12345678', documentNumber: 'FIRST' },
      { taxId: '87654321', documentNumber: 'SECOND' },
      { taxId: '0000000000', documentNumber: 'ZERO' },
    ])
  })

  it('uses the displayed buyer tax ID to preserve a numeric cell leading zero', () => {
    const buffer = workbookBuffer({
      Invoice: [
        ['發票號碼', '最後異動時間', '買方統一編號'],
        ['FORMATTED', '2024-07-09 00:00:00', { t: 'n', v: 1234567, z: '00000000' }],
      ],
    })

    expect(analyze(buffer)[0]?.taxId).toBe('01234567')
  })

  it('does not validate a buyer tax ID on rows at or before the threshold', () => {
    const buffer = workbookBuffer({
      Invoice: [
        ['發票號碼', '最後異動時間', '買方統一編號'],
        ['BEFORE', '2024-07-07 23:59:59', 'invalid-before'],
        ['EQUAL', '2024-07-08 00:00:00', null],
        ['AFTER', '2024-07-08 00:00:01', '12345678'],
      ],
    })

    expect(analyze(buffer)).toEqual([
      { taxId: '12345678', fileName: DEFAULT_PATH, documentNumber: 'AFTER' },
    ])
  })

  it.each([null, '', '1234567', '1234567890', 'ABCDEFGH'])(
    'rejects an invalid buyer tax ID on a changed row without returning partial rows: %s',
    (taxId) => {
      const buffer = workbookBuffer({
        Invoice: [
          ['發票號碼', '最後異動時間', '買方統一編號'],
          ['VALID-FIRST', '2024-07-09 00:00:00', '12345678'],
          ['INVALID-SECOND', '2024-07-10 00:00:00', taxId],
        ],
      })

      expect(() => analyze(buffer)).toThrow('第 3 列的買方統一編號無效')
    },
  )

  it('reports workbook errors before considering any path or filename digits', () => {
    expect(() => analyze(new ArrayBuffer(0), '匯入資料/12345678/87654321_壞檔')).toThrow(
      '無法讀取 Excel',
    )
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
        ['發票號碼', '最後異動時間', '買方統一編號'],
        ['AB001', '2024-07-09 00:00:00', '87654321'],
      ],
    })

    expect(
      handleWorkerRequest({
        id: 1,
        type: 'analyze',
        file: input,
        relativePath: '匯入資料/11112222/33334444_發票.bin',
        checkDate: '2024-07-08',
      }),
    ).toEqual({
      id: 1,
      ok: true,
      type: 'analyze',
      outcome: 'processed',
      rows: [
        {
          taxId: '87654321',
          fileName: '匯入資料/11112222/33334444_發票.bin',
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
        relativePath: '匯入資料/11112222/33334444_壞檔',
        checkDate: '2024-07-08',
      }),
    ).toMatchObject({ id: 3, ok: false, error: expect.stringContaining('無法讀取 Excel') })
  })

  it('skips a whole workbook and returns no partial rows when a changed buyer tax ID is invalid', () => {
    const input = workbookBuffer({
      Invoice: [
        ['發票號碼', '最後異動時間', '買方統一編號'],
        ['VALID-FIRST', '2024-07-09 00:00:00', '12345678'],
        ['INVALID-SECOND', '2024-07-10 00:00:00', 'not-a-tax-id'],
      ],
    })

    expect(
      handleWorkerRequest({
        id: 4,
        type: 'analyze',
        file: input,
        relativePath: '匯入資料/11112222/33334444_發票.bin',
        checkDate: '2024-07-08',
      }),
    ).toEqual({
      id: 4,
      ok: true,
      type: 'analyze',
      outcome: 'workbook-skipped',
      message: '第 3 列的買方統一編號無效',
      rows: [],
    })
  })
})
