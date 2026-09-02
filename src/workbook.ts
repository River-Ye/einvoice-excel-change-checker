import * as XLSX from 'xlsx'

import {
  detectFileKind,
  extractTaxId,
  getTaipeiThreshold,
  type ChangeRow,
  type ProcessingRecord,
} from './domain'

const SUPPORTED_SHEETS = ['Invoice', 'btb411w_xls1', 'allowance'] as const
const CHANGE_HEADER = '最後異動時間'
const RESULT_HEADERS = ['統一編號', '檔案名稱', '發票號碼/折讓單號碼']
const RECORD_HEADERS = ['檔案／項目', '處理結果', '異動筆數', '說明']

export interface AnalyzeOptions {
  relativePath: string
  taxId?: string
  checkDate: string
}

export function analyzeWorkbook(buffer: ArrayBuffer, options: AnalyzeOptions): ChangeRow[] {
  const workbook = readWorkbook(buffer)
  const sheetName = SUPPORTED_SHEETS.find((name) => workbook.SheetNames.includes(name))
  if (!sheetName) throw new Error('找不到支援的工作表（Invoice、btb411w_xls1、allowance）')

  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new Error(`無法讀取工作表 ${sheetName}`)

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  })
  const header = rows[0]
  if (!header || isBlank(header[0])) throw new Error('第一欄標題不得空白')

  const changedAtIndex = header.findIndex((cell) => cell === CHANGE_HEADER)
  if (changedAtIndex < 0) throw new Error(`找不到「${CHANGE_HEADER}」欄位`)

  const threshold = getTaipeiThreshold(options.checkDate)
  const date1904 = workbook.Workbook?.WBProps?.date1904 === true
  const changedDocumentNumbers: string[] = []

  rows.slice(1).forEach((row, index) => {
    if (row.every(isBlank)) return

    const documentNumber = toRequiredString(row[0])
    if (!documentNumber) throw new Error(`第 ${index + 2} 列的號碼無效`)

    const changedAt = parseDateCell(row[changedAtIndex], date1904)
    if (changedAt === undefined) throw new Error(`第 ${index + 2} 列的最後異動日期無效`)

    if (changedAt > threshold) {
      changedDocumentNumbers.push(documentNumber)
    }
  })

  const taxId = options.taxId ?? extractTaxId(options.relativePath)
  if (!taxId) throw new Error('無法判定統一編號')

  return changedDocumentNumbers.map((documentNumber) => ({
    taxId,
    fileName: options.relativePath,
    documentNumber,
  }))
}

export function buildReport(rows: ChangeRow[], records: ProcessingRecord[]): ArrayBuffer {
  const workbook = XLSX.utils.book_new()
  const resultRows = [
    RESULT_HEADERS,
    ...rows.map(({ taxId, fileName, documentNumber }) =>
      [taxId, fileName, documentNumber].map(neutralizeFormula),
    ),
  ]
  const recordRows = [
    RECORD_HEADERS,
    ...records.map(({ item, status, changeCount, message }) =>
      [item, status === 'processed' ? '已處理' : '已跳過', String(changeCount), message].map(
        neutralizeFormula,
      ),
    ),
  ]

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(resultRows), '營業稅資料變更通知')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(recordRows), '處理紀錄')

  return XLSX.write(workbook, {
    type: 'array',
    bookType: 'xlsx',
    compression: true,
    cellDates: false,
  }) as ArrayBuffer
}

function readWorkbook(buffer: ArrayBuffer): XLSX.WorkBook {
  const kind = detectFileKind(buffer)
  if (kind !== 'ooxml' && kind !== 'xls') {
    throw new Error('無法讀取 Excel：檔案不是有效的 Excel 工作簿')
  }

  try {
    return XLSX.read(buffer, {
      type: 'array',
      sheets: [...SUPPORTED_SHEETS],
      dense: true,
      cellDates: false,
      cellFormula: false,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      cellText: false,
      bookDeps: false,
      bookFiles: false,
      bookProps: false,
      bookVBA: false,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知錯誤'
    throw new Error(`無法讀取 Excel：${detail}`)
  }
}

function parseDateCell(value: unknown, date1904: boolean): number | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime()

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value, { date1904 })
    if (!parsed) return undefined
    return taipeiTime(parsed.y, parsed.m, parsed.d, parsed.H, parsed.M, parsed.S)
  }

  if (typeof value !== 'string') return undefined
  const text = value.trim()
  const local = text.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  )
  if (local) {
    return taipeiTime(
      Number(local[1]),
      Number(local[2]),
      Number(local[3]),
      Number(local[4] ?? 0),
      Number(local[5] ?? 0),
      Number(local[6] ?? 0) + Number(`0.${local[7] ?? 0}`),
    )
  }

  return undefined
}

function taipeiTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  seconds: number,
): number | undefined {
  const wholeSeconds = Math.floor(seconds)
  const milliseconds = Math.floor((seconds - wholeSeconds) * 1000)
  const valid =
    Number.isInteger(year) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    wholeSeconds >= 0 &&
    wholeSeconds <= 59
  if (!valid) return undefined

  return Date.UTC(year, month - 1, day, hour - 8, minute, wholeSeconds, milliseconds)
}

const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '')

const toRequiredString = (value: unknown): string | undefined => {
  if (isBlank(value) || (typeof value !== 'string' && typeof value !== 'number')) return undefined
  return String(value).trim()
}

const neutralizeFormula = (value: string): string => (/^\s*[=+\-@]/.test(value) ? `'${value}` : value)
