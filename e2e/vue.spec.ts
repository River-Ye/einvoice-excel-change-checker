import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import * as XLSX from 'xlsx'

const CHECK_DATE = '2026-07-08'

function taipeiDefaultDate() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  )

  return `${parts.year}-${parts.month}-08`
}

async function writeWorkbook(
  path: string,
  sheetName: string,
  documentNumber: string,
  buyerTaxIds: Array<string | number>,
  bookType: 'xlsx' | 'xls' = 'xlsx',
) {
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.aoa_to_sheet([
    [sheetName === 'allowance' ? '折讓單號碼' : '發票號碼', '最後異動時間', '買方統一編號'],
    ...buyerTaxIds.map((taxId, index) => [
      index === 0 ? documentNumber : `${documentNumber}-${index + 1}`,
      '2026/07/08 00:00:01',
      taxId,
    ]),
    [`${documentNumber}-門檻日`, '2026/07/08 00:00:00', '77778888'],
    [`${documentNumber}-門檻前`, '2026/07/07 23:59:59', '88889999'],
  ])
  buyerTaxIds.forEach((taxId, index) => {
    if (typeof taxId === 'number') worksheet[`C${index + 2}`]!.z = '00000000'
  })

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, XLSX.write(workbook, { type: 'buffer', bookType }))
}

test('遞迴掃描內容可辨識的 Excel，依完整路徑產生報表', async ({ page }) => {
  const source = await mkdtemp(join(tmpdir(), 'einvoice-e2e-'))
  const root = basename(source)
  const relative = (path: string) => `${root}/${path}`
  const consoleErrors: string[] = []
  const requestedOrigins = new Set<string>()

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('request', (request) => requestedOrigins.add(new URL(request.url()).origin))

  try {
    await writeWorkbook(join(source, '12345678/deep/arbitrary.data'), 'Invoice', 'OOXML-AFTER', [
      '11112222',
      '0000000000',
    ])
    await writeWorkbook(join(source, '23456789/legacy.xls'), 'btb411w_xls1', 'XLS-AFTER', [
      1234567,
    ], 'xls')
    await writeWorkbook(join(source, '34567890/allowance.bin'), 'allowance', 'ALLOWANCE-AFTER', [
      '22223333',
    ])
    await writeWorkbook(join(source, 'misc/customer-45678901-export.weird'), 'Invoice', 'FALLBACK-AFTER', [
      '33334444',
    ])
    await writeWorkbook(join(source, '56789012/no-supported-sheet.zip'), 'Other', 'UNSUPPORTED', [
      '66667777',
    ])
    await writeWorkbook(join(source, '87654321/a/same-name.xlsx'), 'Invoice', 'SAME-A', [
      '44445555',
    ])
    await writeWorkbook(join(source, '87654321/b/same-name.xlsx'), 'Invoice', 'SAME-B', [
      '55556666',
    ])
    await mkdir(join(source, '99999999'), { recursive: true })
    await writeFile(join(source, '99999999/fake.xlsx'), '%PDF-1.7\nnot a workbook')
    await mkdir(join(source, 'notes'), { recursive: true })
    await writeFile(join(source, 'notes/readme.txt'), 'not a workbook')

    await page.goto('./')
    await expect(page).toHaveTitle('電子發票 Excel 異動檢查器')

    const dateInput = page.getByLabel('異動檢查門檻')
    await expect(dateInput).toHaveAttribute('type', 'date')
    await expect(dateInput).toHaveValue(taipeiDefaultDate())
    await dateInput.fill(CHECK_DATE)

    await page.getByLabel('選擇來源資料夾').setInputFiles(source)
    await expect(page.locator('.selection-summary')).toContainText('9 個檔案')
    await expect(page.getByRole('button', { name: '開始檢查' })).toBeEnabled()
    await page.getByRole('button', { name: '開始檢查' }).click()

    const downloadLink = page.getByRole('link', { name: '下載 Excel' })
    await expect(downloadLink).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('body')).toContainText(
      '掃描 9 個檔案 · Excel 7 個 · 成功 6 個 · 略過 Excel 1 個 · 非 Excel 2 個',
    )

    const resultRows = [
      ['11112222', relative('12345678/deep/arbitrary.data'), 'OOXML-AFTER'],
      ['0000000000', relative('12345678/deep/arbitrary.data'), 'OOXML-AFTER-2'],
      ['01234567', relative('23456789/legacy.xls'), 'XLS-AFTER'],
      ['22223333', relative('34567890/allowance.bin'), 'ALLOWANCE-AFTER'],
      ['44445555', relative('87654321/a/same-name.xlsx'), 'SAME-A'],
      ['55556666', relative('87654321/b/same-name.xlsx'), 'SAME-B'],
      ['33334444', relative('misc/customer-45678901-export.weird'), 'FALLBACK-AFTER'],
    ]
    const resultsTable = page.locator('[data-table="results"]')
    for (const heading of ['統一編號', '檔案名稱', '發票號碼/折讓單號碼']) {
      await expect(resultsTable.getByRole('columnheader', { name: heading, exact: true })).toBeVisible()
    }
    for (const [index, row] of resultRows.entries()) {
      await expect(resultsTable.locator('tbody tr').nth(index).locator('td')).toHaveText(row)
    }
    await expect(resultsTable).not.toContainText('門檻日')
    await expect(resultsTable).not.toContainText('門檻前')

    const downloadPromise = page.waitForEvent('download')
    await downloadLink.click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('營業稅資料變更通知.xlsx')

    const reportPath = join(source, download.suggestedFilename())
    await download.saveAs(reportPath)
    const report = XLSX.read(await readFile(reportPath), { type: 'buffer' })
    expect(report.SheetNames).toEqual(['營業稅資料變更通知', '處理紀錄'])

    expect(
      XLSX.utils.sheet_to_json<string[]>(report.Sheets['營業稅資料變更通知']!, {
        header: 1,
        raw: false,
      }),
    ).toEqual([['統一編號', '檔案名稱', '發票號碼/折讓單號碼'], ...resultRows])

    const processingRows = XLSX.utils.sheet_to_json<string[]>(report.Sheets['處理紀錄']!, {
      header: 1,
      raw: false,
    })
    expect(processingRows[0]).toEqual(['檔案／項目', '處理結果', '異動筆數', '說明'])
    for (const path of [
      '12345678/deep/arbitrary.data',
      '23456789/legacy.xls',
      '34567890/allowance.bin',
      '56789012/no-supported-sheet.zip',
      '87654321/a/same-name.xlsx',
      '87654321/b/same-name.xlsx',
      'misc/customer-45678901-export.weird',
    ]) {
      expect(processingRows.filter((row) => row[0] === relative(path))).toHaveLength(1)
    }
    expect(
      processingRows.find((row) => row[0] === relative('56789012/no-supported-sheet.zip')),
    ).toEqual(expect.arrayContaining(['已跳過', '0']))

    for (const sheetName of report.SheetNames) {
      for (const cell of Object.values(report.Sheets[sheetName]!)) {
        if (typeof cell !== 'object' || !cell) continue
        expect(cell).not.toHaveProperty('f')
        expect(cell).not.toHaveProperty('l')
      }
    }

    expect(requestedOrigins).toEqual(new Set(['http://127.0.0.1:4174']))
    expect(
      await page.evaluate(async () => {
        const serviceWorker = (
          navigator as unknown as {
            serviceWorker?: { getRegistrations: () => Promise<unknown[]> }
          }
        ).serviceWorker

        return {
          local: localStorage.length,
          session: sessionStorage.length,
          serviceWorkers: serviceWorker ? (await serviceWorker.getRegistrations()).length : 0,
        }
      }),
    ).toEqual({ local: 0, session: 0, serviceWorkers: 0 })
    expect(consoleErrors).toEqual([])
  } finally {
    await rm(source, { recursive: true, force: true })
  }
})
