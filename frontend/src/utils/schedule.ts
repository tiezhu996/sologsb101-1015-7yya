/**
 * 排程台算法（纯函数，便于单测与复用）
 * - 候选生成：未完成的复壮措施、超检查周期的加固件复查、最新长势为衰弱 / 濒危的复评
 * - 优先级：保护级别 → 超期天数 → 复评风险
 * - 派单约束：一名负责人每天最多 3 件；同株古树当天至多 1 单（即只安排一类现场作业）
 * - 指纹：批次确认前快照来源记录，确认时重新读取比对，发现并发改动判为冲突
 */
import type { Measure } from '../types/measure'
import type { Support } from '../types/support'
import type { Review, Vigor, Trend } from '../types/review'
import type { Tree, ProtectLevel } from '../types/tree'
import type { WorkKind, WorkOrderSnapshot } from '../types/workOrder'
import { MAX_DAILY_PER_OPERATOR } from '../types/workOrder'
import { daysBetween, isSupportOverdue, overdueDays } from './dimension'
import { today } from './id'

/** 保护级别排序值：一级 > 二级 > 三级 */
export const PROTECT_RANK: Record<ProtectLevel, number> = {
  一级: 3,
  二级: 2,
  三级: 1,
}

/** 复评风险等级：濒危最高；衰弱叠加下降趋势时上调 */
export type RiskLevel = 'high' | 'medium' | 'low' | 'none'

export interface RiskResult {
  rank: number
  label: string
  level: RiskLevel
}

export function reviewRisk(vigor: Vigor | null, trend: Trend | null): RiskResult {
  if (vigor === '濒危') return { rank: 3, label: '濒危', level: 'high' }
  if (vigor === '衰弱') {
    return trend === '下降'
      ? { rank: 3, label: '衰弱·下降', level: 'high' }
      : { rank: 2, label: '衰弱', level: 'medium' }
  }
  if (vigor === '一般') return { rank: 1, label: '长势一般', level: 'low' }
  if (vigor === '旺盛') return { rank: 0, label: '长势旺盛', level: 'none' }
  return { rank: 1, label: '未复评', level: 'low' }
}

/** 未完成措施的超期天数：拟实施日期早于今天即超期 */
export function measureOverdueDays(date: string, reference = today()): number {
  if (date === '') return 0
  return Math.max(0, daysBetween(date, reference))
}

/** 衰弱 / 濒危复评的超期天数：上次复评至今的天数 */
export function reviewOverdueDays(date: string, reference = today()): number {
  if (date === '') return 0
  return Math.max(0, daysBetween(date, reference))
}

/**
 * 来源记录指纹输入。
 * 保护级别来自古树（古树保护级别调整也会让排程台条目失效），
 * 再拼接各类作业的关键字段，任何一项在确认前被修改都会触发冲突留台。
 */
export function buildFingerprint(kind: WorkKind, source: unknown, protectLevel: ProtectLevel): string {
  const base = `level:${protectLevel}`
  if (kind === 'measure') {
    const m = source as Measure
    return [base, 'measure', m.type, m.date, m.state, m.operator].join('|')
  }
  if (kind === 'support') {
    const s = source as Support
    return [base, 'support', s.type, s.checkCycleMon, s.lastCheckDate].join('|')
  }
  const r = source as Review
  return [base, 'review', r.date, r.vigor, r.trend].join('|')
}

/** 排程台候选（尚未落库为 draft 行） */
export interface ScheduleCandidate {
  key: string
  kind: WorkKind
  treeId: string
  sourceId: string
  /** 建议负责人（措施沿用措施负责人；其余为空，由派单算法挑人） */
  preferredOperator: string
  snapshot: WorkOrderSnapshot
}

export interface BuildCandidatesInput {
  trees: Tree[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
  /** 已在排程台 / 已生成工单的来源键，格式 `${kind}:${sourceId}` */
  takenSourceKeys: Set<string>
  reference?: string
}

/** 取每株古树最新一次复评 */
function latestReviewOf(reviews: Review[], treeId: string): Review | null {
  const list = reviews.filter((row) => row.treeId === treeId).sort((a, b) => a.date.localeCompare(b.date))
  return list.length > 0 ? list[list.length - 1] : null
}

/**
 * 生成排程台候选：
 * 1. 状态为「计划 / 实施中」的复壮措施；
 * 2. 超过检查周期未检查的加固件；
 * 3. 最新复评长势为衰弱 / 濒危、且尚未安排复评工单的古树。
 * 已有活跃排程台条目 / 工单的来源不重复入台。
 */
export function buildScheduleCandidates(input: BuildCandidatesInput): ScheduleCandidate[] {
  const reference = input.reference ?? today()
  const treeMap = new Map(input.trees.map((tree) => [tree.id, tree]))
  const result: ScheduleCandidate[] = []

  const latestMap = new Map<string, Review | null>()
  const latestReview = (treeId: string): Review | null => {
    if (!latestMap.has(treeId)) latestMap.set(treeId, latestReviewOf(input.reviews, treeId))
    return latestMap.get(treeId) ?? null
  }

  for (const measure of input.measures) {
    if (measure.state === '已完成') continue
    const key: string = `measure:${measure.id}`
    if (input.takenSourceKeys.has(key)) continue
    const tree = treeMap.get(measure.treeId)
    if (!tree) continue
    const latest = latestReview(tree.id)
    const risk = reviewRisk(latest?.vigor ?? null, latest?.trend ?? null)
    result.push({
      key,
      kind: 'measure',
      treeId: tree.id,
      sourceId: measure.id,
      preferredOperator: measure.operator,
      snapshot: {
        sourceKey: `${measure.type} · ${measure.state} · 拟实施 ${measure.date}`,
        treeCode: tree.code,
        protectLevel: tree.protectLevel,
        protectRank: PROTECT_RANK[tree.protectLevel],
        overdueDays: measureOverdueDays(measure.date, reference),
        riskRank: risk.rank,
        riskLabel: risk.label,
        fingerprint: buildFingerprint('measure', measure, tree.protectLevel),
      },
    })
  }

  for (const support of input.supports) {
    if (!isSupportOverdue(support.lastCheckDate, support.checkCycleMon, reference)) continue
    const key: string = `support:${support.id}`
    if (input.takenSourceKeys.has(key)) continue
    const tree = treeMap.get(support.treeId)
    if (!tree) continue
    const latest = latestReview(tree.id)
    const risk = reviewRisk(latest?.vigor ?? null, latest?.trend ?? null)
    result.push({
      key,
      kind: 'support',
      treeId: tree.id,
      sourceId: support.id,
      preferredOperator: '',
      snapshot: {
        sourceKey: `${support.type}复查 · 上次检查 ${support.lastCheckDate || '未记录'} · 周期 ${support.checkCycleMon} 个月`,
        treeCode: tree.code,
        protectLevel: tree.protectLevel,
        protectRank: PROTECT_RANK[tree.protectLevel],
        overdueDays: overdueDays(support.lastCheckDate, support.checkCycleMon, reference),
        riskRank: risk.rank,
        riskLabel: risk.label,
        fingerprint: buildFingerprint('support', support, tree.protectLevel),
      },
    })
  }

  for (const tree of input.trees) {
    const latest = latestReviewOf(input.reviews, tree.id)
    if (latest === null) continue
    if (latest.vigor !== '衰弱' && latest.vigor !== '濒危') continue
    const key: string = `review:${latest.id}`
    if (input.takenSourceKeys.has(key)) continue
    const risk = reviewRisk(latest.vigor, latest.trend)
    result.push({
      key,
      kind: 'review',
      treeId: tree.id,
      sourceId: latest.id,
      preferredOperator: '',
      snapshot: {
        sourceKey: `${latest.vigor}复评 · ${latest.trend} · ${latest.date}`,
        treeCode: tree.code,
        protectLevel: tree.protectLevel,
        protectRank: PROTECT_RANK[tree.protectLevel],
        overdueDays: reviewOverdueDays(latest.date, reference),
        riskRank: risk.rank,
        riskLabel: risk.label,
        fingerprint: buildFingerprint('review', latest, tree.protectLevel),
      },
    })
  }

  return result
}

/** 优先级比较：保护级别降序 → 超期天数降序 → 复评风险降序，再以 key 兜底保证稳定 */
export function comparePriority(a: ScheduleCandidate, b: ScheduleCandidate): number {
  const sa = a.snapshot
  const sb = b.snapshot
  if (sb.protectRank !== sa.protectRank) return sb.protectRank - sa.protectRank
  if (sb.overdueDays !== sa.overdueDays) return sb.overdueDays - sa.overdueDays
  if (sb.riskRank !== sa.riskRank) return sb.riskRank - sa.riskRank
  return a.key.localeCompare(b.key)
}

/** 派单结果 */
export interface Assignment {
  key: string
  operator: string
  plannedDate: string
}

interface AssignInput {
  /** 已按优先级排好序的候选 */
  candidates: Array<Pick<ScheduleCandidate, 'key' | 'treeId' | 'preferredOperator'>>
  operators: string[]
  startDate: string
  /** 排期窗口（天），超出窗口仍派不下去时落到窗口最后一天，避免无限延后 */
  horizonDays: number
  /** 既存占用：operator -> date -> 件数 */
  operatorLoad?: Map<string, Map<string, number>>
  /** 既存占用：`${treeId}@${date}` 已派（同株同日只允许一类现场作业） */
  treeDayUsed?: Set<string>
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00`)
  if (Number.isNaN(base.getTime())) return date
  base.setDate(base.getDate() + days)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`
}

/**
 * 贪心派单：优先级高者先选；
 * 候选优先沿用建议负责人（措施负责人），不可行时退化为「当日负载最小的负责人」；
 * 再从 startDate 起逐日寻找「负责人当日 < 3 件 且 该株当天未排其他作业」的首个日期。
 */
export function assignCandidates(input: AssignInput): Assignment[] {
  const load = input.operatorLoad ?? new Map<string, Map<string, number>>()
  const treeDay = input.treeDayUsed ?? new Set<string>()
  const results: Assignment[] = []

  const count = (operator: string, date: string): number => load.get(operator)?.get(date) ?? 0

  const bump = (operator: string, date: string): void => {
    if (!load.has(operator)) load.set(operator, new Map<string, number>())
    const perDate = load.get(operator)!
    perDate.set(date, (perDate.get(date) ?? 0) + 1)
  }

  const pickOperator = (candidate: Pick<ScheduleCandidate, 'treeId' | 'preferredOperator'>, date: string): string | null => {
    const preferred = candidate.preferredOperator.trim()
    if (preferred !== '' && input.operators.includes(preferred) && count(preferred, date) < MAX_DAILY_PER_OPERATOR) {
      return preferred
    }
    const feasible = input.operators
      .filter((name) => count(name, date) < MAX_DAILY_PER_OPERATOR)
      .sort((a, b) => count(a, date) - count(b, date) || a.localeCompare(b, 'zh-Hans-CN'))
    return feasible[0] ?? null
  }

  for (const candidate of input.candidates) {
    let placed = false
    for (let offset = 0; offset < input.horizonDays && !placed; offset += 1) {
      const date = addDays(input.startDate, offset)
      if (treeDay.has(`${candidate.treeId}@${date}`)) continue
      const operator = pickOperator(candidate, date)
      if (operator === null) continue
      bump(operator, date)
      treeDay.add(`${candidate.treeId}@${date}`)
      results.push({ key: candidate.key, operator, plannedDate: date })
      placed = true
    }
    if (!placed) {
      // 负责人全员满载或窗口耗尽：落到窗口最后一天，交由人工在排程台调整
      const date = addDays(input.startDate, input.horizonDays - 1)
      const fallback = [...input.operators].sort(
        (a, b) => count(a, date) - count(b, date) || a.localeCompare(b, 'zh-Hans-CN')
      )[0] ?? (candidate.preferredOperator || '待分配')
      bump(fallback, date)
      treeDay.add(`${candidate.treeId}@${date}`)
      results.push({ key: candidate.key, operator: fallback, plannedDate: date })
    }
  }

  return results
}

/** 校验单条手工调整是否违反两条硬约束，返回冲突说明；无冲突返回 null */
export function validateManualAssignment(args: {
  operator: string
  plannedDate: string
  treeId: string
  operatorLoad: Map<string, Map<string, number>>
  treeDayUsed: Set<string>
}): string | null {
  const count = args.operatorLoad.get(args.operator)?.get(args.plannedDate) ?? 0
  if (count >= MAX_DAILY_PER_OPERATOR) {
    return `负责人「${args.operator}」在 ${args.plannedDate} 已承接 ${MAX_DAILY_PER_OPERATOR} 件，超过每日上限`
  }
  if (args.treeDayUsed.has(`${args.treeId}@${args.plannedDate}`)) {
    return `该古树在 ${args.plannedDate} 已安排现场作业，同株古树当天只能安排一类作业`
  }
  return null
}
