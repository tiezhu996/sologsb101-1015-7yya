/**
 * 养护排程核心算法（纯函数，便于单测与复用）
 * - 从来源台账（措施 / 加固件 / 复评）收集待办候选并计算优先级；
 * - 按优先级排序后贪心排期，满足两条硬约束：
 *   1. 同一名负责人每天最多承接 3 件；
 *   2. 同一株古树当天只安排一类现场作业。
 * - 批次确认前重新计算来源指纹，识别确认期间被并发修改 / 删除 / 失效的冲突项。
 */
import type { Tree } from '../types/tree'
import type { Measure } from '../types/measure'
import type { Support } from '../types/support'
import type { Review, Vigor } from '../types/review'
import type {
  JobKind,
  NewScheduleItem,
  ReviewRiskLevel,
  ScheduleItem,
  WorkOrder,
} from '../types/schedule'
import { VIGOR_NEED_FOLLOW_UP } from '../types/review'
import { WORK_ORDER_ACTIVE_STATES } from '../types/schedule'
import { addMonths, daysBetween, overdueDays } from './dimension'
import { today } from './id'

/** 负责人单日最大承接件数 */
export const DAILY_ASSIGN_LIMIT = 3

/** 复评周期：濒危 30 天、衰弱 60 天；其他长势不纳入强制复评待办 */
export const REVIEW_CYCLE_DAYS: Partial<Record<Vigor, number>> = {
  濒危: 30,
  衰弱: 60,
}

/** 保护级别分值：级别越高越优先 */
export const PROTECT_LEVEL_SCORE: Record<Tree['protectLevel'], number> = {
  一级: 3000,
  二级: 2000,
  三级: 1000,
}

/** 复评风险分：濒危 3、衰弱 2、一般 1、旺盛 0 */
export const REVIEW_RISK_SCORE: Record<Vigor, number> = {
  濒危: 3,
  一般: 1,
  旺盛: 0,
  衰弱: 2,
}

/** 来源数据快照（用于构建候选与指纹比对） */
export interface ScheduleSourceContext {
  trees: Tree[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
}

/* ------------------------------ 日期工具 ------------------------------ */

/** 返回 date 之后第 n 天（n ≥ 0）的 YYYY-MM-DD */
export function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00`)
  base.setDate(base.getDate() + days)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`
}

/* ------------------------------ 复评风险 ------------------------------ */

/** 取一株古树最新一条长势复评 */
export function latestReviewOf(reviews: Review[], treeId: string): Review | null {
  const list = reviews.filter((row) => row.treeId === treeId).sort((a, b) => a.date.localeCompare(b.date))
  return list.length > 0 ? list[list.length - 1] : null
}

/** 复评风险档（无复评记录时按「一般」处理，保证仍可被排序） */
export function reviewRiskLevel(vigor: Vigor | null): ReviewRiskLevel {
  if (vigor === '濒危') return 'high'
  if (vigor === '衰弱') return 'watch'
  if (vigor === '旺盛') return 'low'
  return 'normal'
}

export const REVIEW_RISK_LABEL: Record<ReviewRiskLevel, string> = {
  high: '高（濒危）',
  watch: '较高（衰弱）',
  normal: '较低（一般）',
  low: '低（旺盛）',
}

/* ------------------------------ 来源指纹 ------------------------------ */

/**
 * 来源记录指纹：把与排期相关的字段拼接成短摘要。
 * 批次确认时重算并与收集时的指纹比对，即可发现确认期间的并发修改。
 */
export function sourceFingerprint(kind: JobKind, source: Measure | Support | Review | undefined): string {
  if (source === undefined) return ''
  if (kind === 'measure') {
    const row = source as Measure

    return `m:${row.treeId}|${row.type}|${row.date}|${row.state}|${row.operator}|${row.updatedAt}`
  }
  if (kind === 'support') {
    const row = source as Support
    return `s:${row.treeId}|${row.type}|${row.checkCycleMon}|${row.lastCheckDate}|${row.updatedAt}`
  }
  const row = source as Review
  return `r:${row.treeId}|${row.date}|${row.vigor}|${row.trend}|${row.updatedAt}`
}

/* ------------------------------ 候选判定 ------------------------------ */

/** 措施是否仍需排程：未完成且计划实施日期不晚于基准日（已逾期或今日到期） */
export function measureEligible(row: Measure, reference = today()): boolean {
  return row.state !== '已完成' && row.date <= reference
}

/** 措施超期天数（计划日期与基准日之差） */
export function measureOverdueDays(row: Measure, reference = today()): number {
  if (!measureEligible(row, reference)) return 0
  return Math.max(0, daysBetween(row.date, reference))
}

/** 加固件是否仍需复查：超周期未检查 */
export function supportEligible(row: Support, reference = today()): boolean {
  const next = row.lastCheckDate === '' ? row.installDate : addMonths(row.lastCheckDate, row.checkCycleMon)
  return next < reference
}

/** 古树是否需要安排衰弱复评：最新长势为衰弱 / 濒危且已过复评周期 */
export function reviewEligible(latest: Review | null, reference = today()): boolean {
  if (latest === null) return false
  if (!VIGOR_NEED_FOLLOW_UP.includes(latest.vigor)) return false
  const cycle = REVIEW_CYCLE_DAYS[latest.vigor] ?? 60
  return daysBetween(latest.date, reference) > cycle
}

/* ------------------------------ 收集候选 ------------------------------ */

/** 排程台去重键：同株古树的同一条来源记录，只允许存在一个未关闭的条目 */
export function scheduleDedupKey(kind: JobKind, sourceId: string): string {
  return `${kind}:${sourceId}`
}

export function itemDedupKey(item: Pick<ScheduleItem, 'kind' | 'sourceId'>): string {
  return scheduleDedupKey(item.kind, item.sourceId)
}

/** 综合优先级分值：保护级别 > 超期天数（分档）> 复评风险 */
export function calcPriorityScore(
  protectLevel: Tree['protectLevel'],
  overdue: number,
  reviewRisk: number
): number {
  return PROTECT_LEVEL_SCORE[protectLevel] + overdue * 10 + reviewRisk
}

export interface CollectOptions {
  /** 已在排程台的条目（待排序 / 已排期 / 冲突均视为已收集） */
  existing?: Pick<ScheduleItem, 'kind' | 'sourceId'>[]
  /** 已生成且仍激活的工单对应来源（不重复派单） */
  activeOrders?: Pick<WorkOrder, 'kind' | 'sourceId'>[]
  /** 收集到条目的起始次序（多次收集时延续次序） */
  rankStart?: number
  reference?: string
  now?: string
}

/**
 * 从来源台账收集待办候选，生成排程台条目（状态均为「待排序」）。
 * 三类作业：到期未完成的复壮措施、超期未检查的加固件、衰弱 / 濒危且到复评周期的古树。
 */
export function buildCandidates(
  ctx: ScheduleSourceContext,
  options: CollectOptions = {}
): NewScheduleItem[] {
  const reference = options.reference ?? today()
  const now = options.now ?? reference
  const occupied = new Set<string>([
    ...(options.existing ?? []).map(itemDedupKey),
    ...(options.activeOrders ?? []).map((order) => scheduleDedupKey(order.kind, order.sourceId)),
  ])
  const treeMap = new Map(ctx.trees.map((tree) => [tree.id, tree]))
  const candidates: Array<NewScheduleItem & { rankOrder: number }> = []
  let rank = options.rankStart ?? 0

  const pushIfNew = (
    key: string,
    payload: Omit<NewScheduleItem, 'state' | 'plannedDate' | 'conflictReason' | 'collectedAt' | 'scheduledAt'>
  ): void => {
    if (occupied.has(key)) return
    occupied.add(key)
    candidates.push({
      ...payload,
      state: 'pending',
      plannedDate: '',
      conflictReason: '',
      collectedAt: now,
      scheduledAt: '',
      rankOrder: rank++,
    })
  }

  // 1) 复壮措施：未完成且计划日期已到 / 已逾期
  ctx.measures
    .filter((row) => measureEligible(row, reference))
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((row) => {
      const tree = treeMap.get(row.treeId)
      if (tree === undefined) return
      const latest = latestReviewOf(ctx.reviews, tree.id)
      const risk = REVIEW_RISK_SCORE[latest?.vigor ?? '一般']
      const overdue = measureOverdueDays(row, reference)
      pushIfNew(scheduleDedupKey('measure', row.id), {
        kind: 'measure',
        sourceId: row.id,
        treeId: tree.id,
        title: `${row.type}（${row.material || '材料待补'}）`,
        operator: row.operator,
        fingerprint: sourceFingerprint('measure', row),
        protectLevel: tree.protectLevel,
        overdueDays: overdue,
        reviewRisk: risk,
        priorityScore: calcPriorityScore(tree.protectLevel, overdue, risk),
        rankOrder: 0,
      })
    })

  // 2) 加固件复查：超周期未检查
  ctx.supports
    .filter((row) => supportEligible(row, reference))
    .forEach((row) => {
      const tree = treeMap.get(row.treeId)
      if (tree === undefined) return
      const latest = latestReviewOf(ctx.reviews, tree.id)
      const risk = REVIEW_RISK_SCORE[latest?.vigor ?? '一般']
      const overdue = overdueDays(row.lastCheckDate, row.checkCycleMon, reference)
      pushIfNew(scheduleDedupKey('support', row.id), {
        kind: 'support',
        sourceId: row.id,
        treeId: tree.id,
        title: `${row.type}复查`,
        operator: '',
        fingerprint: sourceFingerprint('support', row),
        protectLevel: tree.protectLevel,
        overdueDays: overdue,
        reviewRisk: risk,
        priorityScore: calcPriorityScore(tree.protectLevel, overdue, risk),
        rankOrder: 0,
      })
    })

  // 3) 衰弱复评：最新长势为衰弱 / 濒危且超过复评周期（每株古树至多一条）
  ctx.trees.forEach((tree) => {
    const latest = latestReviewOf(ctx.reviews, tree.id)
    if (!reviewEligible(latest, reference) || latest === null) return
    const risk = REVIEW_RISK_SCORE[latest.vigor]
    const cycle = REVIEW_CYCLE_DAYS[latest.vigor] ?? 60
    const overdue = Math.max(0, daysBetween(addDays(latest.date, cycle), reference))
    pushIfNew(scheduleDedupKey('review', latest.id), {
      kind: 'review',
      sourceId: latest.id,
      treeId: tree.id,
      title: `${latest.vigor}株复评（距上次 ${daysBetween(latest.date, reference)} 天）`,
      operator: '',
      fingerprint: sourceFingerprint('review', latest),
      protectLevel: tree.protectLevel,
      overdueDays: overdue,
      reviewRisk: risk,
      priorityScore: calcPriorityScore(tree.protectLevel, overdue, risk),
      rankOrder: 0,
    })
  })

  return candidates
}

/* ------------------------------ 排期算法 ------------------------------ */

/** 优先级排序：分值降序，同分时按收集次序升序（先收集先安排） */
export function sortByPriority<T extends Pick<ScheduleItem, 'priorityScore' | 'rankOrder'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.priorityScore - a.priorityScore || a.rankOrder - b.rankOrder)
}

/** 排期输入条目：需要 id、作业类别、负责人与古树 */
export interface SchedulableItem {
  id: string
  kind: JobKind
  treeId: string
  operator: string
}

/**
 * 排期占用表：某日某负责人的承接件数、某日某古树已安排的各作业类别件数
 */
interface Occupancy {
  byOperatorDate: Map<string, number>
  byTreeDateKind: Map<string, number>
}

function occupancyKey(a: string, b: string): string {
  return `${a}￨${b}`
}

function treeDateKindKey(treeId: string, date: string, kind: JobKind): string {
  return `${treeId}￨${date}￨${kind}`
}

/**
 * 根据已有工单构建占用表（排期必须尊重已生成工单，否则新批次会再次撞档）。
 */
export function buildOccupancy(orders: Pick<WorkOrder, 'kind' | 'date' | 'operator' | 'treeId' | 'state'>[]): Occupancy {
  const occupancy: Occupancy = { byOperatorDate: new Map(), byTreeDateKind: new Map() }
  orders
    .filter((order) => WORK_ORDER_ACTIVE_STATES.includes(order.state))
    .forEach((order) => {
      const ok = occupancyKey(order.operator, order.date)
      occupancy.byOperatorDate.set(ok, (occupancy.byOperatorDate.get(ok) ?? 0) + 1)
      const tk = treeDateKindKey(order.treeId, order.date, order.kind)
      occupancy.byTreeDateKind.set(tk, (occupancy.byTreeDateKind.get(tk) ?? 0) + 1)
    })
  return occupancy
}

/**
 * 贪心排期：按优先级逐条放入「从 startDate 起第一个可安排日」。
 * 硬约束：负责人当日件数 < 3，且该古树当日未安排过「其他类别」作业
 *（同株当天允许多条同类作业，不允许两类及以上作业）。
 * 无负责人（待指派）的条目不可排期。返回 条目 id → 计划日期。
 */
export function autoSchedule<T extends SchedulableItem>(
  items: T[],
  startDate: string,
  existingOrders: Pick<WorkOrder, 'kind' | 'date' | 'operator' | 'treeId' | 'state'>[] = [],
  maxScanDays = 366
): Map<string, string> {
  const result = new Map<string, string>()
  const occupancy = buildOccupancy(existingOrders)

  // 某株古树某日是否已安排「不同于 kind」的作业类别
  const hasOtherKindOnTreeDate = (treeId: string, date: string, kind: JobKind): boolean => {
    const kinds: JobKind[] = ['measure', 'support', 'review']
    return kinds.some((other) => other !== kind && (occupancy.byTreeDateKind.get(treeDateKindKey(treeId, date, other)) ?? 0) > 0)
  }

  for (const item of items) {
    if (item.operator.trim() === '') continue
    for (let offset = 0; offset < maxScanDays; offset += 1) {
      const date = addDays(startDate, offset)
      const ok = occupancyKey(item.operator, date)
      if ((occupancy.byOperatorDate.get(ok) ?? 0) >= DAILY_ASSIGN_LIMIT) continue
      // 同株古树当天只安排一类现场作业：存在其他类别即撞档（同类多条允许）
      if (hasOtherKindOnTreeDate(item.treeId, date, item.kind)) continue
      result.set(item.id, date)
      occupancy.byOperatorDate.set(ok, (occupancy.byOperatorDate.get(ok) ?? 0) + 1)
      const tk = treeDateKindKey(item.treeId, date, item.kind)
      occupancy.byTreeDateKind.set(tk, (occupancy.byTreeDateKind.get(tk) ?? 0) + 1)
      break
    }
  }
  return result
}

/* ------------------------------ 批次确认：冲突检测 ------------------------------ */

export type ItemConflict =
  | { conflict: true; reason: string }
  | { conflict: false; reason: '' }

/**
 * 批次确认 / 重新排序前逐条复核来源记录：
 * - 来源被删除：冲突（来源记录已删除）
 * - 来源已不再需要排期（措施已完成或改期未来 / 加固件已检查 / 复评已更新或树势恢复）：冲突
 * - 指纹变化（仍需排期但内容被改）：冲突（确认期间来源被修改）
 * 先判失效、后比指纹：完成 / 检查本身就会改变指纹，失效原因比「被修改」更有指导性。
 */
export function checkItemConflict(
  item: Pick<ScheduleItem, 'kind' | 'sourceId' | 'fingerprint'>,
  ctx: ScheduleSourceContext,
  reference = today()
): ItemConflict {
  if (item.kind === 'measure') {
    const row = ctx.measures.find((m) => m.id === item.sourceId)
    if (row === undefined) return { conflict: true, reason: '来源措施已被删除' }
    if (!measureEligible(row, reference)) {
      return {
        conflict: true,
        reason: row.state === '已完成' ? '该措施已完成，不再需要现场作业' : '该措施计划日期已改到未来，暂不需要排期',
      }
    }
    if (sourceFingerprint('measure', row) !== item.fingerprint) {
      return { conflict: true, reason: '确认期间该措施台账被修改，请重新核对负责人 / 日期 / 状态' }
    }
  } else if (item.kind === 'support') {
    const row = ctx.supports.find((s) => s.id === item.sourceId)
    if (row === undefined) return { conflict: true, reason: '来源加固件已被删除' }
    if (!supportEligible(row, reference)) {
      return { conflict: true, reason: '该加固件已登记检查，不再超期' }
    }
    if (sourceFingerprint('support', row) !== item.fingerprint) {
      return { conflict: true, reason: '确认期间该加固件台账被修改，请重新核对检查周期 / 最近检查日期' }
    }
  } else {
    const row = ctx.reviews.find((r) => r.id === item.sourceId)
    if (row === undefined) return { conflict: true, reason: '来源复评记录已被删除' }
    const latest = latestReviewOf(ctx.reviews, row.treeId)
    if (latest === null || latest.id !== row.id) {
      return { conflict: true, reason: '已有更新的复评记录，本条复评待办已过期' }
    }
    if (!reviewEligible(latest, reference)) {
      return { conflict: true, reason: '树势已恢复或复评周期未到，不再需要本次复评' }
    }
    if (sourceFingerprint('review', row) !== item.fingerprint) {
      return { conflict: true, reason: '确认期间该复评记录被修改，请重新核对长势 / 趋势' }
    }
  }
  return { conflict: false, reason: '' }
}

/** 以最新来源数据重建条目的优先级快照（排序 / 确认前调用） */
export function refreshItemSnapshot(
  item: ScheduleItem,
  ctx: ScheduleSourceContext,
  reference = today()
): ScheduleItem {
  const tree = ctx.trees.find((t) => t.id === item.treeId)
  if (tree === undefined) {
    return { ...item, state: 'conflict', conflictReason: '古树档案已被删除', plannedDate: '' }
  }
  if (item.kind === 'measure') {
    const row = ctx.measures.find((m) => m.id === item.sourceId)
    if (row !== undefined) {
      const latest = latestReviewOf(ctx.reviews, tree.id)
      const risk = REVIEW_RISK_SCORE[latest?.vigor ?? '一般']
      const overdue = measureOverdueDays(row, reference)
      return {
        ...item,
        title: `${row.type}（${row.material || '材料待补'}）`,
        protectLevel: tree.protectLevel,
        overdueDays: overdue,
        reviewRisk: risk,
        priorityScore: calcPriorityScore(tree.protectLevel, overdue, risk),
      }
    }
  } else if (item.kind === 'support') {
    const row = ctx.supports.find((s) => s.id === item.sourceId)
    if (row !== undefined) {
      const latest = latestReviewOf(ctx.reviews, tree.id)
      const risk = REVIEW_RISK_SCORE[latest?.vigor ?? '一般']
      const overdue = overdueDays(row.lastCheckDate, row.checkCycleMon, reference)
      return {
        ...item,
        protectLevel: tree.protectLevel,
        overdueDays: overdue,
        reviewRisk: risk,
        priorityScore: calcPriorityScore(tree.protectLevel, overdue, risk),
      }
    }
  } else {
    const latest = latestReviewOf(ctx.reviews, tree.id)
    if (latest !== null && latest.id === item.sourceId) {
      const risk = REVIEW_RISK_SCORE[latest.vigor]
      const cycle = REVIEW_CYCLE_DAYS[latest.vigor] ?? 60
      const overdue = Math.max(0, daysBetween(addDays(latest.date, cycle), reference))
      return {
        ...item,
        title: `${latest.vigor}株复评（距上次 ${daysBetween(latest.date, reference)} 天）`,
        protectLevel: tree.protectLevel,
        overdueDays: overdue,
        reviewRisk: risk,
        priorityScore: calcPriorityScore(tree.protectLevel, overdue, risk),
      }
    }
  }
  return item
}
