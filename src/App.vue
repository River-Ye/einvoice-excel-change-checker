<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import {
  classifyFiles,
  getTaipeiMonthInfo,
  type ChangeRow,
  type ClassifiedFiles,
  type ProcessingRecord,
} from './domain'
import { startProcessing, type ProcessingTask, type RunProgress } from './runner'

const PAGE_SIZE = 100
const monthInfo = ref(getTaipeiMonthInfo())
const checkDay = ref(monthInfo.value.defaultDay)
const selection = ref<ClassifiedFiles>({ candidates: [], records: [], tooMany: false })
const selectedCount = ref(0)
const folderName = ref('')
const state = ref<'idle' | 'running' | 'completed' | 'error' | 'canceled'>('idle')
const notice = ref('請先選擇包含 Excel 的來源資料夾。')
const progress = ref<RunProgress>({ stage: 'analyzing', completed: 0, total: 0, currentFile: '' })
const rows = ref<ChangeRow[]>([])
const records = ref<ProcessingRecord[]>([])
const downloadUrl = ref('')
const page = ref(1)
let currentTask: ProcessingTask | null = null

const canStart = computed(
  () => state.value !== 'running' && selection.value.candidates.length > 0 && !selection.value.tooMany,
)
const totalPages = computed(() => Math.max(1, Math.ceil(rows.value.length / PAGE_SIZE)))
const visibleRows = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return rows.value.slice(start, start + PAGE_SIZE)
})
const ignoredCount = computed(() => selectedCount.value - selection.value.candidates.length)

function revokeDownload() {
  if (!downloadUrl.value) return
  URL.revokeObjectURL(downloadUrl.value)
  downloadUrl.value = ''
}

function clearResult() {
  revokeDownload()
  rows.value = []
  records.value = []
  page.value = 1
}

function selectFolder(event: Event) {
  currentTask?.cancel()
  currentTask = null
  clearResult()

  const files = Array.from((event.target as HTMLInputElement).files ?? [])
  selectedCount.value = files.length
  const firstFile = files[0]
  folderName.value = firstFile ? (firstFile.webkitRelativePath || firstFile.name).split('/')[0] || '' : ''
  selection.value = classifyFiles(files)
  state.value = 'idle'

  if (!files.length) notice.value = '沒有選取資料夾。'
  else if (selection.value.tooMany) notice.value = '符合條件的 Excel 超過上限，最多處理 100 個。'
  else if (!selection.value.candidates.length) notice.value = '資料夾內沒有符合命名與大小條件的 Excel。'
  else notice.value = `已找到 ${selection.value.candidates.length} 個可處理的 Excel。`
}

async function start() {
  if (!canStart.value) return

  const startedAt = new Date().toISOString()
  const currentMonth = getTaipeiMonthInfo(startedAt)
  const monthChanged =
    currentMonth.year !== monthInfo.value.year || currentMonth.month !== monthInfo.value.month
  monthInfo.value = currentMonth
  clearResult()

  if (monthChanged && !currentMonth.days.includes(checkDay.value)) {
    checkDay.value = currentMonth.defaultDay
    state.value = 'idle'
    notice.value = `月份已更新，請重新確認異動檢查門檻；日期已改回 ${currentMonth.defaultDay} 號。`
    return
  }

  state.value = 'running'
  notice.value = '正在準備檔案…'
  progress.value = {
    stage: 'analyzing',
    completed: 0,
    total: selection.value.candidates.length,
    currentFile: '',
  }

  const task = startProcessing(
    selection.value.candidates,
    checkDay.value,
    selection.value.records,
    (value) => {
      progress.value = value
      notice.value = value.stage === 'building' ? '正在產生 Excel 報表…' : `正在處理 ${value.currentFile}`
    },
    undefined,
    startedAt,
  )
  currentTask = task

  try {
    const result = await task.promise
    if (currentTask !== task) return
    rows.value = result.rows
    records.value = result.records
    downloadUrl.value = URL.createObjectURL(
      new Blob([result.report], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    )
    state.value = 'completed'
    notice.value = result.rows.length
      ? `檢查完成，共找到 ${result.rows.length} 筆異動。`
      : '檢查完成，沒有找到門檻後的異動資料。'
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
        <p class="intro">選取申報資料夾，自動略過不符條件的檔案，整理門檻日後的異動資料。</p>
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
            <p>只讀取以 8 碼統編開頭的 .xlsx；客戶資料與其他檔案會略過。</p>
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
            <p v-if="selectedCount" class="selection-summary">
              {{ selectedCount }} 個檔案 · {{ selection.candidates.length }} 個待處理 ·
              {{ ignoredCount }} 個略過
            </p>
            <p v-if="selection.tooMany" class="warning" role="alert">
              符合條件的 Excel 超過上限，最多處理 100 個。請拆分資料夾後重試。
            </p>
          </div>
        </li>

        <li class="step">
          <span class="step-number" aria-hidden="true">02</span>
          <div class="step-content">
            <h3>設定判斷基準</h3>
            <p>只列出最後異動時間晚於台北時間門檻的資料。</p>
            <label for="check-day">異動檢查門檻</label>
            <div class="select-row">
              <span>{{ monthInfo.year }} 年 {{ monthInfo.month }} 月</span>
              <select id="check-day" v-model.number="checkDay" :disabled="state === 'running'">
                <option v-for="day in monthInfo.days" :key="day" :value="day">{{ day }} 號 00:00</option>
              </select>
            </div>
          </div>
        </li>

        <li class="step">
          <span class="step-number" aria-hidden="true">03</span>
          <div class="step-content">
            <h3>執行與取得報表</h3>
            <p>檔案會依路徑循序處理；單一檔案失敗不影響其餘檔案。</p>
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
