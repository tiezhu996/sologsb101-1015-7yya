/**
 * 养护排程（Schedule）
 * 排程台把三类现场作业统一排队：复壮措施、加固件复查、衰弱复评。
 * - ScheduleItem：排程台条目，收集来源台账的待办后按优先级排序、按约束排期；
 * - WorkOrder：批次确认后生成的现场工单，完成时回写来源台账。
 */
import type { ProtectLevel } from './tree'

/** 现场作业类别：复壮措施 / 加固件复查 / 衰弱复评 */
export type JobKind = 'measure' | 'support' | 'review'

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  measure: '复壮措施',
  support: '加固件复查',
  review: '衰弱复评',
}

/** 排程台条目状态：待排序 / 已排期 / 冲突留台 */
export type ScheduleItemState = 'pending' | 'scheduled' | 'conflict'

export const SCHEDULE_ITEM_STATE_LABEL: Record<ScheduleItemState, string> = {
  pending: '待排序',
  scheduled: '已排期',
  conflict: '冲突留台',
}

/** 工单状态：待执行 → 执行中 → 已完成 / 已取消 */
export type WorkOrderState = '待执行' | '执行中' | '已完成' | '已取消'

export const WORK_ORDER_STATE_OPTIONS: WorkOrderState[] = ['待执行', '执行中', '已完成', '已取消']

/** 仍占排期容量、需要在台账上提示的工单状态 */
export const WORK_ORDER_ACTIVE_STATES: WorkOrderState[] = ['待执行', '执行中']

/** 复评风险档（由古树最新长势推导）：濒危=高 / 衰弱=较高 / 一般=较低 / 旺盛=低 */
export type ReviewRiskLevel = 'high' | 'watch' | 'normal' | 'low'

export interface ScheduleItem {
  id: string
  /** 作业类别 */
  kind: JobKind
  /** 来源记录 id（measure / support / review 的主键） */
  sourceId: string
  /** 所属古树 */
  treeId: string
  /** 作业内容摘要（措施类型 / 加固件类型复查 / 濒危复评 等） */
  title: string
  /** 负责人；加固件复查与衰弱复评默认待指派，需在排程台补录 */
  operator: string
  /** 收集 / 排期时的来源指纹；批次确认时重新比对以发现确认期间的并发修改 */
  fingerprint: string
  /** —— 以下为优先级排序依据快照 —— */
  protectLevel: ProtectLevel
  /** 超期天数（措施逾期 / 加固件超周期 / 复评超周期） */
  overdueDays: number
  /** 复评风险分 0–3（由最新长势推导） */
  reviewRisk: number
  /** 综合优先级分值（保护级别 × 系数 + 超期天数 × 系数 + 风险分） */
  priorityScore: number
  /** 同分时的稳定次序（收集时给定） */
  rankOrder: number
  state: ScheduleItemState
  /** 计划现场作业日期 YYYY-MM-DD（待排序 / 冲突时为空） */
  plannedDate: string
  /** 冲突留台原因 */
  conflictReason: string
  /** 收集时间 */
  collectedAt: string
  /** 最近一次排期时间 */
  scheduledAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

export interface WorkOrder {
  id: string
  /** 工单编号，如 WO20261004-01 */
  code: string
  /** 生成它的排程台条目 id */
  scheduleItemId: string
  kind: JobKind
  sourceId: string
  treeId: string
  title: string
  /** 计划现场作业日期 */
  date: string
  operator: string
  state: WorkOrderState
  /** 生成时的优先级分值（留档） */
  priorityScore: number
  generatedAt: string
  /** 完成 / 取消时间 */
  closedAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建排程台条目入参（id / 时间戳 / 修订号由落库层补齐） */
export type NewScheduleItem = Omit<
  ScheduleItem,
  'id' | 'createdAt' | 'updatedAt' | 'revision'
>
