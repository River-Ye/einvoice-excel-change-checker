import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import * as XLSX from 'xlsx'

function taipeiDate(day: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  )

  return `${parts.year}/${parts.month}/${String(day).padStart(2, '0')} 00:00:00`
}

async function writeWorkbook(path: string, sheetName: string, documentNumber: string) {
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.aoa_to_sheet([
    [sheetName === 'allowance' ? '折讓單號碼' : '發票號碼', '最後異動時間'],
    [documentNumber, taipeiDate(9)],
    [`${documentNumber}-門檻日`, taipeiDate(8)],
  ])

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
  await writeFile(path, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
}

test('選取資料夾、解析支援的工作表並下載報表', async ({ page }) => {
  const source = await mkdtemp(join(tmpdir(), 'einvoice-e2e-'))
  const consoleErrors: string[] = []
  const requestedOrigins = new Set<string>()

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('request', (request) => requestedOrigins.add(new URL(request.url()).origin))

  try {
    await writeWorkbook(join(source, '12345678_發票.xlsx'), 'Invoice', 'AB12345678')
    await writeWorkbook(join(source, '23456789_平台.xlsx'), 'btb411w_xls1', 'CD23456789')
    await writeWorkbook(join(source, '34567890_折讓.xlsx'), 'allowance', 'AL34567890')
    await writeWorkbook(join(source, '45678901_客戶資料.xlsx'), 'Invoice', 'EXCLUDED')
    await writeFile(join(source, '56789012_損壞.xlsx'), 'not an xlsx file')
    await writeFile(join(source, '說明.txt'), 'skip me')

    await page.goto('./')
    await expect(page).toHaveTitle('電子發票 Excel 異動檢查器')
    await expect(page.getByLabel('異動檢查門檻')).toHaveValue('8')

    await page.getByLabel('選擇來源資料夾').setInputFiles(source)
    await expect(page.getByRole('button', { name: '開始檢查' })).toBeEnabled()
    await page.getByRole('button', { name: '開始檢查' }).click()

    const downloadLink = page.getByRole('link', { name: '下載 Excel' })
    await expect(downloadLink).toBeVisible({ timeout: 20_000 })

    for (const heading of ['統一編號', '檔案名稱', '發票號碼/折讓單號碼']) {
      await expect(page.getByRole('columnheader', { name: heading, exact: true })).toBeVisible()
    }
    for (const value of [
      '12345678',
      '12345678_發票.xlsx',
      'AB12345678',
      '23456789',
      '23456789_平台.xlsx',
      'CD23456789',
      '34567890',
      '34567890_折讓.xlsx',
      'AL34567890',
    ]) {
      await expect(page.getByRole('cell', { name: value, exact: true })).toBeVisible()
    }

    const downloadPromise = page.waitForEvent('download')
    await downloadLink.click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('營業稅資料變更通知.xlsx')

    const reportPath = join(source, download.suggestedFilename())
    await download.saveAs(reportPath)
    const report = XLSX.read(await readFile(reportPath), { type: 'buffer' })
    expect(report.SheetNames).toEqual(['營業稅資料變更通知', '處理紀錄'])

    const resultRows = XLSX.utils.sheet_to_json<string[]>(report.Sheets['營業稅資料變更通知']!, {
      header: 1,
      raw: false,
    })
    expect(resultRows).toEqual([
      ['統一編號', '檔案名稱', '發票號碼/折讓單號碼'],
      ['12345678', '12345678_發票.xlsx', 'AB12345678'],
      ['23456789', '23456789_平台.xlsx', 'CD23456789'],
      ['34567890', '34567890_折讓.xlsx', 'AL34567890'],
    ])

    const processingRows = XLSX.utils.sheet_to_json<string[]>(report.Sheets['處理紀錄']!, {
      header: 1,
      raw: false,
    })
    expect(processingRows[0]).toEqual(['檔案／項目', '處理結果', '異動筆數', '說明'])
    expect(processingRows.flat().some((value) => value.includes('56789012_損壞.xlsx'))).toBe(true)

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
