<script setup lang="ts">
/**
 * /schedule 排程台
 * 复壮措施、加固件复查、衰弱复评三类现场作业统一排期：
 * - 按「保护级别 → 超期天数 → 复评风险」决定先后
 * - 一名负责人每天最多 3 件，同株古树当天只安排一类现场作业
 * - 批次确认期间来源记录被修改的条目留台标冲突，其余生成工单号
 * 消费模型：WorkOrder + Tree/Measure/Support/Review；复用组件：<StatBadge>、<WorkOrderTag>
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import StatBadge from '@/components/common/StatBadge.vue'
import WorkOrderTag from '@/components/common/WorkOrderTag.vue'
import { useScheduleStore } from '@/stores/scheduleStore'
import { useTreeStore } from '@/stores/treeStore'
import { MAX_DAILY_PER_OPERATOR, MAX_DAILY_PER_OPERATOR as MAX_DAILY, WORK_KIND_LABEL, type WorkOrder } from '@/types/workOrder'
import { today } from '@/utils/id'

const treeStore = useTreeStore()
const scheduleStore = useScheduleStore()

const operatorDialogVisible = ref(false)
const newOperator = ref('')
const orderFilterOperator = ref('all')
const orderFilterDate = ref('all')

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

const todayStr = today()

const todayOrders = computed<WorkOrder[]>(() =>
  scheduleStore.scheduledOrders.filter((order) => order.plannedDate === todayStr)
)

const conflictCount = computed<number>(
  () => scheduleStore.stagingOrders.filter((order) => order.status === 'conflict').length
)

const filteredOrders = computed<WorkOrder[]>(() =>
  scheduleStore.scheduledOrders.filter((order) => {
    if (orderFilterOperator.value !== 'all' && order.operator !== orderFilterOperator.value) return false
    if (orderFilterDate.value === 'today' && order.plannedDate !== todayStr) return false
    return true
  })
)

const operatorDailyLoad = computed<Record<string, number>>(() => {
  const result: Record<string, number> = {}
  scheduleStore.scheduledOrders.forEach((order) => {
    if (order.plannedDate === todayStr) result[order.operator] = (result[order.operator] ?? 0) + 1
  })
  return result
})

onMounted(() => {
  void treeStore.loadAll()
  void scheduleStore.init()
})

function kindTagType(kind: WorkOrder['kind']): 'success' | 'warning' | 'danger' {
  if (kind === 'measure') return 'success'
  if (kind === 'support') return 'warning'
  return 'danger'
}

function stagingRowClass({ row }: { row: WorkOrder }): string {
  if (row.status === 'conflict') return 'row-conflict'
  return scheduleStore.staleIds.has(row.id) ? 'row-stale' : ''
}

function riskTagType(rank: number): 'danger' | 'warning' | 'info' | 'success' {
  if (rank >= 3) return 'danger'
  if (rank === 2) return 'warning'
  if (rank === 1) return 'info'
  return 'success'
}

async function handleLoadCandidates(): Promise<void> {
  const count = await scheduleStore.loadCandidates()
  if (count > 0) ElMessage.success(`已载入 ${count} 条候选`)
  else ElMessage.info('当前没有待排期的候选作业（未完成措施 / 超期加固件 / 衰弱濒危复评）')
}

async function handleAutoSort(): Promise<void> {
  if (scheduleStore.stagingOrders.length === 0) {
    ElMessage.info('排程台为空，请先载入候选')
    return
  }
  const { sorted, obsolete } = await scheduleStore.autoSort()
  ElMessage.success(`自动排序完成：派工 ${sorted} 条${obsolete > 0 ? `，${obsolete} 条来源已失效留台` : ''}`)
}

async function handleConfirmBatch(): Promise<void> {
  const staging = scheduleStore.stagingOrders
  if (staging.length === 0) {
    ElMessage.info('排程台没有待确认条目')
    return
  }
  const stale = staging.filter((order) => scheduleStore.staleIds.has(order.id)).length
  try {
    await ElMessageBox.confirm(
      `将对排程台 ${staging.length} 条作业做批次确认。系统会重新读取来源记录：确认期间被修改 / 删除的条目会留在排程台等待重新排序，其余生成工单号。` +
        (stale > 0 ? `\n\n当前已有 ${stale} 条来源记录相对入台时发生变化，将直接留台。` : ''),
      '批次确认',
      { type: 'warning', confirmButtonText: '确认生成工单', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await scheduleStore.confirmBatch()
  if (result.confirmed > 0) {
    ElMessage.success(`批次 ${result.batchNo}：生成 ${result.confirmed} 张工单，${result.conflicts} 条冲突留台`)
  } else {
    ElMessage.warning(`本批次未生成工单，${result.conflicts} 条全部留台，请处理冲突后重新排序`)
  }
}

async function handleOperatorChange(order: WorkOrder, value: string): Promise<void> {
  const err = await scheduleStore.updateDraft(order.id, { operator: value })
  if (err) ElMessage.error(err)
}

async function handleDateChange(order: WorkOrder, value: string): Promise<void> {
  if (!value) return
  const err = await scheduleStore.updateDraft(order.id, { plannedDate: value })
  if (err) {
    ElMessage.error(err)
  }
}

async function handleRefreshStale(order: WorkOrder): Promise<void> {
  await scheduleStore.refreshStale(order.id)
  ElMessage.success('已按来源最新记录刷新，请重新执行自动排序')
}

async function handleRemoveStaging(order: WorkOrder): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认把「${treeLabel.value[order.treeId] ?? '该古树'} · ${WORK_KIND_LABEL[order.kind]}」移出排程台？`, '移除确认', {
      type: 'warning',
      confirmButtonText: '移除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await scheduleStore.removeStaging(order.id)
}

async function handleFinish(order: WorkOrder): Promise<void> {
  const extra =
    order.kind === 'measure'
      ? '完工后来源复壮措施将同步标记为「已完成」并回写古树最近复壮日期。'
      : order.kind === 'support'
        ? '完工后将同步登记该加固件本次检查日期，解除超期提醒。'
        : '完工后在复评台账可继续跟踪后续措施落实。'
  try {
    await ElMessageBox.confirm(`确认工单 ${order.code}（${WORK_KIND_LABEL[order.kind]}）已完工？${extra}`, '完工登记', {
      type: 'success',
      confirmButtonText: '确认完工',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await scheduleStore.finishOrder(order.id, { syncMeasure: order.kind === 'measure' })
  ElMessage.success(`工单 ${order.code} 已完工`)
}

async function handleCancelOrder(order: WorkOrder): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认取消工单 ${order.code}？取消后来源作业可重新进入排程台。`, '取消工单', {
      type: 'warning',
      confirmButtonText: '取消工单',
      cancelButtonText: '返回',
    })
  } catch {
    return
  }
  await scheduleStore.cancelOrder(order.id)
}

function addOperator(): void {
  scheduleStore.addOperator(newOperator.value)
  newOperator.value = ''
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="待排候选" :value="scheduleStore.candidates.length" suffix="条" tone="primary" icon="Histogram" hint="未完成措施 + 超期加固件 + 衰弱/濒危复评，且未在排程台/工单中" />
      <StatBadge label="排程台条目" :value="scheduleStore.stagingOrders.length" suffix="条" tone="info" icon="Tickets" />
      <StatBadge
        label="冲突留台"
        :value="conflictCount"
        suffix="条"
        :tone="conflictCount > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="批次确认期间来源记录被修改 / 删除，或违反派工约束"
      />
      <StatBadge label="待执行工单" :value="scheduleStore.scheduledOrders.length" suffix="张" tone="warning" icon="DataLine" />
      <StatBadge label="今日到场" :value="todayOrders.length" suffix="张" tone="success" icon="AlarmClock" />
      <StatBadge label="累计完工" :value="scheduleStore.finishedOrders.length" suffix="张" tone="default" icon="PieChart" size="small" />
    </div>

    <el-alert
      v-if="todayOrders.length > 0"
      type="success"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`今日（${todayStr}）有 ${todayOrders.length} 张工单到场`"
    >
      <template #default>
        <div class="today-list">
          <div v-for="order in todayOrders" :key="order.id">
            {{ order.code }} · {{ treeLabel[order.treeId] ?? '（古树已删除）' }} · {{ WORK_KIND_LABEL[order.kind] }} · 负责人
            {{ order.operator }}
          </div>
        </div>
      </template>
    </el-alert>

    <!-- ===================== 排程台 ===================== -->
    <el-card shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">排程台（按 保护级别 → 超期天数 → 复评风险 排序）</span>
          <el-space wrap>
            <span class="toolbar-label">派工起始日</span>
            <el-date-picker
              :model-value="scheduleStore.startDate"
              type="date"
              value-format="YYYY-MM-DD"
              size="small"
              style="width: 150px"
              @update:model-value="(value: string) => value && scheduleStore.setStartDate(value)"
            />
            <el-button size="small" @click="operatorDialogVisible = true">负责人名单（{{ scheduleStore.operatorOptions.length }}）</el-button>
            <el-button type="info" plain :disabled="scheduleStore.candidates.length === 0" @click="handleLoadCandidates">
              载入候选（{{ scheduleStore.candidates.length }}）
            </el-button>
            <el-button type="primary" plain :disabled="scheduleStore.stagingOrders.length === 0" @click="handleAutoSort">
              自动排序派工
            </el-button>
            <el-button type="primary" :disabled="scheduleStore.stagingOrders.length === 0" @click="handleConfirmBatch">
              批次确认生成工单
            </el-button>
          </el-space>
        </div>
      </template>

      <el-alert
        type="info"
        show-icon
        :closable="false"
        class="mb-14"
        title="派工硬约束：一名负责人每天最多承接 3 件现场作业；同株古树当天只安排一类现场作业（复壮措施 / 加固件复查 / 衰弱复评互斥）。"
        description="自动排序按优先级贪心派工；也可以在表内手工调整负责人与日期，系统会即时校验。批次确认时会再次校验，并检测来源记录在确认期间是否被改动。"
      />

      <el-table
        v-if="scheduleStore.stagingOrders.length > 0"
        :data="scheduleStore.stagingOrders"
        row-key="id"
        stripe
        :row-class-name="stagingRowClass"
      >
        <el-table-column label="#" type="index" width="46" />
        <el-table-column label="古树 / 作业" min-width="210">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ treeLabel[row.treeId] ?? '（古树已删除）' }}</span>
              <el-tag :type="kindTagType(row.kind)" size="small">{{ WORK_KIND_LABEL[row.kind as WorkOrder['kind']] }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="来源摘要" min-width="230">
          <template #default="{ row }">
            <span>{{ row.snapshot.sourceKey }}</span>
          </template>
        </el-table-column>
        <el-table-column label="保护级别" width="92" align="center">
          <template #default="{ row }">
            <el-tag :type="row.snapshot.protectLevel === '一级' ? 'danger' : row.snapshot.protectLevel === '二级' ? 'warning' : 'info'" size="small">
              {{ row.snapshot.protectLevel }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="超期天数" width="100" align="right">
          <template #default="{ row }">
            <span :class="{ 'num-danger': row.snapshot.overdueDays > 0 }">{{ row.snapshot.overdueDays }} 天</span>
          </template>
        </el-table-column>
        <el-table-column label="复评风险" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="riskTagType(row.snapshot.riskRank)" size="small" effect="plain">{{ row.snapshot.riskLabel }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="`负责人（日≤${MAX_DAILY}）`" width="170">
          <template #default="{ row }">
            <el-select
              :model-value="row.operator"
              size="small"
              filterable
              allow-create
              style="width: 100%"
              @update:model-value="(value: string) => handleOperatorChange(row, value)"
            >
              <el-option v-for="name in scheduleStore.operatorOptions" :key="name" :value="name" :label="name" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="计划日期" width="160">
          <template #default="{ row }">
            <el-date-picker
              :model-value="row.plannedDate"
              type="date"
              value-format="YYYY-MM-DD"
              size="small"
              style="width: 140px"
              @update:model-value="(value: string) => handleDateChange(row, value)"
            />
          </template>
        </el-table-column>
        <el-table-column label="状态 / 冲突原因" min-width="220">
          <template #default="{ row }">
            <el-tag :type="row.status === 'conflict' ? 'danger' : 'info'" size="small" effect="dark">
              {{ row.status === 'conflict' ? '来源冲突' : '待确认' }}
            </el-tag>
            <div v-if="scheduleStore.staleReason(row)" class="conflict-reason">
              {{ row.status === 'conflict' ? row.conflictReason : scheduleStore.staleReason(row) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="scheduleStore.staleIds.has(row.id)"
              link
              type="warning"
              size="small"
              @click="handleRefreshStale(row)"
            >
              刷新并重排
            </el-button>
            <el-button link type="danger" size="small" @click="handleRemoveStaging(row)">移出</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-else description="排程台为空：先「载入候选」，再「自动排序派工」，最后「批次确认生成工单」" />
    </el-card>

    <!-- ===================== 工单台账 ===================== -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">当前工单（已生成 · 待执行 / 已完工）</span>
          <el-space wrap>
            <el-select v-model="orderFilterDate" size="small" style="width: 120px">
              <el-option value="all" label="全部日期" />
              <el-option value="today" label="仅今日" />
            </el-select>
            <el-select v-model="orderFilterOperator" size="small" filterable style="width: 140px">
              <el-option value="all" label="全部负责人" />
              <el-option v-for="name in scheduleStore.operatorOptions" :key="name" :value="name" :label="name" />
            </el-select>
          </el-space>
        </div>
      </template>

      <el-table :data="filteredOrders" row-key="id" stripe>
        <el-table-column label="工单号" width="170">
          <template #default="{ row }">
            <WorkOrderTag :order="row" :show-empty="false" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="古树" min-width="180">
          <template #default="{ row }">{{ treeLabel[row.treeId] ?? '（古树已删除）' }}</template>
        </el-table-column>
        <el-table-column label="作业类型" width="110">
          <template #default="{ row }">
            <el-tag :type="kindTagType(row.kind)" size="small">{{ WORK_KIND_LABEL[row.kind as WorkOrder['kind']] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="plannedDate" label="计划日期" width="120" />
        <el-table-column label="负责人" width="110">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.operator }}</span>
              <span v-if="row.plannedDate === todayStr && (operatorDailyLoad[row.operator] ?? 0) >= MAX_DAILY" class="cell-sub">
                今日已满 {{ MAX_DAILY }} 件
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="批次" width="160">
          <template #default="{ row }">{{ row.batchNo || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button link type="success" size="small" @click="handleFinish(row)">完工登记</el-button>
            <el-button link type="danger" size="small" @click="handleCancelOrder(row)">取消</el-button>
          </template>
        </el-table-column>
        <template #empty>暂无工单：排程台批次确认后会在此生成</template>
      </el-table>
    </el-card>

    <!-- 负责人名单 -->
    <el-dialog v-model="operatorDialogVisible" title="负责人名单" width="420px">
      <el-alert
        type="info"
        show-icon
        :closable="false"
        class="mb-14"
        :title="`一名负责人每天最多承接 ${MAX_DAILY_PER_OPERATOR} 件现场作业，自动排序会优先把任务分给当日负载最小的人。`"
      />
      <el-tag v-for="name in scheduleStore.operatorOptions" :key="name" class="operator-tag" closable>{{ name }}</el-tag>
      <div class="operator-add">
        <el-input v-model="newOperator" placeholder="新增负责人姓名" size="small" @keyup.enter="addOperator" />
        <el-button type="primary" size="small" @click="addOperator">添加</el-button>
      </div>
      <p class="operator-tip">措施记录中出现过的负责人会自动并入名单；来源台账的负责人即排程默认负责人。</p>
    </el-dialog>
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

.toolbar-label {
  font-size: 13px;
  color: #6b6257;
}

.today-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-sub {
  font-size: 12px;
  color: #c0392b;
}

.num-danger {
  color: #c0392b;
  font-weight: 700;
}

.conflict-reason {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: #c0392b;
}

.operator-tag {
  margin: 0 8px 8px 0;
}

.operator-add {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.operator-tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: #8c8479;
}

:deep(.row-conflict) {
  --el-table-tr-bg-color: #fdecea;
}

:deep(.row-stale) {
  --el-table-tr-bg-color: #fdf6ec;
}
</style>
