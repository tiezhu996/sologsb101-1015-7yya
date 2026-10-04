/**
 * 数据库升级自检：先建 v1 旧库写入无 revision 的古树，再用当前代码打开应自动升级到 v3，
 * 且旧数据保留、新表可用、行修订号被回填。
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { DB_SCHEMA_VERSION, db, initDatabase } from '../src/utils/db'

let failures = 0
function assert(cond: boolean, message: string): void {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

const old = new Dexie('gbheritagetree')
old.version(1).stores({
  trees: 'id, code, species, protectLevel, ageYears, createdAt',
  surveys: 'id, treeId, date',
  measures: 'id, treeId, type, state, date',
  supports: 'id, treeId, type, installDate',
  reviews: 'id, treeId, date, vigor',
})
await old.open()
await old.trees.put({
  id: 't-old',
  code: 'OLD-1',
  species: '国槐',
  protectLevel: '一级',
  ageYears: 300,
  createdAt: '2024-01-01T00:00:00Z',
})
await old.close()
console.log('旧 v1 数据库已建立（无 revision / updatedAt）')

await initDatabase()
assert(DB_SCHEMA_VERSION === 3, `当前结构版本应为 3，实际 ${DB_SCHEMA_VERSION}`)

const row = await db.trees.get('t-old')
assert(row !== undefined, '旧古树记录升级后仍保留')
assert(row?.lastMeasureDate === '', 'v2 迁移补齐 lastMeasureDate 缺省值')
assert(typeof row?.updatedAt === 'string' && row.updatedAt.length > 0, '回填 updatedAt')
assert(row?.revision === 2, `旧行经 v2 迁移 revision=2，实际 ${row?.revision}`)

// v3 新表可用
await db.scheduleItems.put({
  id: 'si-test',
  kind: 'measure',
  sourceId: 'm-x',
  treeId: 't-old',
  title: '测试',
  operator: '甲',
  fingerprint: 'x',
  protectLevel: '一级',
  overdueDays: 0,
  reviewRisk: 0,
  priorityScore: 0,
  rankOrder: 0,
  state: 'pending',
  plannedDate: '',
  conflictReason: '',
  collectedAt: '',
  scheduledAt: '',
  createdAt: '',
  updatedAt: '',
  revision: 3,
})
const si = await db.scheduleItems.get('si-test')
assert(si?.id === 'si-test', 'v3 新表 scheduleItems 可读写')
const woCount = await db.workOrders.count()
assert(woCount === 0, 'v3 新表 workOrders 已建立且为空')

// 索引可用
const byKind = await db.scheduleItems.where('kind').equals('measure').count()
assert(byKind === 1, 'scheduleItems.kind 索引可用')

if (failures > 0) {
  console.error(`\n${failures} 项自检失败`)
  process.exit(1)
}
console.log('\nv1 → v3 升级自检通过')
