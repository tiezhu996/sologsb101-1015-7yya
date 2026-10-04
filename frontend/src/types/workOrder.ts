/**
 * 现场工单（WorkOrder）
 * 同一张表承载排程台条目与正式工单：
 * - draft     排程台候选，待批次确认
 * - conflict  批次确认时发现来源记录被改动，留在排程台等待重新排序
 * - scheduled 批次确认通过，已生成工单、待执行
 * - done      已完工
 * - cancelled 已取消（释放来源记录，允许重新进入排程台）
 */
import type { ProtectLevel } from './tree'

/** 现场作业三类：复壮措施 / 加固件复查 / 衰弱复评 */
export type WorkKind = 'measure' | 'support' | 'review'

export const WORK_KIND_OPTIONS: WorkKind[] = ['measure', 'support', 'review']

export const WORK_KIND_LABEL: Record<WorkKind, string> = {
  measure: '复壮措施',
  support: '加固件复查',
  review: '衰弱复评',
}

export type WorkOrderStatus = 'draft' | 'conflict' | 'scheduled' | 'done' | 'cancelled'

export const WORK_ORDER_STATUS_LABEL: Record<WorkOrderStatus, string> = {
  draft: '待确认',
  conflict: '来源冲突',
  scheduled: '待执行',
  done: '已完工',
  cancelled: '已取消',
}

/** 仍占用排期资源（负责人额度 / 同株同日互斥）的状态 */
export const ACTIVE_ORDER_STATUSES: WorkOrderStatus[] = ['draft', 'conflict', 'scheduled']

/** 已正式生成、尚未完工的工单（来源台账与养护总览展示的「当前工单」） */
export const CURRENT_ORDER_STATUSES: WorkOrderStatus[] = ['scheduled']

/** 一名负责人每天最多承接的现场作业数 */
export const MAX_DAILY_PER_OPERATOR = 3

/**
 * 排期时刻对来源记录做的快照。
 * fingerprint 为来源记录关键字段 + 古树保护级别的哈希输入，
 * 批次确认时重新读取来源记录并比对，发现改动即判为冲突。
 */
export interface WorkOrderSnapshot {
  /** 来源摘要，如「透气 · 实施中 · 拟实施 2026-03-20」 */
  sourceKey: string
  treeCode: string
  protectLevel: ProtectLevel
  /** 保护级别排序值：一级 3 / 二级 2 / 三级 1 */
  protectRank: number
  /** 超期天数（加固件为超检查周期天数，未完成措施为超拟实施日期天数，衰弱复评为距上次复评天数） */
  overdueDays: number
  /** 复评风险排序值 0–3：濒危 3 / 衰弱且下降 3 / 衰弱 2 / 一般或未复评 1 / 旺盛 0 */
  riskRank: number
  riskLabel: string
  /** 批次确认时的并发改动检测指纹 */
  fingerprint: string
}

export interface WorkOrder {
  id: string
  /** 工单号，批次确认通过时生成，如 GD-20261004-001；排程台阶段为空串 */
  code: string
  kind: WorkKind
  treeId: string
  /** 来源记录 id（measures / supports / reviews 表主键） */
  sourceId: string
  snapshot: WorkOrderSnapshot
  operator: string
  /** 计划现场作业日期 YYYY-MM-DD */
  plannedDate: string
  status: WorkOrderStatus
  /** 冲突 / 不再满足排期条件等留台原因 */
  conflictReason: string
  /** 批次号，如 B-20261004-0930 */
  batchNo: string
  note: string
  confirmedAt: string
  finishedAt: string
  createdAt: string
  updatedAt: string
  revision: number
}
