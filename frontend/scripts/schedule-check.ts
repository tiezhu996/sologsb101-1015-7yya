/**
 * 排程算法快速自检（不进生产产物）：
 * - 优先级：保护级别 > 超期天数 > 复评风险；
 * - 约束：负责人每天 ≤3 件、同株古树当天仅一类（同类多条允许、异类撞档顺延）；
 * - 批次确认：确认期间来源被修改 / 删除 / 失效 → 冲突留台。
 */
import type { Measure } from '../src/types/measure'
import type { Support } from '../src/types/support'
import type { Review } from '../src/types/review'
import {
  addDays,
  autoSchedule,
  buildCandidates,
  buildOccupancy,
  checkItemConflict,
  sortByPriority,
  type ScheduleSourceContext,
} from '../src/utils/schedule'
import { WORK_ORDER_ACTIVE_STATES, type ScheduleItem } from '../src/types/schedule'
import type { Tree } from '../src/types/tree'

let failures = 0
function assert(cond: boolean, message: string): void {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

const REF = '2026-10-04'

const trees: Tree[] = [
  { id: 't1', code: 'A', species: '国槐', protectLevel: '一级', ageYears: 300, location: '', owner: '', lastMeasureDate: '', createdAt: '', updatedAt: '', revision: 3 },
  { id: 't2', code: 'B', species: '银杏', protectLevel: '二级', ageYears: 200, location: '', owner: '', lastMeasureDate: '', createdAt: '', updatedAt: '', revision: 3 },
  { id: 't3', code: 'C', species: '侧柏', protectLevel: '三级', ageYears: 100, location: '', owner: '', lastMeasureDate: '', createdAt: '', updatedAt: '', revision: 3 },
]

const measures: Measure[] = [
  { id: 'm1', treeId: 't3', type: '施肥', date: '2026-10-01', material: '肥', operator: '甲', state: '计划', createdAt: '', updatedAt: '', revision: 3 },
  { id: 'm2', treeId: 't2', type: '施肥', date: '2026-09-20', material: '肥', operator: '乙', state: '计划', createdAt: '', updatedAt: '', revision: 3 },
  { id: 'm3', treeId: 't1', type: '施肥', date: '2026-10-03', material: '肥', operator: '甲', state: '实施中', createdAt: '', updatedAt: '', revision: 3 },
]
const supports: Support[] = [
  { id: 's1', treeId: 't1', type: '支撑杆', installDate: '2020-01-01', checkCycleMon: 12, lastCheckDate: '2024-01-01', createdAt: '', updatedAt: '', revision: 3 },
]
const reviews: Review[] = []

const ctx: ScheduleSourceContext = { trees, measures, supports, reviews }

console.log('收集候选')
const candidates = buildCandidates(ctx, { reference: REF, now: REF })
assert(candidates.length === 4, `应收集 4 项（3 措施 + 1 加固复查），实际 ${candidates.length}`)

console.log('优先级排序')
const ordered = sortByPriority(candidates)
assert(ordered[0].sourceId === 's1', `一级古树超期加固件应排第 1，实际 ${ordered[0].sourceId}`)
// 同为一级 t1 的 m3 与 s1：s1 超期天数远大于 m3
assert(ordered[1].sourceId === 'm3', `一级措施 m3 应排第 2，实际 ${ordered[1].sourceId}`)
assert(ordered[2].sourceId === 'm2', `二级 m2 应排第 3，实际 ${ordered[2].sourceId}`)
assert(ordered[3].sourceId === 'm1', `三级 m1 应排第 4，实际 ${ordered[3].sourceId}`)

console.log('自动排期：每人每天 ≤3 件')
const schedItems = ordered.map((c, i) => ({
  id: `i${i}`,
  kind: c.kind,
  treeId: c.treeId,
  operator: c.kind === 'support' ? '甲' : c.operator,
}))
const plan = autoSchedule(schedItems, REF, [])
const planRows = schedItems.map((it, i) => ({
  source: ordered[i].sourceId,
  operator: it.operator,
  date: plan.get(it.id) ?? '',
}))
// 甲的作业：s1（t1 加固复查）、m3（t1 措施）、m1（t3 措施）。
// s1 与 m3 同株异类不能同日，故首日甲 = s1 + m1（2 件），m3 顺延次日。
const byJiaDay1 = planRows.filter((it) => it.operator === '甲' && it.date === REF).length
assert(byJiaDay1 === 2, `甲首日应为 s1+m1 共 2 件（m3 与 s1 同株异类顺延），实际 ${byJiaDay1}`)
assert(
  planRows.find((r) => r.source === 'm3')?.date === addDays(REF, 1),
  'm3 与 s1 同株古树当天两类作业，应顺延次日'
)
assert(
  planRows.find((r) => r.source === 'm1')?.date === REF,
  'm1（t3）不与 t1 撞株，应排在首日'
)

console.log('同株古树当天仅一类（异类撞档顺延，同类可共存）')
const sameTree = [
  { id: 'a', kind: 'measure' as const, treeId: 't1', operator: '丙' },
  { id: 'b', kind: 'support' as const, treeId: 't1', operator: '丙' },
  { id: 'c', kind: 'measure' as const, treeId: 't1', operator: '丙' },
]
const plan2 = autoSchedule(sameTree, REF, [])
assert(plan2.get('a') === REF && plan2.get('c') === REF, '同类两条措施可排在同一天')
assert(plan2.get('b') === addDays(REF, 1), '异类加固复查应顺延到次日')

console.log('已生成工单占用容量与树日类别')
const occupied = buildOccupancy([
  { kind: 'measure', date: REF, operator: '丁', treeId: 't2', state: '待执行' },
  { kind: 'measure', date: REF, operator: '丁', treeId: 't3', state: '执行中' },
])
void occupied
const plan3 = autoSchedule(
  [{ id: 'x', kind: 'measure', treeId: 't1', operator: '丁' }],
  REF,
  [{ kind: 'measure', date: REF, operator: '丁', treeId: 't2', state: '待执行' }]
)
assert(plan3.get('x') === REF, '丁首日已有 1 张工单，新措施仍可排入（共 2 ≤ 3）')
const plan4 = autoSchedule(
  [{ id: 'x', kind: 'support', treeId: 't2', operator: '丁' }],
  REF,
  [{ kind: 'measure', date: REF, operator: '丁', treeId: 't2', state: '待执行' }]
)
assert(plan4.get('x') === addDays(REF, 1), 't2 当天已有措施工单，加固复查必须顺延')

console.log('批次确认：来源变更 / 删除 / 失效检测')
const baseItem: ScheduleItem = {
  id: 'item1',
  kind: 'measure',
  sourceId: 'm1',
  treeId: 't3',
  title: '施肥',
  operator: '甲',
  fingerprint: 'm:t3|施肥|2026-10-01|计划|甲|v1',
  protectLevel: '三级',
  overdueDays: 3,
  reviewRisk: 0,
  priorityScore: 0,
  rankOrder: 0,
  state: 'scheduled',
  plannedDate: REF,
  conflictReason: '',
  collectedAt: REF,
  scheduledAt: REF,
  createdAt: '',
  updatedAt: '',
  revision: 3,
}
const stillOk = checkItemConflict(baseItem, { ...ctx, measures: [{ ...measures[0], updatedAt: 'v1' }] }, REF)
assert(!stillOk.conflict, '指纹一致时不应冲突')
const changed = checkItemConflict(baseItem, { ...ctx, measures: [{ ...measures[0], operator: '新人', updatedAt: 'v2' }] }, REF)
assert(changed.conflict && changed.reason.includes('修改'), '确认期间负责人被修改应冲突留台')
const deleted = checkItemConflict(baseItem, { ...ctx, measures: measures.slice(1) }, REF)
assert(deleted.conflict && deleted.reason.includes('删除'), '来源措施被删除应冲突留台')
const done = checkItemConflict(baseItem, { ...ctx, measures: [{ ...measures[0], state: '已完成' }] }, REF)
assert(done.conflict && done.reason.includes('已完成'), '措施已完成应冲突')

// 加固件已登记检查 → 不再超期 → 冲突
const supportItem: ScheduleItem = {
  ...baseItem,
  id: 'item2',
  kind: 'support',
  sourceId: 's1',
  treeId: 't1',
  fingerprint: 's:t1|支撑杆|12|2024-01-01|v1',
}
const checked: Support = { ...supports[0], lastCheckDate: '2026-10-01', updatedAt: 'v2' }
const supportChecked = checkItemConflict(supportItem, { ...ctx, supports: [checked] }, REF)
assert(supportChecked.conflict && supportChecked.reason.includes('已登记检查'), '加固件已检查应冲突留台')

void WORK_ORDER_ACTIVE_STATES

if (failures > 0) {
  console.error(`\n${failures} 项自检失败`)
  process.exit(1)
}
console.log('\n全部自检通过')
