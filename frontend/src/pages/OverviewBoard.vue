<script setup lang="ts">
/**
 * /overview 养护总览
 * 汇总当前工单、未来排期、负责人每日负载（每名负责人每天最多 3 件）与每株古树的在途工单；
 * 与各来源台账共同展示「当前工单」。
 * 消费模型：WorkOrder、Tree；复用组件：<StatBadge>、<WorkOrderTag>、<VigorTag>
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import WorkOrderTag from '@/components/common/WorkOrderTag.vue'
import { useScheduleStore } from '@/stores/scheduleStore'
import { useTreeStore } from '@/stores/treeStore'
import { MAX_DAILY_PER_OPERATOR, WORK_KIND_LABEL, type WorkKind, type WorkOrder } from '@/types/workOrder'
import { today } from '@/utils/id'
import { ROUTES } from '@/router'

const router = useRouter()
const treeStore = useTreeStore()
const scheduleStore = useScheduleStore()

const treeFilter = ref('all')
const todayStr = today()

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

const todayOrders = computed<WorkOrder[]>(() =>
  scheduleStore.scheduledOrders.filter((order) => order.plannedDate === todayStr)
)

/** 未来 7 天（含今天）的工单 */
const upcomingOrders = computed<WorkOrder[]>(() => {
  const end = new Date(`${todayStr}T00:00:00`)
  end.setDate(end.getDate() + 6)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const endStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`
  return scheduleStore.scheduledOrders.filter((order) => order.plannedDate >= todayStr && order.plannedDate <= endStr)
})

/** 负责人 × 今日负载 */
const operatorLoadRows = computed<Array<{ name: string; today: number; total: number }>>(() => {
  const map = new Map<string, { name: string; today: number; total: number }>()
  scheduleStore.scheduledOrders.forEach((order) => {
    if (!map.has(order.operator)) map.set(order.operator, { name: order.operator, today: 0, total: 0 })
    const row = map.get(order.operator)!
    row.total += 1
    if (order.plannedDate === todayStr) row.today += 1
  })
  return Array.from(map.values()).sort((a, b) => b.today - a.today || a.name.localeCompare(b.name, 'zh-Hans-CN'))
})

const kindStats = computed<Record<WorkKind, number>>(() => {
  const result: Record<WorkKind, number> = { measure: 0, support: 0, review: 0 }
  scheduleStore.scheduledOrders.forEach((order) => {
    result[order.kind] += 1
  })
  return result
})

/** 有在途工单的古树（同株当天只允许一类作业，因此按计划日期聚合格式展示） */
const treeOrderRows = computed(() =>
  treeStore.trees
    .map((tree) => {
      const orders = scheduleStore.currentOrdersOfTree(tree.id).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))
      return { tree, orders }
    })
    .filter((row) => row.orders.length > 0 || treeFilter.value === 'all' || treeFilter.value === row.tree.id)
)

const filteredTreeRows = computed(() =>
  treeOrderRows.value.filter((row) => treeFilter.value === 'all' || treeFilter.value === row.tree.id)
)

onMounted(() => {
  void treeStore.loadAll()
  void scheduleStore.init()
})

function kindTagType(kind: WorkKind): 'success' | 'warning' | 'danger' {
  if (kind === 'measure') return 'success'
  if (kind === 'support') return 'warning'
  return 'danger'
}

function goSchedule(): void {
  void router.push(ROUTES.schedule)
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="待执行工单" :value="scheduleStore.scheduledOrders.length" suffix="张" tone="primary" icon="Tickets" />
      <StatBadge label="今日到场" :value="todayOrders.length" suffix="张" tone="success" icon="AlarmClock" />
      <StatBadge label="未来 7 天" :value="upcomingOrders.length" suffix="张" tone="warning" icon="DataLine" />
      <StatBadge label="复壮措施" :value="kindStats.measure" suffix="张" tone="success" icon="FirstAidKit" size="small" />
      <StatBadge label="加固件复查" :value="kindStats.support" suffix="张" tone="warning" icon="Coin" size="small" />
      <StatBadge label="衰弱复评" :value="kindStats.review" suffix="张" tone="danger" icon="Histogram" size="small" />
      <StatBadge label="累计完工" :value="scheduleStore.finishedOrders.length" suffix="张" tone="info" icon="PieChart" size="small" />
    </div>

    <el-alert
      v-if="scheduleStore.stagingOrders.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`排程台还有 ${scheduleStore.stagingOrders.length} 条未确认，其中 ${scheduleStore.stagingOrders.filter((o) => o.status === 'conflict').length} 条来源冲突`"
    >
      <template #default>
        <el-button type="primary" size="small" @click="goSchedule">前往排程台确认批次</el-button>
      </template>
    </el-alert>

    <el-row :gutter="14">
      <el-col :xs="24" :lg="14">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span class="card-header__title">每株古树的当前工单</span>
              <el-select v-model="treeFilter" size="small" filterable style="width: 220px">
                <el-option value="all" label="全部古树" />
                <el-option
                  v-for="tree in treeStore.trees"
                  :key="tree.id"
                  :value="tree.id"
                  :label="`${tree.code} ${tree.species}`"
                />
              </el-select>
            </div>
          </template>

          <el-table :data="filteredTreeRows" row-key="tree.id" stripe>
            <el-table-column label="古树 / 长势" min-width="200">
              <template #default="{ row }">
                <div class="cell-stack">
                  <span>{{ row.tree.code }} {{ row.tree.species }}（{{ row.tree.protectLevel }}）</span>
                  <VigorTag
                    :vigor="treeStore.statOf(row.tree.id).latestVigor"
                    :trend="treeStore.statOf(row.tree.id).latestTrend"
                    size="small"
                  />
                </div>
              </template>
            </el-table-column>
            <el-table-column label="当前工单" min-width="320">
              <template #default="{ row }">
                <div v-if="row.orders.length > 0" class="order-stack">
                  <div v-for="order in row.orders" :key="order.id" class="order-line">
                    <el-tag :type="kindTagType(order.kind)" size="small">{{ WORK_KIND_LABEL[order.kind as WorkKind] }}</el-tag>
                    <WorkOrderTag :order="order" :show-empty="false" />
                    <span class="order-operator">{{ order.operator }}</span>
                  </div>
                </div>
                <span v-else class="cell-sub">无在途工单</span>
              </template>
            </el-table-column>
            <template #empty>全部古树当前都没有在途工单</template>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="10">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span class="card-header__title">负责人今日负载（上限 {{ MAX_DAILY_PER_OPERATOR }} 件 / 人 / 天）</span>
            </div>
          </template>
          <el-table :data="operatorLoadRows" row-key="name" stripe size="small">
            <el-table-column prop="name" label="负责人" min-width="100" />
            <el-table-column label="今日" width="110" align="right">
              <template #default="{ row }">
                <el-tag :type="row.today >= MAX_DAILY_PER_OPERATOR ? 'danger' : row.today > 0 ? 'warning' : 'info'" size="small" effect="dark">
                  {{ row.today }} / {{ MAX_DAILY_PER_OPERATOR }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="待执行合计" width="110" align="right">
              <template #default="{ row }">{{ row.total }} 张</template>
            </el-table-column>
            <template #empty>暂无工单</template>
          </el-table>
        </el-card>

        <el-card shadow="never" class="mt-14">
          <template #header>
            <span class="card-header__title">今日 / 未来 7 天排期</span>
          </template>
          <el-timeline v-if="upcomingOrders.length > 0">
            <el-timeline-item
              v-for="order in upcomingOrders"
              :key="order.id"
              :timestamp="`${order.plannedDate} · ${WORK_KIND_LABEL[order.kind]} · ${order.operator}`"
              :type="order.plannedDate === todayStr ? 'success' : 'primary'"
              placement="top"
            >
              <div class="timeline-title">
                {{ treeLabel[order.treeId] ?? '（古树已删除）' }}
                <WorkOrderTag :order="order" :show-empty="false" />
              </div>
              <div class="timeline-detail">{{ order.snapshot.sourceKey }}</div>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-else description="未来 7 天没有排期" />
        </el-card>
      </el-col>
    </el-row>
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

.mt-14 {
  margin-top: 14px;
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

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.order-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.order-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.order-operator {
  font-size: 12px;
  color: #6b6257;
}

.timeline-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #2f2a24;
}

.timeline-detail {
  margin-top: 2px;
  font-size: 12px;
  color: #8c8479;
}
</style>
