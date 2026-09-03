import { describe, expect, it } from 'vitest'

import * as domain from '../domain'
import {
  detectFileKind,
  getDefaultCheckDate,
  getTaipeiThreshold,
  sortFiles,
} from '../domain'

const fakeFile = (name: string, path = name) => ({ name, webkitRelativePath: path }) as File
const header = (...bytes: number[]) => new Uint8Array(bytes).buffer

describe('sortFiles', () => {
  it('keeps every selected file, including nested paths, arbitrary extensions, and duplicate names', () => {
    const files = [
      fakeFile('same', '選取目錄/z/same'),
      fakeFile('發票.pdf', '選取目錄/a/發票.pdf'),
      fakeFile('same', '選取目錄/a/deep/same'),
      ...Array.from({ length: 143 }, (_, index) =>
        fakeFile(`資料-${index}`, `選取目錄/m/${String(index).padStart(3, '0')}/資料-${index}`),
      ),
    ]

    const result = sortFiles(files)

    expect(result).toHaveLength(146)
    expect(result.map((file) => file.webkitRelativePath)).toEqual(
      [...files]
        .map((file) => file.webkitRelativePath)
        .sort((left, right) => left.localeCompare(right)),
    )
    expect(result.filter((file) => file.name === 'same')).toHaveLength(2)
  })
})

describe('detectFileKind', () => {
  it.each([
    [[0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0], 'ooxml'],
    [[0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0], 'ooxml'],
    [[0x50, 0x4b, 0x07, 0x08, 0, 0, 0, 0], 'ooxml'],
    [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 'xls'],
    [[0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37], 'pdf'],
    [[0x50, 0x4b, 0x03], 'other'],
  ] as const)('classifies an eight-byte content signature without using a filename', (bytes, kind) => {
    expect(detectFileKind(header(...bytes))).toBe(kind)
  })
})

describe('tax ID source', () => {
  it('does not expose path or filename tax ID inference', () => {
    expect(domain).not.toHaveProperty('extractTaxId')
  })
})

describe('Taipei check date', () => {
  it('defaults to the eighth day of the current Taipei month', () => {
    expect(getDefaultCheckDate(new Date('2024-02-29T16:30:00Z'))).toBe('2024-03-08')
  })

  it('accepts past, future, and leap-day calendar dates at Taipei midnight', () => {
    expect(getTaipeiThreshold('2020-02-29')).toBe(Date.parse('2020-02-29T00:00:00+08:00'))
    expect(getTaipeiThreshold('2026-07-08')).toBe(Date.parse('2026-07-08T00:00:00+08:00'))
    expect(getTaipeiThreshold('2032-12-31')).toBe(Date.parse('2032-12-31T00:00:00+08:00'))
  })

  it.each(['2024-02-30', '2023-02-29', '2024-2-08', '2024-00-08', 'not-a-date'])(
    'rejects invalid YYYY-MM-DD input: %s',
    (value) => expect(() => getTaipeiThreshold(value)).toThrow('有效日期'),
  )
})
