# 電子發票 Excel 異動檢查器

純前端的 Excel 檢查工具。選取本機資料夾後，瀏覽器會遞迴掃描其回傳的檔案，找出指定日期後有異動的發票或折讓單，提供網頁預覽與 Excel 報表下載。

[線上使用](https://river-ye.github.io/einvoice-excel-change-checker/)

## 使用方式

1. 使用 Chrome 開啟網頁並選擇來源資料夾；子資料夾內的檔案也會掃描。
2. 在日曆選擇判斷基準日；預設為台北時間當月 8 日，也可選擇其他有效的過去或未來日期。
3. 按下「開始檢查」，完成後檢視結果或下載 `營業稅資料變更通知.xlsx`。

檔案會先依內容辨識，不依副檔名或命名習慣決定是否為 Excel：

- ZIP／OOXML 或 OLE Compound File 容器會交由 SheetJS 驗證工作簿；改過副檔名的有效 OOXML 與舊式 XLS 仍可處理。
- PDF、一般檔案、損壞容器與無法確認的容器會依原因合計為略過。
- 單檔不超過 100 MiB（104,857,600 bytes）。

支援的工作表依序為 `Invoice`、`btb411w_xls1`、`allowance`。第一列的第一欄不可為空，且必須包含精確欄名 `最後異動時間`。資料列中的單號或日期無法解析時，會跳過整個檔案並顯示原因。

統一編號會先從檔案所在位置向上尋找最近、名稱恰為 8 碼的資料夾；找不到時，才使用檔名中唯一且獨立的 8 碼數字。無法唯一判定時不會猜測，該工作簿會列為略過。

判斷門檻是所選日期的台北時間 00:00，只列出 `最後異動時間` 嚴格晚於門檻的資料。工具沒有總檔數上限；所有檔案依完整相對路徑排序並循序掃描，但超過 100 MiB 的 Excel 候選只會記錄為略過，不讀取完整內容。

## 報表內容

- `營業稅資料變更通知`：統一編號、完整相對路徑、發票號碼／折讓單號碼。
- `處理紀錄`：每個 Excel 的處理結果，以及非 Excel 依內容或原因整理的跳過合計。

即使沒有異動，也能下載只有標題列的結果工作表與完整處理紀錄。公式開頭的來源文字會被中和，報表不會複製來源公式、超連結、巨集或檔案 metadata。

## 隱私與限制

檔案只在目前瀏覽器分頁處理，且同時最多只有一個 Web Worker；本工具沒有後端、登入、分析追蹤、瀏覽器儲存、Service Worker 或郵件功能，也不會將選取的檔案上傳。GitHub Pages 仍會像一般網站一樣提供靜態 HTML、JavaScript 與 CSS 檔案。

資料夾選取受 Chrome 的 `webkitdirectory` 能力限制：工具會掃描瀏覽器實際回傳的所有一般檔案，但無法保證取得瀏覽器未提供的隱藏檔、符號連結或絕對路徑。

工具不限制解壓後大小、壓縮比、列數或處理時間。惡意或極端的 ZIP／XML bomb 即使原始檔不超過 100 MiB，仍可能耗盡分頁或 Web Worker 的記憶體；請只處理可信來源，必要時關閉分頁中止作業。

## 本機開發

需要 Node.js 22.12 以上。

```sh
npm ci
npm run dev
```

驗證：

```sh
npm run guard:data
npm audit --audit-level=high
npm run test:coverage
npm run type-check
npm run build
npx playwright install chrome
npm run test:e2e
```

本地 checkout 可啟用提供的 push 前防護：`git config core.hooksPath .githooks`。防護會檢查目前檔案、index、Git 可達歷史與建置產物，發現 Office、PDF、表格或壓縮檔的檔名／簽章就拒絕 push。

## 技術

Vue 3、TypeScript、Vite、SheetJS CE、Vitest 與 Playwright。網站由 GitHub Actions 部署至 GitHub Pages。
