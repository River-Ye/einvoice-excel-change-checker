<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import {
  getDefaultCheckDate,
  getTaipeiThreshold,
  type ChangeRow,
  type ProcessingRecord,
} from './domain'
import {
  startProcessing,
  type ProcessingTask,
  type RunProgress,
  type RunSummary,
} from './runner'

const PAGE_SIZE = 100
const emptySummary = (totalFiles = 0): RunSummary => ({
  totalFiles,
  scannedFiles: 0,
  excelFiles: 0,
  processedExcelFiles: 0,
  skippedExcelFiles: 0,
  nonExcelFiles: 0,
})

const checkDate = ref(getDefaultCheckDate())
const selectedFiles = ref<File[]>([])
const folderName = ref('')
const state = ref<'idle' | 'running' | 'completed' | 'error' | 'canceled'>('idle')
const notice = ref('請先選擇包含申報資料的來源資料夾。')
const progress = ref<RunProgress>({
  stage: 'analyzing',
  completed: 0,
  total: 0,
  currentFile: '',
  summary: emptySummary(),
})
const summary = ref<RunSummary>(emptySummary())
const rows = ref<ChangeRow[]>([])
const records = ref<ProcessingRecord[]>([])
const downloadUrl = ref('')
const page = ref(1)
let currentTask: ProcessingTask | null = null

const canStart = computed(
  () => state.value !== 'running' && selectedFiles.value.length > 0 && Boolean(checkDate.value),
)
const totalPages = computed(() => Math.max(1, Math.ceil(rows.value.length / PAGE_SIZE)))
const visibleRows = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return rows.value.slice(start, start + PAGE_SIZE)
})

function revokeDownload() {
  if (!downloadUrl.value) return
  URL.revokeObjectURL(downloadUrl.value)
  downloadUrl.value = ''
}

function clearResult() {
  revokeDownload()
  rows.value = []
  records.value = []
  summary.value = emptySummary(selectedFiles.value.length)
  page.value = 1
}

function selectFolder(event: Event) {
  currentTask?.cancel()
  currentTask = null
  clearResult()

  const files = Array.from((event.target as HTMLInputElement).files ?? [])
  selectedFiles.value = files
  summary.value = emptySummary(files.length)
  const firstFile = files[0]
  folderName.value = firstFile ? (firstFile.webkitRelativePath || firstFile.name).split('/')[0] || '' : ''
  state.value = 'idle'
  notice.value = files.length
    ? `已選取 ${files.length} 個檔案，執行後將逐一依內容檢查。`
    : '沒有選取資料夾。'
}

async function start() {
  if (!canStart.value) return

  try {
    getTaipeiThreshold(checkDate.value)
  } catch {
    state.value = 'error'
    notice.value = '請選擇有效的判斷基準日。'
    return
  }

  clearResult()
  state.value = 'running'
  notice.value = '正在準備檔案…'
  progress.value = {
    stage: 'analyzing',
    completed: 0,
    total: selectedFiles.value.length,
    currentFile: '',
    summary: emptySummary(selectedFiles.value.length),
  }

  const task = startProcessing(
    selectedFiles.value,
    checkDate.value,
    (value) => {
      progress.value = value
      summary.value = value.summary
      notice.value = value.stage === 'building' ? '正在產生 Excel 報表…' : `正在處理 ${value.currentFile}`
    },
    undefined,
  )
  currentTask = task

  try {
    const result = await task.promise
    if (currentTask !== task) return
    rows.value = result.rows
    records.value = result.records
    summary.value = result.summary
    downloadUrl.value = URL.createObjectURL(
      new Blob([result.report], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    )
    state.value = 'completed'
    const scanResult = `掃描 ${result.summary.scannedFiles} 個檔案，Excel ${result.summary.excelFiles} 個`
    notice.value = result.rows.length
      ? `檢查完成：${scanResult}；共找到 ${result.rows.length} 筆異動。`
      : `檢查完成：${scanResult}；沒有找到門檻後的異動資料。`
  } catch (error) {
    if (currentTask !== task || (error instanceof DOMException && error.name === 'AbortError')) return
    state.value = 'error'
    notice.value = error instanceof Error ? `無法完成報表：${error.message}` : '無法完成報表。'
  } finally {
    if (currentTask === task) currentTask = null
  }
}

function cancel() {
  currentTask?.cancel()
  currentTask = null
  clearResult()
  state.value = 'canceled'
  notice.value = '已取消，本次處理結果已清除。'
}

onBeforeUnmount(() => {
  currentTask?.cancel()
  revokeDownload()
})
</script>

<template>
  <main>
    <header class="hero">
      <div>
        <p class="eyebrow">BROWSER WORKBOOK · LOCAL ONLY</p>
        <h1>電子發票 Excel<br />異動檢查器</h1>
        <p class="intro">選取申報資料夾，逐一辨識檔案內容，整理基準日後的異動資料。</p>
      </div>
      <p class="privacy-mark"><span aria-hidden="true">●</span> 純前端處理，檔案不會離開這台裝置</p>
    </header>

    <section class="workspace" aria-labelledby="workflow-title">
      <div class="section-heading">
        <div>
          <p class="section-kicker">處理流程</p>
          <h2 id="workflow-title">三步完成異動清冊</h2>
        </div>
        <p v-if="folderName" class="folder-name" :title="folderName">{{ folderName }}</p>
      </div>

      <ol class="steps">
        <li class="step">
          <span class="step-number" aria-hidden="true">01</span>
          <div class="step-content">
            <h3>指定申報資料</h3>
            <p>掃描選取資料夾及所有子資料夾；是否為 Excel 以檔案內容判定。</p>
            <input
              id="source-folder"
              class="file-input"
              type="file"
              webkitdirectory
              multiple
              :disabled="state === 'running'"
              @change="selectFolder"
            />
            <label class="folder-button" for="source-folder">選擇來源資料夾</label>
            <p v-if="selectedFiles.length" class="selection-summary">
              {{ selectedFiles.length }} 個檔案 · 全部將依內容掃描
            </p>
          </div>
        </li>

        <li class="step">
          <span class="step-number" aria-hidden="true">02</span>
          <div class="step-content">
            <h3>設定判斷基準</h3>
            <p>只列出最後異動時間晚於所選日期台北時間 00:00 的資料。</p>
            <label for="check-date">異動檢查門檻</label>
            <div class="select-row">
              <input id="check-date" v-model="checkDate" type="date" required :disabled="state === 'running'" />
              <span>台北時間 00:00</span>
            </div>
          </div>
        </li>

        <li class="step">
          <span class="step-number" aria-hidden="true">03</span>
          <div class="step-content">
            <h3>執行與取得報表</h3>
            <p>檔案會依完整相對路徑循序處理；單一檔案失敗不影響其餘檔案。</p>
            <div class="actions">
              <button data-action="start" class="primary" type="button" :disabled="!canStart" @click="start">
                開始檢查
              </button>
              <button
                v-if="state === 'running'"
                data-action="cancel"
                class="secondary"
                type="button"
                @click="cancel"
              >
                取消
              </button>
            </div>

            <div v-if="state === 'running'" class="progress-panel">
              <progress
                v-if="progress.stage === 'analyzing'"
                aria-label="處理進度"
                :value="progress.completed"
                :max="progress.total"
              >
                {{ progress.completed }} / {{ progress.total }}
              </progress>
              <progress v-else aria-label="產生報表進度">正在產生報表</progress>
              <p>
                <strong v-if="progress.stage === 'analyzing'">
                  {{ progress.completed }} / {{ progress.total }}
                </strong>
                <strong v-else>產生報表中</strong>
                <span v-if="progress.currentFile">{{ progress.currentFile }}</span>
              </p>
              <p class="scan-summary">
                <span>Excel {{ progress.summary.excelFiles }}</span>
                <span>完成 {{ progress.summary.processedExcelFiles }}</span>
                <span>略過 {{ progress.summary.skippedExcelFiles }}</span>
                <span>非 Excel {{ progress.summary.nonExcelFiles }}</span>
              </p>
            </div>
          </div>
        </li>
      </ol>

      <p class="notice" :class="{ warning: state === 'error' || state === 'canceled' }" aria-live="polite">
        {{ notice }}
      </p>
    </section>

    <section v-if="state === 'completed'" class="results" aria-labelledby="results-title">
      <div class="results-heading">
        <div>
          <p class="section-kicker">檢查結果</p>
          <h2 id="results-title">異動資料 {{ rows.length }} 筆</h2>
          <p class="result-summary">
            掃描 {{ summary.scannedFiles }} 個檔案 · Excel {{ summary.excelFiles }} 個 · 成功
            {{ summary.processedExcelFiles }} 個 · 略過 Excel {{ summary.skippedExcelFiles }} 個 · 非 Excel
            {{ summary.nonExcelFiles }} 個
          </p>
        </div>
        <a class="download" :href="downloadUrl" download="營業稅資料變更通知.xlsx">下載 Excel</a>
      </div>

      <div v-if="rows.length" class="table-scroll">
        <table data-table="results">
          <thead>
            <tr>
              <th scope="col">統一編號</th>
              <th scope="col">檔案名稱</th>
              <th scope="col">發票號碼/折讓單號碼</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in visibleRows" :key="`${row.taxId}-${row.fileName}-${row.documentNumber}-${index}`">
              <td class="data-cell">{{ row.taxId }}</td>
              <td>{{ row.fileName }}</td>
              <td class="data-cell">{{ row.documentNumber }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty-state">這次沒有找到門檻後的異動資料，仍可下載包含處理紀錄的 Excel。</p>

      <nav v-if="totalPages > 1" class="pagination" aria-label="結果分頁">
        <button type="button" :disabled="page === 1" @click="page -= 1">上一頁</button>
        <span>第 {{ page }} / {{ totalPages }} 頁</span>
        <button type="button" :disabled="page === totalPages" @click="page += 1">下一頁</button>
      </nav>

      <details>
        <summary>處理紀錄（{{ records.length }}）</summary>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">檔案／項目</th>
                <th scope="col">處理結果</th>
                <th scope="col">異動筆數</th>
                <th scope="col">說明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(record, index) in records" :key="`${record.item}-${index}`">
                <td>{{ record.item }}</td>
                <td>
                  <span class="status" :class="{ 'is-skipped': record.status === 'skipped' }">
                    {{ record.status === 'processed' ? '完成' : '略過' }}
                  </span>
                </td>
                <td class="data-cell">{{ record.changeCount }}</td>
                <td>{{ record.message }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </section>
  </main>
</template>
