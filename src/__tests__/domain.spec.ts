import { describe, expect, it } from 'vitest'

import {
  MAX_CANDIDATE_FILES,
  MAX_FILE_BYTES,
  classifyFiles,
  extractTaxId,
  getTaipeiMonthInfo,
  getTaipeiThreshold,
} from '../domain'

const fakeFile = (name: string, size = 1, path = name) =>
  ({ name, size, webkitRelativePath: path }) as File

describe('classifyFiles', () => {
  it('filters candidates and sorts them by relative path', () => {
    const result = classifyFiles([
      fakeFile('12345678_b.XLSX', 1, 'z/12345678_b.XLSX'),
      fakeFile('notes.txt', 1, 'z/notes.txt'),
      fakeFile('12345678_客戶資料.xlsx', 1, 'a/12345678_客戶資料.xlsx'),
      fakeFile('wrong.xlsx', 1, 'a/wrong.xlsx'),
      fakeFile('87654321_a.xlsx', MAX_FILE_BYTES, 'a/87654321_a.xlsx'),
      fakeFile('87654321_huge.xlsx', MAX_FILE_BYTES + 1, 'a/87654321_huge.xlsx'),
    ])

    expect(result.candidates.map((file) => file.webkitRelativePath)).toEqual([
      'a/87654321_a.xlsx',
      'z/12345678_b.XLSX',
    ])
    expect(result.records).toEqual([
      expect.objectContaining({ item: 'a/12345678_客戶資料.xlsx', status: 'skipped' }),
      expect.objectContaining({ item: 'a/87654321_huge.xlsx', status: 'skipped' }),
      expect.objectContaining({ item: 'a/wrong.xlsx', status: 'skipped' }),
      expect.objectContaining({ item: '其他副檔名', status: 'skipped', changeCount: 0 }),
    ])
    expect(result.tooMany).toBe(false)
  })

  it('allows 100 candidates and blocks instead of truncating the 101st', () => {
    const files = Array.from({ length: MAX_CANDIDATE_FILES }, (_, index) =>
      fakeFile(`12345678_${String(index).padStart(3, '0')}.xlsx`),
    )

    const allowed = classifyFiles(files)
    expect(allowed.candidates).toHaveLength(MAX_CANDIDATE_FILES)
    expect(allowed.tooMany).toBe(false)

    const blocked = classifyFiles([...files, fakeFile('12345678_100.xlsx')])
    expect(blocked.candidates).toHaveLength(MAX_CANDIDATE_FILES + 1)
    expect(blocked.tooMany).toBe(true)
  })
})

describe('tax ID and Taipei threshold', () => {
  it('extracts only an eight-digit filename prefix', () => {
    expect(extractTaxId('00123456_invoice.xlsx')).toBe('00123456')
    expect(extractTaxId('1234567_invoice.xlsx')).toBeUndefined()
  })

  it('uses the Taipei current month and lists only valid days', () => {
    const info = getTaipeiMonthInfo(new Date('2024-02-29T16:30:00Z'))

    expect(info).toEqual({
      year: 2024,
      month: 3,
      days: Array.from({ length: 31 }, (_, index) => index + 1),
      defaultDay: 8,
    })
  })

  it('creates midnight in Taipei and rejects invalid days', () => {
    const now = new Date('2024-02-01T00:00:00Z')

    expect(getTaipeiThreshold(8, now)).toBe(Date.parse('2024-02-08T00:00:00+08:00'))
    expect(() => getTaipeiThreshold(30, now)).toThrow('有效日期')
  })
})
