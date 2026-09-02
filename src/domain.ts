export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_CANDIDATE_FILES = 100
export const DEFAULT_CHECK_DAY = 8

export interface ChangeRow {
  taxId: string
  fileName: string
  documentNumber: string
}

export interface ProcessingRecord {
  item: string
  status: 'processed' | 'skipped'
  changeCount: number
  message: string
}

export interface ClassifiedFiles {
  candidates: File[]
  records: ProcessingRecord[]
  tooMany: boolean
}

export interface TaipeiMonthInfo {
  year: number
  month: number
  days: number[]
  defaultDay: number
}

export const relativeFilePath = (file: File): string => file.webkitRelativePath || file.name

export const extractTaxId = (fileName: string): string | undefined => fileName.match(/^(\d{8})_/)?.[1]

export function classifyFiles(files: Iterable<File>): ClassifiedFiles {
  const candidates: File[] = []
  const records: ProcessingRecord[] = []
  let otherFileCount = 0

  for (const file of [...files].sort((a, b) => relativeFilePath(a).localeCompare(relativeFilePath(b)))) {
    const item = relativeFilePath(file)
    const lowerName = file.name.toLocaleLowerCase()

    if (!lowerName.endsWith('.xlsx')) {
      otherFileCount += 1
    } else if (lowerName.includes('客戶資料.xlsx')) {
      records.push(skipped(item, '客戶資料檔案不在處理範圍'))
    } else if (!extractTaxId(file.name)) {
      records.push(skipped(item, '檔名必須以 8 碼統一編號及底線開頭'))
    } else if (file.size > MAX_FILE_BYTES) {
      records.push(skipped(item, '檔案超過 100 MiB'))
    } else {
      candidates.push(file)
    }
  }

  if (otherFileCount > 0) {
    records.push(skipped('其他副檔名', `已略過 ${otherFileCount} 個非 XLSX 檔案`))
  }

  return { candidates, records, tooMany: candidates.length > MAX_CANDIDATE_FILES }
}

export function getTaipeiMonthInfo(now: Date | string = new Date()): TaipeiMonthInfo {
  const date = typeof now === 'string' ? new Date(now) : now
  if (Number.isNaN(date.getTime())) throw new Error('無效的執行時間')

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date)
  const year = Number(parts.find(({ type }) => type === 'year')?.value)
  const month = Number(parts.find(({ type }) => type === 'month')?.value)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()

  return {
    year,
    month,
    days: Array.from({ length: daysInMonth }, (_, index) => index + 1),
    defaultDay: DEFAULT_CHECK_DAY,
  }
}

export function getTaipeiThreshold(day: number, now: Date | string = new Date()): number {
  const { year, month, days } = getTaipeiMonthInfo(now)
  if (!Number.isInteger(day) || !days.includes(day)) throw new RangeError('請選擇當月有效日期')

  return Date.parse(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+08:00`,
  )
}

const skipped = (item: string, message: string): ProcessingRecord => ({
  item,
  status: 'skipped',
  changeCount: 0,
  message,
})
