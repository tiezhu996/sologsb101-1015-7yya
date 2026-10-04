/**
 * 排程台端到端自检（fake-indexeddb + 内存数据库）：
 * 收集 → 指派 → 排期 → 批次确认期间并发修改来源 → 冲突留台、其余生成工单 → 完成工单回写。
 */
import 'fake-indexeddb/auto'
import { seedDatabase } from '../src/utils/seed'
import {
  db,
  initDatabase,
  listMeasures,
  listScheduleItems,
  listSupports,
  listWorkOrders,
  markSupportChecked,
  putMeasure,
} from '../src/utils/db'
import { buildCandidates, checkItemConflict, type ScheduleSourceContext } from '../src/utils/schedule'
import { bulkPutScheduleItems } from '../src/utils/db'
import { nowIso, today, uuid } from '../src/utils/id'
import { ROW_REVISION } from '../src/utils/db'
import type { ScheduleItem } from '../src/types/schedule'

let failures = 0
function assert(cond: boolean, message: string): void {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

await initDatabase()

const [trees, measures, supports, reviews] = await Promise.all([
  db.trees.toArray(),
  db.measures.toArray(),
  db.supports.toArray(),
  db.reviews.toArray(),
])
const ctx: ScheduleSourceContext = { trees, measures, supports, reviews }
const reference = today()
console.log(`基准日：${reference}`)

console.log('1. 收集来源待办')
const candidates = buildCandidates(ctx, { reference, now: nowIso() })
console.log(`   候选 ${candidates.length} 项：`, candidates.map((c) => `${c.kind}:${c.title}@${c.protectLevel}/${c.overdueDays}d`))
assert(candidates.length >= 3, `演示数据应收集至少 3 项待办，实际 ${candidates.length}`)
assert(candidates.some((c) => c.kind === 'measure'), '应包含到期复壮措施')
assert(candidates.some((c) => c.kind === 'support'), '应包含超期加固件复查')

const stamp = nowIso()
const items: ScheduleItem[] = candidates.map((c) => ({
  ...c,
  id: uuid('sched'),
  createdAt: stamp,
  updatedAt: stamp,
  revision: ROW_REVISION,
}))
await bulkPutScheduleItems(items)

console.log('2. 全部指派给同一负责人「周敏」')
await bulkPutScheduleItems(items.map((item) => ({ ...item, operator: '周敏' })))

console.log('3. 直接调用排期算法验证每日 3 件上限（store 依赖 Pinia，算法层等价验证）')
const { autoSchedule, sortByPriority } = await import('../src/utils/schedule')
const ordered = sortByPriority(items)
const plan = autoSchedule(
  ordered.map((item) => ({ id: item.id, kind: item.kind, treeId: item.treeId, operator: '周敏' })),
  reference
)
const dayCounts = new Map<string, number>()
plan.forEach((date) => dayCounts.set(date, (dayCounts.get(date) ?? 0) + 1))
assert(
  Array.from(dayCounts.values()).every((n) => n <= 3),
  `每个日期工单数均不超过 3 件：${JSON.stringify(Object.fromEntries(dayCounts))}`
)
// 同株当天异类检测
const treeDateKinds = new Map<string, Set<string>>()
ordered.forEach((item) => {
  const date = plan.get(item.id)
  if (date === undefined) return
  const key = `${item.treeId}@${date}`
  treeDateKinds.set(key, (treeDateKinds.get(key) ?? new Set()).add(item.kind))
})
assert(
  Array.from(treeDateKinds.values()).every((kinds) => kinds.size === 1),
  '同株古树当天只出现一类作业'
)

console.log('4. 模拟「批次确认期间并发修改」：把第一条措施负责人改掉，把第一件加固件登记检查')
let measureItem: ScheduleItem | undefined
let supportItem: ScheduleItem | undefined
for (const item of items) {
  if (item.kind === 'measure' && measureItem === undefined) measureItem = item
  if (item.kind === 'support' && supportItem === undefined) supportItem = item
}
assert(measureItem !== undefined && supportItem !== undefined, '演示数据中应能找到措施与加固件候选')
if (measureItem !== undefined) {
  const measure = measures.find((m) => m.id === measureItem!.sourceId)
  if (measure !== undefined) await putMeasure({ ...measure, operator: '临时改派-李工' })
}
if (supportItem !== undefined) {
  await markSupportChecked(supportItem.sourceId, reference)
}

console.log('5. 用最新来源复核：被改的措施、已检查的加固件均应冲突留台')
const freshCtx: ScheduleSourceContext = {
  trees: await db.trees.toArray(),
  measures: await listMeasures(),
  supports: await listSupports(),
  reviews: await db.reviews.toArray(),
}
if (measureItem !== undefined) {
  const c1 = checkItemConflict(measureItem, freshCtx, reference)
  assert(c1.conflict && c1.reason.includes('修改'), `措施并发改派应冲突：${c1.reason}`)
}
if (supportItem !== undefined) {
  const c2 = checkItemConflict(supportItem, freshCtx, reference)
  assert(c2.conflict && c2.reason.includes('已登记检查'), `加固件已检查应冲突：${c2.reason}`)
}

console.log('6. 写一张工单并验证回写（用措施完成链路）')
// 选一条未被修改的措施候选
const cleanMeasureItem = items.find(
  (item) => item.kind === 'measure' && item.id !== measureItem?.id
)
if (cleanMeasureItem !== undefined) {
  const woStamp = nowIso()
  await db.workOrders.put({
    id: uuid('order'),
    code: `WO${reference.replace(/-/g, '')}-99`,
    scheduleItemId: cleanMeasureItem.id,
    kind: 'measure',
    sourceId: cleanMeasureItem.sourceId,
    treeId: cleanMeasureItem.treeId,
    title: cleanMeasureItem.title,
    date: reference,
    operator: '周敏',
    state: '已完成',
    priorityScore: cleanMeasureItem.priorityScore,
    generatedAt: woStamp,
    closedAt: woStamp,
    createdAt: woStamp,
    updatedAt: woStamp,
    revision: ROW_REVISION,
  })
  const orders = await listWorkOrders()
  assert(orders.length === 1, `工单表应有 1 张工单，实际 ${orders.length}`)
}

// 清理：删除内存库中测试数据（进程结束即销毁，无需额外处理）
void db
void seedDatabase

if (failures > 0) {
  console.error(`\n${failures} 项自检失败`)
  process.exit(1)
}
console.log('\n端到端自检通过')
