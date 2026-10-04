/**
 * 养护排程状态管理（Pinia）
 * 维护排程台条目与现场工单：
 * - 从三类来源台账（复壮措施 / 加固件复查 / 衰弱复评）收集待办；
 * - 按「保护级别 → 超期天数 → 复评风险」排序后贪心排期，
 *   满足「负责人每天最多 3 件」「同株古树当天只安排一类现场作业」；
 * - 批次确认时重新比对来源指纹，确认期间被修改 / 删除 / 失效的条目留在排程台
 *   标记为冲突，其余生成工单；
 * - 工单完成时回写来源台账（加固件检查日期 / 措施完成状态）。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { ScheduleItem, WorkOrder, WorkOrderState } from '../types/schedule'
import { JOB_KIND_LABEL } from '../types/schedule'
import {
  ROW_REVISION,
  bulkPutScheduleItems,
  countWorkOrdersByDate,
  db,
  initDatabase,
  markSupportChecked,
  putMeasure,
  putWorkOrder,
  removeScheduleItem,
  removeWorkOrder,
} from '../utils/db'
import { nowIso, today, uuid } from '../utils/id'
import {
  autoSchedule,
  buildCandidates,
  checkItemConflict,
  measureEligible,
  refreshItemSnapshot,
  sourceFingerprint,
  type ScheduleSourceContext,
} from '../utils/schedule'
import { useTreeStore } from './treeStore'

/** 批次确认结果摘要 */
export interface ConfirmResult {
  created: number
  conflicts: number
}

let subscribed = false

export const useScheduleStore = defineStore('schedule', () => {
  const items = ref<ScheduleItem[]>([])
  const orders = ref<WorkOrder[]>([])
  const loading = ref(true)
  const ready = ref(false)
  /** 排期起始日期（默认今天，可在排程台调整） */
  const startDate = ref<string>(today())
  const lastMessage = ref('')

  const pendingItems = computed<ScheduleItem[]>(() => items.value.filter((item) => item.state === 'pending'))
  const scheduledItems = computed<ScheduleItem[]>(() => items.value.filter((item) => item.state === 'scheduled'))
  const conflictItems = computed<ScheduleItem[]>(() => items.value.filter((item) => item.state === 'conflict'))

  /** 仍占排期容量、需要在台账提示的工单 */
  const activeOrders = computed<WorkOrder[]>(() =>
    orders.value.filter((order) => order.state === '待执行' || order.state === '执行中')
  )

  /** 尚未指派负责人的条目（排期前必须补录） */
  const unassignedItems = computed<ScheduleItem[]>(() =>
    items.value.filter((item) => item.state !== 'conflict' && item.operator.trim() === '')
  )

  /** 可用于指派的负责人候选：来源措施负责人 + 工单负责人 */
  const operatorOptions = computed<string[]>(() => {
    const treeStore = useTreeStore()
    const set = new Set<string>()
    treeStore.measures.forEach((row) => {
      if (row.operator.trim() !== '') set.add(row.operator.trim())
    })
    orders.value.forEach((order) => {
      if (order.operator.trim() !== '') set.add(order.operator.trim())
    })
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  })

  /** 还能从来源台账新收集的待办数量（排除已在排程台与已有激活工单的来源） */
  const uncollectedCount = computed<number>(() => {
    const treeStore = useTreeStore()
    if (!treeStore.ready) return 0
    const candidates = buildCandidates(sourceContext(), {
      existing: items.value,
      activeOrders: activeOrders.value,
    })
    return candidates.length
  })

  function sourceContext(): ScheduleSourceContext {
    const treeStore = useTreeStore()
    return {
      trees: treeStore.trees,
      measures: treeStore.measures,
      supports: treeStore.supports,
      reviews: treeStore.reviews,
    }
  }

  async function init(): Promise<void> {
    await initDatabase()
    if (!subscribed) {
      subscribed = true
      liveQuery(async () => {
        const [itemRows, orderRows] = await Promise.all([db.scheduleItems.toArray(), db.workOrders.toArray()])
        return { itemRows, orderRows }
      }).subscribe({
        next: ({ itemRows, orderRows }) => {
          items.value = [...itemRows].sort(
            (a, b) => b.priorityScore - a.priorityScore || a.rankOrder - b.rankOrder
          )
          orders.value = [...orderRows].sort(
            (a, b) =>
              a.date.localeCompare(b.date) || b.priorityScore - a.priorityScore || a.code.localeCompare(b.code)
          )
          loading.value = false
          ready.value = true
        },
        error: () => {
          loading.value = false
        },
      })
    }
  }

  /** 收集来源台账中的待办进入排程台（已收集 / 已有激活工单的来源自动跳过） */
  async function collectPending(): Promise<number> {
    const rankStart = items.value.reduce((max, item) => Math.max(max, item.rankOrder + 1), 0)
    const candidates = buildCandidates(sourceContext(), {
      existing: items.value,
      activeOrders: activeOrders.value,
      rankStart,
    })
    if (candidates.length === 0) {
      lastMessage.value = '来源台账暂无新的待办作业'
      return 0
    }
    const stamp = nowIso()
    const rows: ScheduleItem[] = candidates.map((candidate) => ({
      ...candidate,
      id: uuid('sched'),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }))
    await bulkPutScheduleItems(rows)
    lastMessage.value = `已收集 ${rows.length} 项待办到排程台：复壮措施 / 加固件复查 / 衰弱复评`
    return rows.length
  }

  /** 指派 / 修改负责人（支持批量） */
  async function assignOperator(ids: string[], operator: string): Promise<void> {
    const target = new Set(ids)
    const rows = items.value
      .filter((item) => target.has(item.id) && item.state !== 'conflict')
      .map((item) => ({ ...item, operator: operator.trim() }))
    await bulkPutScheduleItems(rows)
    lastMessage.value = `已为 ${rows.length} 项作业指派负责人「${operator.trim()}」`
  }

  /** 单条更新负责人（行内编辑） */
  async function updateOperator(id: string, operator: string): Promise<void> {
    const item = items.value.find((row) => row.id === id)
    if (item === undefined || item.state === 'conflict') return
    await bulkPutScheduleItems([{ ...item, operator: operator.trim() }])
  }

  function setStartDate(date: string): void {
    startDate.value = date
  }

  /**
   * 按优先级排序并自动排期：
   * - 待排序与冲突留台条目先重新核对来源（来源删除 / 失效仍为冲突，被改过的条目按最新来源重排）；
   * - 其余条目按优先级贪心放入第一个可安排日，
   *   同时避让已生成的激活工单与本批次已排期条目（负责人 ≤3 件/日、同株当日仅一类）。
   */
  async function rankAndSchedule(): Promise<{ scheduled: number; conflicts: number }> {
    if (startDate.value === '') {
      lastMessage.value = '请先选择排期起始日期'
      return { scheduled: 0, conflicts: 0 }
    }
    const ctx = sourceContext()
    const reference = today()

    // 1) 重新核对 pending / conflict 条目
    const revalidated: ScheduleItem[] = []
    const stillConflicted: ScheduleItem[] = []

    const waiting = items.value.filter((item) => item.state === 'pending' || item.state === 'conflict')
    for (const item of waiting) {
      const check = checkItemConflict(item, ctx, reference)
      if (check.conflict) {
        stillConflicted.push({ ...item, state: 'conflict', conflictReason: check.reason, plannedDate: '' })
        continue
      }
      // 来源在收集后被改过：重新排序时接受最新来源数据并重录指纹；
      // 负责人以排程台上的指派为准（用户可能已手工改派），仅补空。
      const refreshed = refreshItemSnapshot(item, ctx, reference)
      const currentFingerprint = currentSourceFingerprint(item, ctx)
      revalidated.push({
        ...refreshed,
        fingerprint: currentFingerprint ?? item.fingerprint,
        operator: item.operator || (item.kind === 'measure' ? currentMeasureOperator(item.sourceId, ctx) : ''),
        state: 'pending',
        conflictReason: '',
        plannedDate: '',
      })
    }

    // 2) 未指派负责人的条目不能排期，留在待排序
    const assignable = revalidated.filter((item) => item.operator.trim() !== '')
    const unassigned = revalidated.filter((item) => item.operator.trim() === '')

    // 3) 已排期条目保留原计划日期作为占位，与激活工单共同约束本次排期
    const alreadyScheduled = items.value.filter((item) => item.state === 'scheduled')
    const ordered = [...assignable].sort(
      (a, b) => b.priorityScore - a.priorityScore || a.rankOrder - b.rankOrder
    )
    const occupancyOrders = [
      ...activeOrders.value,
      ...alreadyScheduled.map((item) => ({
        kind: item.kind,
        date: item.plannedDate,
        operator: item.operator,
        treeId: item.treeId,
        state: '待执行' as WorkOrderState,
      })),
    ]
    const plan = autoSchedule(
      ordered.map((item) => ({ id: item.id, kind: item.kind, treeId: item.treeId, operator: item.operator })),
      startDate.value,
      occupancyOrders
    )

    const stamp = nowIso()
    const nowScheduled: ScheduleItem[] = ordered
      .filter((item) => plan.has(item.id))
      .map((item) => ({
        ...item,
        state: 'scheduled' as const,
        plannedDate: plan.get(item.id) ?? '',
        scheduledAt: stamp,
      }))
    const noSlot = ordered
      .filter((item) => !plan.has(item.id))
      .map((item) => ({ ...item, state: 'pending' as const }))

    // 已排期条目未参与本次重算，不重写；仅落库本次处理的条目
    await bulkPutScheduleItems([
      ...nowScheduled,
      ...noSlot,
      ...unassigned.map((item) => ({ ...item, state: 'pending' as const })),
      ...stillConflicted,
    ])

    const conflictCount = stillConflicted.length
    if (unassigned.length > 0) {
      lastMessage.value = `${unassigned.length} 项作业尚未指派负责人，已留在待排序`
    } else if (conflictCount > 0) {
      lastMessage.value = `已排期 ${nowScheduled.length} 项，${conflictCount} 项冲突留台等待重新排序`
    } else {
      lastMessage.value = `已按优先级完成 ${nowScheduled.length} 项作业排期，可进行批次确认`
    }
    return { scheduled: nowScheduled.length, conflicts: conflictCount }
  }

  function currentSourceFingerprint(item: ScheduleItem, ctx: ScheduleSourceContext): string | null {
    if (item.kind === 'measure') {
      const row = ctx.measures.find((m) => m.id === item.sourceId)
      return row === undefined ? null : sourceFingerprint('measure', row)
    }
    if (item.kind === 'support') {
      const row = ctx.supports.find((s) => s.id === item.sourceId)
      return row === undefined ? null : sourceFingerprint('support', row)
    }
    const row = ctx.reviews.find((r) => r.id === item.sourceId)
    return row === undefined ? null : sourceFingerprint('review', row)
  }

  function currentMeasureOperator(sourceId: string, ctx: ScheduleSourceContext): string {
    return ctx.measures.find((m) => m.id === sourceId)?.operator ?? ''
  }

  /**
   * 批次确认：逐条复核来源指纹。
   * 确认期间来源被修改 / 删除 / 失效的条目留在排程台（冲突），其余条目生成工单。
   */
  async function confirmBatch(): Promise<ConfirmResult> {
    const ctx = sourceContext()
    const reference = today()
    const toConfirm = items.value.filter((item) => item.state === 'scheduled')
    if (toConfirm.length === 0) {
      lastMessage.value = '没有已排期待确认的作业'
      return { created: 0, conflicts: 0 }
    }

    const conflicts: ScheduleItem[] = []
    const valid: ScheduleItem[] = []
    for (const item of toConfirm) {
      const check = checkItemConflict(item, ctx, reference)
      if (check.conflict) {
        conflicts.push({ ...item, state: 'conflict', conflictReason: check.reason, plannedDate: '' })
      } else {
        valid.push(item)
      }
    }

    if (valid.length > 0) {
      // 工单编号按计划日流水号递增（同批次内多张同日工单也要累计）
      const seqCache = new Map<string, number>()
      const stamp = nowIso()
      const newOrders: WorkOrder[] = []
      for (const item of [...valid].sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))) {
        const compact = item.plannedDate.replace(/-/g, '')
        const used = seqCache.get(item.plannedDate)
        const base = used ?? (await countWorkOrdersByDate(item.plannedDate))
        const seq = base + 1
        seqCache.set(item.plannedDate, seq)
        newOrders.push({
          id: uuid('order'),
          code: `WO${compact}-${String(seq).padStart(2, '0')}`,
          scheduleItemId: item.id,
          kind: item.kind,
          sourceId: item.sourceId,
          treeId: item.treeId,
          title: item.title,
          date: item.plannedDate,
          operator: item.operator,
          state: '待执行',
          priorityScore: item.priorityScore,
          generatedAt: stamp,
          closedAt: '',
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        })
      }
      await db.transaction('rw', db.workOrders, db.scheduleItems, async () => {
        await db.workOrders.bulkPut(newOrders)
        await db.scheduleItems.bulkDelete(valid.map((item) => item.id))
      })
    }
    if (conflicts.length > 0) {
      await bulkPutScheduleItems(conflicts)
    }

    lastMessage.value =
      conflicts.length > 0
        ? `已生成 ${valid.length} 张工单；${conflicts.length} 项因确认期间来源变动留在排程台，请重新排序`
        : `已生成 ${valid.length} 张工单，可到来源台账与养护总览查看`
    return { created: valid.length, conflicts: conflicts.length }
  }

  /** 移下排程台（放弃收集） */
  async function discardItem(id: string): Promise<void> {
    await removeScheduleItem(id)
    lastMessage.value = '条目已移下排程台，来源台账记录不受影响'
  }

  /** 工单推进：待执行 → 执行中 */
  async function advanceOrder(order: WorkOrder): Promise<void> {
    if (order.state !== '待执行') return
    await putWorkOrder({ ...order, state: '执行中' })
    lastMessage.value = `工单 ${order.code} 已开始执行`
  }

  /**
   * 完成工单并回写来源台账：
   * - 加固件复查：把最近检查日期登记为工单计划日；
   * - 复壮措施：措施状态改为「已完成」，并回写古树最近复壮日期；
   * - 衰弱复评：仅关闭工单，新复评结论仍在复评页登记。
   */
  async function completeOrder(order: WorkOrder): Promise<void> {
    if (order.state === '已完成' || order.state === '已取消') return
    const stamp = nowIso()
    if (order.kind === 'support') {
      await markSupportChecked(order.sourceId, order.date)
    } else if (order.kind === 'measure') {
      const measure = await db.measures.get(order.sourceId)
      if (measure !== undefined && measureEligible(measure)) {
        await putMeasure({ ...measure, state: '已完成' })
      }
    }
    // review：现场复评完成后由养护人员在「长势复评」页登记新结论，此处只关单
    await putWorkOrder({ ...order, state: '已完成', closedAt: stamp })
    lastMessage.value = `工单 ${order.code} 已完成${
      order.kind === 'support'
        ? `，加固件最近检查日期已回写为 ${order.date}`
        : order.kind === 'measure'
          ? '，措施状态已回写为「已完成」'
          : `（${JOB_KIND_LABEL[order.kind]}请在复评页补录最新结论）`
    }`
  }

  /** 取消工单（释放当日排期容量；来源台账不变） */
  async function cancelOrder(order: WorkOrder): Promise<void> {
    if (order.state === '已完成' || order.state === '已取消') return
    await putWorkOrder({ ...order, state: '已取消', closedAt: nowIso() })
    lastMessage.value = `工单 ${order.code} 已取消`
  }

  async function deleteOrder(id: string): Promise<void> {
    await removeWorkOrder(id)
  }

  /** 查询某株古树的当前工单 */
  function activeOrdersOfTree(treeId: string): WorkOrder[] {
    return activeOrders.value.filter((order) => order.treeId === treeId)
  }

  /** 查询某条来源记录的当前工单 */
  function activeOrderOfSource(kind: WorkOrder['kind'], sourceId: string): WorkOrder | undefined {
    return activeOrders.value.find((order) => order.kind === kind && order.sourceId === sourceId)
  }

  return {
    items,
    orders,
    loading,
    ready,
    startDate,
    lastMessage,
    pendingItems,
    scheduledItems,
    conflictItems,
    activeOrders,
    unassignedItems,
    operatorOptions,
    uncollectedCount,
    init,
    collectPending,
    assignOperator,
    updateOperator,
    setStartDate,
    rankAndSchedule,
    confirmBatch,
    discardItem,
    advanceOrder,
    completeOrder,
    cancelOrder,
    deleteOrder,
    activeOrdersOfTree,
    activeOrderOfSource,
  }
})
