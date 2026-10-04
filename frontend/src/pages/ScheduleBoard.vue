<script setup lang="ts">
/**
 * /schedule 养护排程台
 * 把复壮措施、加固件复查、衰弱复评三类现场作业统一排队：
 * - 收集来源台账待办 → 按保护级别 / 超期天数 / 复评风险排序并自动排期
 *   （负责人每天最多 3 件、同株古树当天只安排一类现场作业）；
 * - 批次确认时复核来源指纹，确认期间被改动 / 删除 / 失效的条目冲突留台，其余生成工单；
 * - 当前工单可开始执行 / 完成（回写来源台账）/ 取消。
 * 消费模型：ScheduleItem、WorkOrder 与全部来源模型；复用组件：<StatBadge>、<EmptyPanel>、<VigorTag>
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import { useScheduleStore } from '@/stores/scheduleStore'
import { useTreeStore } from '@/stores/treeStore'
import { JOB_KIND_LABEL, type JobKind, type ScheduleItem, type WorkOrder } from '@/types/schedule'
import {
  DAILY_ASSIGN_LIMIT,
  REVIEW_RISK_LABEL,
  reviewRiskLevel,
} from '@/utils/schedule'

const router = useRouter()
const treeStore = useTreeStore()
const scheduleStore = useScheduleStore()

const keyword = ref('')
const kindFilter = ref<JobKind | 'all'>('all')
const stateFilter = ref<'all' | ScheduleItem['state']>('all')
const orderStateFilter = ref<'active' | 'all'>('active')
const selectedIds = ref<string[]>([])
const batchOperator = ref('')
const operating = ref(false)

onMounted(() => {
  void treeStore.loadAll().then(() => {
    void scheduleStore.init()
  })
})

const treeMap = computed<Record<string, { code: string; species: string }>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, { code: tree.code, species: tree.species }]))
)

const treeLevelMap = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, tree.protectLevel]))
)

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function weekday(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()]
}

const KIND_TAG_TYPE: Record<JobKind, 'success' | 'warning' | 'danger'> = {
  measure: 'success',
  support: 'warning',
  review: 'danger',
}

function kindLabel(kind: JobKind): string {
  return JOB_KIND_LABEL[kind]
}

function kindTagType(kind: JobKind): 'success' | 'warning' | 'danger' {
  return KIND_TAG_TYPE[kind]
}

const filteredItems = computed<ScheduleItem[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return scheduleStore.items.filter((item) => {
    if (kindFilter.value !== 'all' && item.kind !== kindFilter.value) return false
    if (stateFilter.value !== 'all' && item.state !== stateFilter.value) return false
    if (key === '') return true
    const label = `${treeMap.value[item.treeId]?.code ?? ''}${treeMap.value[item.treeId]?.species ?? ''}`
    return (
      label.toLowerCase().includes(key) ||
      item.title.toLowerCase().includes(key) ||
      item.operator.toLowerCase().includes(key)
    )
  })
})

const visibleOrders = computed<WorkOrder[]>(() =>
  orderStateFilter.value === 'active' ? scheduleStore.activeOrders : scheduleStore.orders
)

/** 每条排程台条目实际撞档风险提示：负责人当日已排件数（含已生成工单） */
const operatorDailyLoad = computed<Record<string, number>>(() => {
  const counter: Record<string, number> = {}
  const count = (operator: string, date: string): void => {
    const k = `${operator}￨${date}`
    counter[k] = (counter[k] ?? 0) + 1
  }
  scheduleStore.activeOrders.forEach((order) => count(order.operator, order.date))
  scheduleStore.scheduledItems.forEach((item) => count(item.operator, item.plannedDate))
  return counter
})

function loadOf(item: ScheduleItem): number {
  if (item.state !== 'scheduled') return 0
  return operatorDailyLoad.value[`${item.operator}￨${item.plannedDate}`] ?? 0
}

function riskLabelOf(item: ScheduleItem): string {
  const vigor = treeStore.statOf(item.treeId).latestVigor
  return REVIEW_RISK_LABEL[reviewRiskLevel(vigor)]
}

function handleSelectionChange(list: ScheduleItem[]): void {
  selectedIds.value = list.map((item) => item.id)
}

async function handleCollect(): Promise<void> {
  operating.value = true
  try {
    const count = await scheduleStore.collectPending()
    if (count > 0) ElMessage.success(scheduleStore.lastMessage)
    else ElMessage.info(scheduleStore.lastMessage)
  } finally {
    operating.value = false
  }
}

async function handleSchedule(): Promise<void> {
  if (scheduleStore.unassignedItems.length > 0) {
    ElMessage.warning(`还有 ${scheduleStore.unassignedItems.length} 项作业未指派负责人，请先指派后再排期`)
    return
  }
  operating.value = true
  try {
    const result = await scheduleStore.rankAndSchedule()
    if (result.conflicts > 0) {
      ElMessage.warning(scheduleStore.lastMessage)
    } else if (result.scheduled > 0) {
      ElMessage.success(scheduleStore.lastMessage)
    } else {
      ElMessage.info(scheduleStore.lastMessage)
    }
  } finally {
    operating.value = false
  }
}

async function handleConfirm(): Promise<void> {
  if (scheduleStore.scheduledItems.length === 0) {
    ElMessage.info('没有已排期待确认的作业')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将对 ${scheduleStore.scheduledItems.length} 项已排期作业进行批次确认：系统会重新核对来源台账，确认期间被修改 / 删除 / 失效的条目会留在排程台，其余生成现场工单。`,
      '批次确认',
      { type: 'info', confirmButtonText: '确认生成工单', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  operating.value = true
  try {
    const result = await scheduleStore.confirmBatch()
    if (result.conflicts > 0) ElMessage.warning(scheduleStore.lastMessage)
    else ElMessage.success(scheduleStore.lastMessage)
    selectedIds.value = []
  } finally {
    operating.value = false
  }
}

async function handleBatchAssign(): Promise<void> {
  if (batchOperator.value.trim() === '') {
    ElMessage.warning('请先选择或输入负责人')
    return
  }
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选需要指派的条目')
    return
  }
  await scheduleStore.assignOperator(selectedIds.value, batchOperator.value)
  ElMessage.success(scheduleStore.lastMessage)
}

async function handleOperatorChange(item: ScheduleItem, operator: string): Promise<void> {
  await scheduleStore.updateOperator(item.id, operator)
}

function onStartDateChange(value: string): void {
  scheduleStore.setStartDate(value)
}

function onOperatorInput(row: ScheduleItem, value: string): void {
  void handleOperatorChange(row, value)
}

async function handleDiscard(item: ScheduleItem): Promise<void> {
  try {
    await ElMessageBox.confirm(`把「${item.title}」移下排程台？来源台账记录不受影响，之后可再次收集。`, '移下排程台', {
      type: 'warning',
      confirmButtonText: '移下',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await scheduleStore.discardItem(item.id)
  selectedIds.value = selectedIds.value.filter((id) => id !== item.id)
  ElMessage.success(scheduleStore.lastMessage)
}

async function handleAdvance(order: WorkOrder): Promise<void> {
  await scheduleStore.advanceOrder(order)
  ElMessage.success(scheduleStore.lastMessage)
}

async function handleComplete(order: WorkOrder): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认完成工单 ${order.code}（${JOB_KIND_LABEL[order.kind]}）？完成后将回写来源台账。`,
      '完成工单',
      { type: 'success', confirmButtonText: '确认完成', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await scheduleStore.completeOrder(order)
  ElMessage.success(scheduleStore.lastMessage)
}

async function handleCancel(order: WorkOrder): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认取消工单 ${order.code}？取消后释放当日排期容量，来源台账不变。`, '取消工单', {
      type: 'warning',
      confirmButtonText: '确认取消',
      cancelButtonText: '再想想',
    })
  } catch {
    return
  }
  await scheduleStore.cancelOrder(order)
  ElMessage.info(scheduleStore.lastMessage)
}

async function handleDeleteOrder(order: WorkOrder): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除工单 ${order.code}？仅删除工单记录，来源台账不变。`, '删除工单', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await scheduleStore.deleteOrder(order.id)
  ElMessage.success('工单已删除')
}

function orderStateTagType(state: WorkOrder['state']): 'info' | 'warning' | 'success' | 'danger' {
  if (state === '待执行') return 'info'
  if (state === '执行中') return 'warning'
  if (state === '已完成') return 'success'
  return 'danger'
}

function itemStateTagType(state: ScheduleItem['state']): 'info' | 'primary' | 'danger' {
  if (state === 'pending') return 'info'
  if (state === 'scheduled') return 'primary'
  return 'danger'
}

function goTree(treeId: string): void {
  treeStore.selectTree(treeId)
  void router.push(`/trees/${treeId}/surveys`)
}

function tableRowClass({ row }: { row: ScheduleItem }): string {
  return row.state === 'conflict' ? 'row-conflict' : ''
}

function isSelectable(row: ScheduleItem): boolean {
  return row.state !== 'conflict'
}
</script>

<template>
  <div v-loading="scheduleStore.loading || !treeStore.ready">
    <div class="stat-row">
      <StatBadge label="待排序" :value="scheduleStore.pendingItems.length" suffix="项" tone="info" icon="Histogram" />
      <StatBadge
        label="已排期待确认"
        :value="scheduleStore.scheduledItems.length"
        suffix="项"
        tone="primary"
        icon="PieChart"
        hint="已经排入计划日期、等待批次确认生成工单的作业"
      />
      <StatBadge
        label="冲突留台"
        :value="scheduleStore.conflictItems.length"
        suffix="项"
        :tone="scheduleStore.conflictItems.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="批次确认期间来源台账被修改 / 删除 / 失效，留在排程台等待重新排序"
      />
      <StatBadge
        label="当前工单"
        :value="scheduleStore.activeOrders.length"
        suffix="张"
        :tone="scheduleStore.activeOrders.length > 0 ? 'warning' : 'success'"
        icon="Warning"
      />
      <StatBadge
        label="来源待办"
        :value="scheduleStore.uncollectedCount"
        suffix="项"
        tone="default"
        icon="TrendCharts"
        size="small"
        hint="来源台账中尚未收集进排程台的待办（到期措施 / 超期加固件 / 衰弱到期复评）"
      />
    </div>

    <el-alert
      v-if="scheduleStore.conflictItems.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`${scheduleStore.conflictItems.length} 项作业在批次确认期间检测到来源变动，已留在排程台等待重新排序`"
    >
      <template #default>
        <div class="conflict-list">
          <div v-for="item in scheduleStore.conflictItems" :key="item.id">
            <el-tag size="small" :type="KIND_TAG_TYPE[item.kind]">{{ JOB_KIND_LABEL[item.kind] }}</el-tag>
            <span class="conflict-tree">{{ treeMap[item.treeId]?.code ?? '（古树已删除）' }}</span>
            <span class="conflict-title">{{ item.title }}</span>
            <em class="conflict-reason">{{ item.conflictReason }}</em>
          </div>
        </div>
      </template>
    </el-alert>

    <el-alert
      v-if="scheduleStore.unassignedItems.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`${scheduleStore.unassignedItems.length} 项作业尚未指派负责人（加固件复查、衰弱复评默认无负责人），排期前请先指派`"
    />

    <el-card shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">养护排程台</span>
          <el-space wrap>
            <el-button :loading="operating" @click="handleCollect">
              <el-icon><Refresh /></el-icon>
              <span>收集来源待办{{ scheduleStore.uncollectedCount > 0 ? `（${scheduleStore.uncollectedCount}）` : '' }}</span>
            </el-button>
            <el-date-picker
              :model-value="scheduleStore.startDate"
              type="date"
              value-format="YYYY-MM-DD"
              :clearable="false"
              size="default"
              prefix-icon="Calendar"
              placeholder="排期起始日期"
              style="width: 170px"
              @update:model-value="onStartDateChange"
            />
            <el-button type="primary" plain :loading="operating" @click="handleSchedule">
              <el-icon><Sort /></el-icon>
              <span>按优先级自动排期</span>
            </el-button>
            <el-button type="success" :loading="operating" @click="handleConfirm">
              <el-icon><CircleCheck /></el-icon>
              <span>批次确认生成工单</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <el-alert type="info" :closable="false" class="mb-14">
        <template #title>
          排序规则：保护级别（一级 &gt; 二级 &gt; 三级）→ 超期天数（措施逾期 / 加固件超周期 / 衰弱复评到期）→
          复评风险（濒危 &gt; 衰弱）。排期硬约束：一名负责人每天最多承接
          <b>{{ DAILY_ASSIGN_LIMIT }}</b> 件；同一株古树当天只安排<b>一类</b>现场作业。
        </template>
      </el-alert>

      <div class="toolbar">
        <el-input v-model="keyword" clearable placeholder="搜索编号 / 作业内容 / 负责人" style="width: 230px">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-radio-group v-model="kindFilter">
          <el-radio-button label="all">全部作业</el-radio-button>
          <el-radio-button label="measure">复壮措施</el-radio-button>
          <el-radio-button label="support">加固件复查</el-radio-button>
          <el-radio-button label="review">衰弱复评</el-radio-button>
        </el-radio-group>
        <el-radio-group v-model="stateFilter">
          <el-radio-button label="all">全部状态</el-radio-button>
          <el-radio-button label="pending">待排序</el-radio-button>
          <el-radio-button label="scheduled">已排期</el-radio-button>
          <el-radio-button label="conflict">冲突留台</el-radio-button>
        </el-radio-group>
        <span class="toolbar__spacer" />
        <el-select
          v-model="batchOperator"
          filterable
          allow-create
          default-first-option
          placeholder="批量指派负责人"
          style="width: 180px"
        >
          <el-option v-for="name in scheduleStore.operatorOptions" :key="name" :value="name" :label="name" />
        </el-select>
        <el-button :disabled="selectedIds.length === 0" @click="handleBatchAssign">
          指派给勾选（{{ selectedIds.length }}）
        </el-button>
      </div>

      <EmptyPanel
        v-if="scheduleStore.items.length === 0 && scheduleStore.ready"
        title="排程台为空"
        description="点击「收集来源待办」，系统会把到期未完成的复壮措施、超期未检查的加固件与到期的衰弱/濒危复评统一收集到这里，再按保护级别、超期天数与复评风险排序排期。"
        action-text="收集来源待办"
        @action="handleCollect"
      />

      <el-table
        v-else
        :data="filteredItems"
        row-key="id"
        stripe
        :row-class-name="tableRowClass"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="46" :selectable="isSelectable" />
        <el-table-column label="作业类别" width="110">
          <template #default="{ row }">
            <el-tag :type="kindTagType(row.kind)" effect="dark">{{ kindLabel(row.kind) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="古树 / 级别" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="goTree(row.treeId)">
                {{ treeMap[row.treeId]?.code ?? '（古树已删除）' }} {{ treeMap[row.treeId]?.species ?? '' }}
              </el-link>
              <el-tag size="small" :type="treeLevelMap[row.treeId] === '一级' ? 'danger' : treeLevelMap[row.treeId] === '二级' ? 'warning' : 'info'">
                {{ treeLevelMap[row.treeId] ?? '—' }}保护
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="作业内容" min-width="230">
          <template #default="{ row }">
            <span>{{ row.title }}</span>
            <div v-if="row.state === 'conflict'" class="cell-reason">{{ row.conflictReason }}</div>
          </template>
        </el-table-column>
        <el-table-column label="超期天数" width="100" align="right">
          <template #default="{ row }">
            <span :class="{ 'cell-warn': row.overdueDays > 0 }">{{ row.overdueDays }} 天</span>
          </template>
        </el-table-column>
        <el-table-column label="复评风险" width="130">
          <template #default="{ row }">
            <VigorTag :vigor="treeStore.statOf(row.treeId).latestVigor" :show-trend="false" size="small" />
            <div class="cell-sub">{{ riskLabelOf(row) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="优先级分" width="96" align="right">
          <template #default="{ row }">
            <b>{{ row.priorityScore }}</b>
          </template>
        </el-table-column>
        <el-table-column label="负责人" width="170">
          <template #default="{ row }">
            <el-select
              :model-value="row.operator"
              filterable
              allow-create
              default-first-option
              size="small"
              :placeholder="'待指派'"
              :disabled="row.state === 'conflict'"
              style="width: 140px"
              @update:model-value="(value: string) => onOperatorInput(row, value)"
            >
              <el-option v-for="name in scheduleStore.operatorOptions" :key="name" :value="name" :label="name" />
            </el-select>
            <el-icon v-if="row.operator === '' && row.state !== 'conflict'" class="cell-warn-icon"><WarningFilled /></el-icon>
          </template>
        </el-table-column>
        <el-table-column label="计划日期" width="150">
          <template #default="{ row }">
            <div v-if="row.state === 'scheduled'" class="cell-stack">
              <span>{{ row.plannedDate }} {{ weekday(row.plannedDate) }}</span>
              <el-tag
                size="small"
                :type="loadOf(row) >= DAILY_ASSIGN_LIMIT ? 'danger' : 'info'"
                effect="plain"
              >
                {{ row.operator }} 当日第 {{ loadOf(row) }} 件
              </el-tag>
            </div>
            <el-tag v-else-if="row.state === 'conflict'" type="danger" size="small" effect="plain">等待重新排序</el-tag>
            <span v-else class="cell-sub">待排期</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="itemStateTagType(row.state)" size="small" effect="dark">
              {{ row.state === 'pending' ? '待排序' : row.state === 'scheduled' ? '已排期' : '冲突留台' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button link type="danger" size="small" @click="handleDiscard(row)">移下排程台</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">当前工单（来源台账与养护总览同步显示）</span>
          <el-radio-group v-model="orderStateFilter">
            <el-radio-button label="active">进行中（{{ scheduleStore.activeOrders.length }}）</el-radio-button>
            <el-radio-button label="all">全部工单（{{ scheduleStore.orders.length }}）</el-radio-button>
          </el-radio-group>
        </div>
      </template>

      <el-empty v-if="visibleOrders.length === 0" description="暂无工单：先收集待办、自动排期并批次确认" />

      <el-table v-else :data="visibleOrders" row-key="id" stripe>
        <el-table-column prop="code" label="工单号" width="150" />
        <el-table-column label="计划日期" width="150">
          <template #default="{ row }">
            <span>{{ row.date }}</span>
            <span class="cell-sub"> {{ weekday(row.date) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="古树" min-width="170">
          <template #default="{ row }">
            <el-link type="primary" @click="goTree(row.treeId)">
              {{ treeMap[row.treeId]?.code ?? '（古树已删除）' }} {{ treeMap[row.treeId]?.species ?? '' }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="类别" width="100">
          <template #default="{ row }">
            <el-tag :type="kindTagType(row.kind)" size="small">{{ kindLabel(row.kind) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="作业内容" min-width="200" />
        <el-table-column prop="operator" label="负责人" width="100" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="orderStateTagType(row.state)" size="small" effect="dark">{{ row.state }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.state === '待执行'" link type="primary" size="small" @click="handleAdvance(row)">
              开始执行
            </el-button>
            <el-button
              v-if="row.state === '待执行' || row.state === '执行中'"
              link
              type="success"
              size="small"
              @click="handleComplete(row)"
            >
              完成并回写
            </el-button>
            <el-button
              v-if="row.state === '待执行' || row.state === '执行中'"
              link
              type="warning"
              size="small"
              @click="handleCancel(row)"
            >
              取消
            </el-button>
            <el-button
              v-if="row.state === '已完成' || row.state === '已取消'"
              link
              type="danger"
              size="small"
              @click="handleDeleteOrder(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}

.toolbar__spacer {
  flex: 1;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.cell-reason {
  font-size: 12px;
  color: #c0392b;
  margin-top: 2px;
}

.cell-warn {
  color: #c0392b;
  font-weight: 700;
}

.cell-warn-icon {
  color: #d68910;
  margin-left: 4px;
  vertical-align: -2px;
}

.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.8;
}

.conflict-tree {
  margin: 0 6px 0 8px;
  font-weight: 600;
}

.conflict-title {
  color: #6b6257;
}

.conflict-reason {
  margin-left: 8px;
  font-style: normal;
  color: #c0392b;
}

:deep(.row-conflict) {
  --el-table-tr-bg-color: #fdf3f2;
}
</style>
