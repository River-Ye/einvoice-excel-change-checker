# 電子發票 Excel 異動檢查器

純前端的 Excel 檢查工具。選取本機資料夾後，瀏覽器會找出指定月份門檻後有異動的發票或折讓單，提供網頁預覽與 Excel 報表下載。

[線上使用](https://river-ye.github.io/einvoice-excel-change-checker/)

## 使用方式

1. 使用 Chrome 開啟網頁並選擇來源資料夾。
2. 選擇本月的檢查門檻日；預設為 8 號。
3. 按下「開始檢查」，完成後檢視結果或下載 `營業稅資料變更通知.xlsx`。

只有同時符合以下條件的檔案會進入解析：

- 副檔名為 `.xlsx`（不分大小寫）。
- 檔名以 8 碼統一編號及底線開頭，例如 `12345678_發票.xlsx`。
- 檔名不包含 `客戶資料.xlsx`。
- 單檔不超過 100 MiB（104,857,600 bytes）。

支援的工作表依序為 `Invoice`、`btb411w_xls1`、`allowance`。第一列的第一欄不可為空，且必須包含精確欄名 `最後異動時間`。資料列中的單號或日期無法解析時，會跳過整個檔案並顯示原因。

符合上述篩選、會進入解析的候選檔案最多 100 個；若有第 101 個，整次檢查不會開始，也不會默默截斷。其他副檔名、超過大小限制或不符合命名規則的檔案都不會解析。

## 報表內容

- `營業稅資料變更通知`：統一編號、檔案名稱、發票號碼／折讓單號碼。
- `處理紀錄`：每個 Excel 的處理結果，以及其他副檔名的跳過合計。

即使沒有異動，也能下載只有標題列的結果工作表與完整處理紀錄。公式開頭的來源文字會被中和，報表不會複製來源公式、超連結、巨集或檔案 metadata。

## 隱私與限制

Excel 只在目前瀏覽器分頁內處理；本工具沒有後端、登入、分析追蹤、瀏覽器儲存或郵件功能，也不會將選取的 Excel 上傳。GitHub Pages 仍會像一般網站一樣提供靜態 HTML、JavaScript 與 CSS 檔案。

工具不限制解壓後大小、壓縮比、列數或處理時間。惡意或極端的 ZIP／XML bomb 即使原始檔不超過 100 MiB，仍可能耗盡分頁或 Web Worker 的記憶體；請只處理可信來源，必要時關閉分頁中止作業。

## 本機開發

需要 Node.js 22.12 以上。

```sh
npm ci
npm run dev
```

驗證：

```sh
npm audit --audit-level=high
npm run test:coverage
npm run type-check
npm run build
npx playwright install chrome
npm run test:e2e
```

## 技術

Vue 3、TypeScript、Vite、SheetJS CE、Vitest 與 Playwright。網站由 GitHub Actions 部署至 GitHub Pages。
