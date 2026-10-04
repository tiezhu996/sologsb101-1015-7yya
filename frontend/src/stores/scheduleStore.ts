/**
 * 排程台状态管理（Pinia）
 * 统一维护排程台条目（draft / conflict）与正式工单（scheduled / done / cancelled）。
 * - 候选来源：未完成复壮措施、超期加固件、最新长势衰弱 / 濒危的复评
 * - 排序：保护级别 → 超期天数 → 复评风险
 * - 派单硬约束：一名负责人每天最多 3 件；同株古树当天至多 1 单
 * - 批次确认：重新读取来源记录比对指纹，并发改动的条目留台标冲突，其余生成工单号
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Measure } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type { WorkKind, WorkOrder } from '../types/workOrder'
import {
  ACTIVE_ORDER_STATUSES,
  CURRENT_ORDER_STATUSES,
  MAX_DAILY_PER_OPERATOR,
  WORK_KIND_LABEL,
} from '../types/workOrder'
import {
  bulkPutWorkOrders,
  db,
  initDatabase,
  nextWorkOrderCode,
  putMeasure,
  putWorkOrder,
  removeWorkOrder,
} from '../utils/db'
import { nowIso, today, uuid } from '../utils/id'
import {
  assignCandidates,
  buildFingerprint,
  buildScheduleCandidates,
  comparePriority,
  type ScheduleCandidate,
} from '../utils/schedule'
import { useTreeStore } from './treeStore'

/** 排程窗口（天）：自动派单在未来 30 天内寻找可行日期 */
export const SCHEDULE_HORIZON_DAYS = 30

/** 负责人候选名单（措施负责人会自动并入） */
const DEFAULT_OPERATORS = ['王建军', '李慧', '张勇', '赵鹏', '孙晓', '周敏']

export interface ConfirmResult {
  confirmed: number
  conflicts: number
  batchNo: string
}

export const useScheduleStore = defineStore('schedule', () => {
  const workorders = ref<WorkOrder[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const operators = ref<string[]>([...DEFAULT_OPERATORS])
  const startDate = ref<string>(today())
  const lastMessage = ref('')
  let subscribed = false

  const treeStore = useTreeStore()

  /* ------------------------------ 订阅 ------------------------------ */

  async function init(): Promise<void> {
    await initDatabase()
    if (!subscribed) {
      subscribed = true
      liveQuery(() => db.workorders.toArray()).subscribe({
        next: (rows) => {
          workorders.value = [...rows].sort(
            (a, b) =>
              a.plannedDate.localeCompare(b.plannedDate) ||
              a.snapshot.protectRank - b.snapshot.protectRank ||
              a.createdAt.localeCompare(b.createdAt)
          )
          ready.value = true
          loading.value = false
          error.value = ''
        },
        error: (err: unknown) => {
          error.value = err instanceof Error ? err.message : '订阅工单数据失败'
          loading.value = false
        },
      })
    }
  }

  /* ------------------------------ 派生数据 ------------------------------ */

  /** 排程台条目：待确认 + 来源冲突 */
  const stagingOrders = computed<WorkOrder[]>(() =>
    workorders.value
      .filter((order) => order.status === 'draft' || order.status === 'conflict')
      .sort((a, b) => comparePriority(fromOrder(a), fromOrder(b)))
  )

  /** 已生成、待执行的工单 */
  const scheduledOrders = computed<WorkOrder[]>(() =>
    workorders.value
      .filter((order) => order.status === 'scheduled')
      .sort((a, b) => a.plannedDate.localeCompare(b.plannedDate))
  )

  const finishedOrders = computed<WorkOrder[]>(() =>
    workorders.value.filter((order) => order.status === 'done')
  )

  /** 来源台账展示的「当前工单」：已生成且未完工 */
  const currentOrders = computed<WorkOrder[]>(() =>
    workorders.value.filter((order) => CURRENT_ORDER_STATUSES.includes(order.status))
  )

  /** 已在台 / 已有工单占用的来源键，避免同一来源重复入台 */
  const takenSourceKeys = computed<Set<string>>(() => {
    const set = new Set<string>()
    workorders.value.forEach((order) => {
      if (ACTIVE_ORDER_STATUSES.includes(order.status)) set.add(`${order.kind}:${order.sourceId}`)
    })
    return set
  })

  /** 当前可入台的候选（已排除占用中的来源） */
  const candidates = computed<ScheduleCandidate[]>(() =>
    buildScheduleCandidates({
      trees: treeStore.trees,
      measures: treeStore.measures,
      supports: treeStore.supports,
      reviews: treeStore.reviews,
      takenSourceKeys: takenSourceKeys.value,
    }).sort(comparePriority)
  )

  /** 负责人名单：默认名单 + 来源措施里出现过的负责人 */
  const operatorOptions = computed<string[]>(() => {
    const set = new Set<string>(operators.value)
    treeStore.measures.forEach((measure) => {
      if (measure.operator.trim() !== '') set.add(measure.operator.trim())
    })
    workorders.value.forEach((order) => {
      if (order.operator.trim() !== '') set.add(order.operator.trim())
    })
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  })

  function addOperator(name: string): void {
    const trimmed = name.trim()
    if (trimmed === '') return
    if (!operators.value.includes(trimmed)) operators.value = [...operators.value, trimmed]
  }

  /* ------------------------------ 占用与冲突 ------------------------------ */

  /** 实时检测排程台条目相对来源记录是否已过期（来源在入台后被改动） */
  function staleReason(order: WorkOrder): string {
    const found = findSource(order.kind, order.sourceId)
    if (found === undefined) return '来源记录已被删除'
    const tree = treeStore.trees.find((row) => row.id === order.treeId)
    if (!tree) return '古树档案已被删除'
    const fingerprint = buildFingerprint(order.kind, found, tree.protectLevel)
    if (fingerprint !== order.snapshot.fingerprint) {
      return '来源记录在入台后被修改，确认批次时将留台'
    }
    if (order.status === 'conflict' && order.conflictReason !== '') return order.conflictReason
    return ''
  }

  function findSource(kind: WorkKind, sourceId: string): Measure | Support | Review | undefined {
    if (kind === 'measure') return treeStore.measures.find((row) => row.id === sourceId)
    if (kind === 'support') return treeStore.supports.find((row) => row.id === sourceId)
    return treeStore.reviews.find((row) => row.id === sourceId)
  }

  const staleIds = computed<Set<string>>(() => {
    const set = new Set<string>()
    stagingOrders.value.forEach((order) => {
      if (staleReason(order) !== '') set.add(order.id)
    })
    return set
  })

  /* ------------------------------ 入台与排序 ------------------------------ */

  /** 把全部候选载入排程台（生成 draft 行，尚未派工） */
  async function loadCandidates(): Promise<number> {
    await init()
    const list = candidates.value
    if (list.length === 0) {
      lastMessage.value = '没有待排期的候选作业'
      return 0
    }
    const stamp = nowIso()
    const rows: WorkOrder[] = list.map((candidate) => ({
      id: uuid('order'),
      code: '',
      kind: candidate.kind,
      treeId: candidate.treeId,
      sourceId: candidate.sourceId,
      snapshot: { ...candidate.snapshot },
      operator: candidate.preferredOperator,
      plannedDate: startDate.value,
      status: 'draft',
      conflictReason: '',
      batchNo: '',
      note: '',
      confirmedAt: '',
      finishedAt: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    }))
    await bulkPutWorkOrders(rows)
    lastMessage.value = `已载入 ${rows.length} 条候选到排程台，请执行自动排序`
    return rows.length
  }

  /**
   * 自动排序：按优先级贪心派工，覆盖所有 draft / conflict 条目。
   * conflict 条目会先重新抓取来源快照；来源已不再满足条件的条目保留原因并跳过。
   * 直接读取数据库权威数据，避免 liveQuery 回灌延迟读到旧集合。
   */
  async function autoSort(): Promise<{ sorted: number; obsolete: number }> {
    await init()
    const [dbOrders, trees, measures, supports, reviews] = await Promise.all([
      db.workorders.toArray(),
      db.trees.toArray(),
      db.measures.toArray(),
      db.supports.toArray(),
      db.reviews.toArray(),
    ])
    const staging = dbOrders.filter((order) => order.status === 'draft' || order.status === 'conflict')
    const scheduled = dbOrders.filter((order) => order.status === 'scheduled')

    const { load, treeDay } = occupancyOf(scheduled)

    const freshCandidates = buildScheduleCandidates({
      trees,
      measures,
      supports,
      reviews,
      takenSourceKeys: new Set(
        // 仅排除不在本次重排范围内的占用（scheduled）；staging 自身要允许刷新
        scheduled.map((order) => `${order.kind}:${order.sourceId}`)
      ),
    })
    const candidateMap = new Map(freshCandidates.map((candidate) => [`${candidate.kind}:${candidate.sourceId}`, candidate]))

    const refreshed: WorkOrder[] = []
    const sortable: Array<ScheduleCandidate & { orderId: string }> = []
    let obsolete = 0

    staging.forEach((order) => {
      const candidate = candidateMap.get(`${order.kind}:${order.sourceId}`)
      if (candidate === undefined) {
        // 来源已不满足排期条件（已完工 / 已检查 / 长势恢复等）或被删除
        obsolete += 1
        if (order.status !== 'conflict') {
          refreshed.push({
            ...order,
            status: 'conflict',
            conflictReason:
              staleReasonFromDb(order, { trees, measures, supports, reviews }) || '来源已不满足排期条件',
          })
        }
        return
      }
      refreshed.push({
        ...order,
        status: 'draft',
        conflictReason: '',
        snapshot: { ...candidate.snapshot },
      })
      sortable.push({ ...candidate, orderId: order.id })
    })

    sortable.sort((a, b) => comparePriority(a, b))
    const draftOperatorMap = new Map(staging.map((order) => [order.id, order.operator]))
    const assignments = assignCandidates({
      candidates: sortable.map((item) => ({
        key: item.orderId,
        treeId: item.treeId,
        preferredOperator: item.preferredOperator || draftOperatorMap.get(item.orderId) || '',
      })),
      operators: operatorOptions.value,
      startDate: startDate.value,
      horizonDays: SCHEDULE_HORIZON_DAYS,
      operatorLoad: load,
      treeDayUsed: treeDay,
    })
    const assignedMap = new Map(assignments.map((item) => [item.key, item]))

    const updated: WorkOrder[] = refreshed.map((order) => {
      const assigned = assignedMap.get(order.id)
      if (!assigned) return order
      return { ...order, operator: assigned.operator, plannedDate: assigned.plannedDate }
    })

    await bulkPutWorkOrders(updated)
    const sorted = assignments.length
    lastMessage.value = `已按「保护级别 → 超期天数 → 复评风险」重排 ${sorted} 条，负责人每日不超过 ${MAX_DAILY_PER_OPERATOR} 件`
    return { sorted, obsolete }
  }

  /** 手工调整某条目的负责人 / 日期，落库前做硬约束校验（排除自身） */
  async function updateDraft(orderId: string, patch: { operator?: string; plannedDate?: string; note?: string }): Promise<string | null> {
    const order = await db.workorders.get(orderId)
    if (!order || (order.status !== 'draft' && order.status !== 'conflict')) return '该条目已不在排程台'
    const operator = patch.operator ?? order.operator
    const plannedDate = patch.plannedDate ?? order.plannedDate
    const [dbOrders] = await Promise.all([db.workorders.toArray()])
    const { load, treeDay } = occupancyOf(
      dbOrders.filter((row) => row.status === 'scheduled' || row.status === 'draft' || row.status === 'conflict')
    )
    // 排除自身占用后再校验
    load.get(order.operator)?.set(order.plannedDate, Math.max(0, (load.get(order.operator)?.get(order.plannedDate) ?? 1) - 1))
    treeDay.delete(`${order.treeId}@${order.plannedDate}`)
    const operatorCount = load.get(operator)?.get(plannedDate) ?? 0
    if (operatorCount >= MAX_DAILY_PER_OPERATOR) {
      return `负责人「${operator}」在 ${plannedDate} 已排满 ${MAX_DAILY_PER_OPERATOR} 件`
    }
    if (treeDay.has(`${order.treeId}@${plannedDate}`)) {
      return `该古树在 ${plannedDate} 已安排现场作业，同株古树当天只能安排一类作业`
    }
    await putWorkOrder({ ...order, ...patch, operator, plannedDate })
    return null
  }

  /** 把冲突 / 过期条目的快照刷新为来源最新值（保留派工，解除过期标记需再做一次自动排序） */
  async function refreshStale(orderId: string): Promise<void> {
    const order = await db.workorders.get(orderId)
    if (!order) return
    const [trees, measures, supports, reviews] = await Promise.all([
      db.trees.toArray(),
      db.measures.toArray(),
      db.supports.toArray(),
      db.reviews.toArray(),
    ])
    const candidate = buildScheduleCandidates({
      trees,
      measures,
      supports,
      reviews,
      takenSourceKeys: new Set(),
    }).find((item) => item.key === `${order.kind}:${order.sourceId}`)
    if (candidate === undefined) {
      lastMessage.value = '来源已不满足排期条件，请移出排程台或等待数据恢复'
      return
    }
    await putWorkOrder({
      ...order,
      snapshot: { ...candidate.snapshot },
      status: 'draft',
      conflictReason: '',
    })
  }

  async function removeStaging(orderId: string): Promise<void> {
    const order = await db.workorders.get(orderId)
    if (!order) return
    if (order.status !== 'draft' && order.status !== 'conflict') return
    await removeWorkOrder(orderId)
    lastMessage.value = '已从排程台移除'
  }

  function setStartDate(date: string): void {
    startDate.value = date
  }

  /* ------------------------------ 批次确认 ------------------------------ */

  /**
   * 批次确认：逐条重新读取来源记录并比对指纹。
   * - 来源被删除 / 关键字段变化 / 古树保护级别变化 → 留台标 conflict
   * - 派工约束（负责人日 ≤ 3、同株同日 ≤ 1）按优先级逐条模拟放置，放不下的留台
   * - 通过的条目按顺序生成工单号 GD-YYYYMMDD-NNN
   */
  async function confirmBatch(): Promise<ConfirmResult> {
    await init()
    const batchNo = makeBatchNo()
    const stamp = nowIso()

    // 直接从数据库读取权威数据：批次确认期间来源记录的任何修改都以库中现状为准
    const [dbOrders, trees, measures, supports, reviews] = await Promise.all([
      db.workorders.toArray(),
      db.trees.toArray(),
      db.measures.toArray(),
      db.supports.toArray(),
      db.reviews.toArray(),
    ])
    const ordered = dbOrders
      .filter((order) => order.status === 'draft' || order.status === 'conflict')
      .sort((a, b) => comparePriority(fromOrder(a), fromOrder(b)))
    const scheduled = dbOrders.filter((order) => order.status === 'scheduled')
    const { load, treeDay } = occupancyOf(scheduled)

    const treeMap = new Map(trees.map((tree) => [tree.id, tree]))
    const measureMap = new Map(measures.map((row) => [row.id, row]))
    const supportMap = new Map(supports.map((row) => [row.id, row]))
    const reviewMap = new Map(reviews.map((row) => [row.id, row]))

    const toConfirm: WorkOrder[] = []
    const toConflict: WorkOrder[] = []
    let seq = await db.workorders.where('code').startsWith(`GD-${today().replace(/-/g, '')}-`).count()
    const dayCompact = today().replace(/-/g, '')

    for (const order of ordered) {
      const source =
        order.kind === 'measure'
          ? measureMap.get(order.sourceId)
          : order.kind === 'support'
            ? supportMap.get(order.sourceId)
            : reviewMap.get(order.sourceId)
      const tree = treeMap.get(order.treeId)
      let reason = ''
      if (!source) reason = '来源记录已被删除'
      else if (!tree) reason = '古树档案已被删除'
      else if (buildFingerprint(order.kind, source, tree.protectLevel) !== order.snapshot.fingerprint) {
        reason = '批次确认期间来源记录被修改，请核对后重新排序'
      } else {
        const operatorCount = load.get(order.operator)?.get(order.plannedDate) ?? 0
        if (operatorCount >= MAX_DAILY_PER_OPERATOR) {
          reason = `负责人「${order.operator}」${order.plannedDate} 已达每日 ${MAX_DAILY_PER_OPERATOR} 件上限`
        } else if (treeDay.has(`${order.treeId}@${order.plannedDate}`)) {
          reason = `同株古树 ${order.plannedDate} 已安排另一类现场作业`
        }
      }

      if (reason !== '') {
        toConflict.push({ ...order, status: 'conflict', conflictReason: reason })
        continue
      }

      seq += 1
      if (!load.has(order.operator)) load.set(order.operator, new Map<string, number>())
      const perDate = load.get(order.operator)!
      perDate.set(order.plannedDate, (perDate.get(order.plannedDate) ?? 0) + 1)
      treeDay.add(`${order.treeId}@${order.plannedDate}`)
      toConfirm.push({
        ...order,
        status: 'scheduled',
        conflictReason: '',
        code: `GD-${dayCompact}-${String(seq).padStart(3, '0')}`,
        batchNo,
        confirmedAt: stamp,
      })
    }

    await bulkPutWorkOrders([...toConflict, ...toConfirm])
    lastMessage.value =
      toConfirm.length > 0
        ? `批次 ${batchNo}：已生成 ${toConfirm.length} 张工单${toConflict.length > 0 ? `，${toConflict.length} 条冲突留台` : ''}`
        : `本批次没有可确认条目，${toConflict.length} 条全部留台`
    return { confirmed: toConfirm.length, conflicts: toConflict.length, batchNo }
  }

  /* ------------------------------ 工单流转 ------------------------------ */

  /** 完工登记：加固件复查同步登记本次检查；复壮措施可勾选同步标记「已完成」 */
  async function finishOrder(orderId: string, options: { syncMeasure?: boolean } = {}): Promise<void> {
    const order = await db.workorders.get(orderId)
    if (!order || order.status !== 'scheduled') return
    await db.transaction('rw', [db.workorders, db.measures, db.supports, db.trees], async () => {
      await db.workorders.update(orderId, { status: 'done', finishedAt: nowIso(), updatedAt: nowIso() })
      if (order.kind === 'support') {
        const support = await db.supports.get(order.sourceId)
        if (support && support.lastCheckDate < order.plannedDate) {
          await db.supports.update(support.id, { lastCheckDate: order.plannedDate, updatedAt: nowIso() })
        }
      }
      if (order.kind === 'measure' && options.syncMeasure) {
        const measure = await db.measures.get(order.sourceId)
        if (measure && measure.state !== '已完成') {
          await putMeasure({ ...measure, state: '已完成', date: measure.date >= order.plannedDate ? measure.date : order.plannedDate })
        }
      }
    })
    lastMessage.value = `工单 ${order.code || WORK_KIND_LABEL[order.kind]} 已完工`
  }

  async function cancelOrder(orderId: string): Promise<void> {
    const order = await db.workorders.get(orderId)
    if (!order || order.status !== 'scheduled') return
    await putWorkOrder({ ...order, status: 'cancelled', conflictReason: '' })
    lastMessage.value = `工单 ${order.code} 已取消，来源作业可重新进入排程台`
  }

  /** 查询某条来源记录的当前工单 */
  function currentOrderOf(kind: WorkKind, sourceId: string): WorkOrder | undefined {
    return currentOrders.value.find((order) => order.kind === kind && order.sourceId === sourceId)
  }

  /** 某株古树当前未完工工单 */
  function currentOrdersOfTree(treeId: string): WorkOrder[] {
    return currentOrders.value.filter((order) => order.treeId === treeId)
  }

  return {
    workorders,
    loading,
    ready,
    error,
    startDate,
    lastMessage,
    init,
    stagingOrders,
    scheduledOrders,
    finishedOrders,
    currentOrders,
    candidates,
    operatorOptions,
    staleIds,
    staleReason,
    findSource,
    addOperator,
    loadCandidates,
    autoSort,
    updateDraft,
    refreshStale,
    removeStaging,
    setStartDate,
    confirmBatch,
    finishOrder,
    cancelOrder,
    currentOrderOf,
    currentOrdersOfTree,
    nextCode: nextWorkOrderCode,
  }
})

/** WorkOrder 还原成可参与优先级比较的最小结构 */
function fromOrder(order: WorkOrder): ScheduleCandidate {
  return {
    key: order.id,
    kind: order.kind,
    treeId: order.treeId,
    sourceId: order.sourceId,
    preferredOperator: order.operator,
    snapshot: order.snapshot,
  }
}

/** 已生成工单对排期资源的占用：operator -> date -> 件数；`treeId@date` 集合 */
function occupancyOf(orders: WorkOrder[]): {
  load: Map<string, Map<string, number>>
  treeDay: Set<string>
} {
  const load = new Map<string, Map<string, number>>()
  const treeDay = new Set<string>()
  orders.forEach((order) => {
    if (!load.has(order.operator)) load.set(order.operator, new Map<string, number>())
    const perDate = load.get(order.operator)!
    perDate.set(order.plannedDate, (perDate.get(order.plannedDate) ?? 0) + 1)
    treeDay.add(`${order.treeId}@${order.plannedDate}`)
  })
  return { load, treeDay }
}

interface SourceTables {
  trees: import('../types/tree').Tree[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
}

/** 直接基于数据库快照判断条目过期原因（自动排序把失效条目留台时使用） */
function staleReasonFromDb(order: WorkOrder, tables: SourceTables): string {
  const source =
    order.kind === 'measure'
      ? tables.measures.find((row) => row.id === order.sourceId)
      : order.kind === 'support'
        ? tables.supports.find((row) => row.id === order.sourceId)
        : tables.reviews.find((row) => row.id === order.sourceId)
  if (!source) return '来源记录已被删除'
  const tree = tables.trees.find((row) => row.id === order.treeId)
  if (!tree) return '古树档案已被删除'
  if (buildFingerprint(order.kind, source, tree.protectLevel) !== order.snapshot.fingerprint) {
    return '来源记录在入台后被修改，确认批次时将留台'
  }
  return ''
}

/** 批次号：B-YYYYMMDD-HHMM */
function makeBatchNo(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `B-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}
