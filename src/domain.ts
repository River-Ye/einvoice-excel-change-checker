export const MAX_FILE_BYTES = 100 * 1024 * 1024
const DEFAULT_CHECK_DAY = 8

export type FileKind = 'ooxml' | 'xls' | 'pdf' | 'other'

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

export const relativeFilePath = (file: File): string => file.webkitRelativePath || file.name

export const sortFiles = (files: Iterable<File>): File[] =>
  [...files].sort((a, b) => relativeFilePath(a).localeCompare(relativeFilePath(b)))

export function detectFileKind(header: ArrayBuffer): FileKind {
  const bytes = new Uint8Array(header)
  if (
    bytes.length >= 8 &&
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => bytes[index] === byte)
  ) {
    return 'xls'
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  ) {
    return 'ooxml'
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return 'pdf'
  }
  return 'other'
}

export function extractTaxId(relativePath: string): string | undefined {
  const parts = relativePath.split(/[\\/]/)
  const fileName = parts.pop() ?? ''

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (/^\d{8}$/.test(parts[index] ?? '')) return parts[index]
  }

  const matches = [...fileName.matchAll(/(?:^|\D)(\d{8})(?!\d)/g)].map((match) => match[1])
  return matches.length === 1 ? matches[0] : undefined
}

export function getDefaultCheckDate(now = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now).map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${String(DEFAULT_CHECK_DAY).padStart(2, '0')}`
}

export function getTaipeiThreshold(checkDate: string): number {
  const match = checkDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) throw new RangeError('請選擇有效日期')
  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new RangeError('請選擇有效日期')
  }
  return Date.parse(`${checkDate}T00:00:00+08:00`)
}
