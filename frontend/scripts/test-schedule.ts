import {
  buildScheduleCandidates,
  comparePriority,
  assignCandidates,
  reviewRisk,
  measureOverdueDays,
  reviewOverdueDays,
} from '../src/utils/schedule'
import type { Tree } from '../src/types/tree'
import type { Measure } from '../src/types/measure'
import type { Support } from '../src/types/support'
import type { Review } from '../src/types/review'
import { MAX_DAILY_PER_OPERATOR } from '../src/types/workOrder'

const ref = '2026-10-04'

const trees: Tree[] = [
  { id: 't1', code: '京-01-1', species: '国槐', protectLevel: '一级', ageYears: 300, location: '', owner: '', lastMeasureDate: '', createdAt: '', updatedAt: '', revision: 3 },
  { id: 't2', code: '京-02-1', species: '银杏', protectLevel: '二级', ageYears: 200, location: '', owner: '', lastMeasureDate: '', createdAt: '', updatedAt: '', revision: 3 },
  { id: 't3', code: '京-03-1', species: '侧柏', protectLevel: '三级', ageYears: 120, location: '', owner: '', lastMeasureDate: '', createdAt: '', updatedAt: '', revision: 3 },
]

const measures: Measure[] = [
  { id: 'm1', treeId: 't2', type: '施肥', date: '2026-09-01', material: '', operator: '赵鹏', state: '计划', createdAt: '', updatedAt: '', revision: 3 },
  { id: 'm2', treeId: 't1', type: '透气', date: '2026-10-10', material: '', operator: '王建军', state: '实施中', createdAt: '', updatedAt: '', revision: 3 },
  { id: 'mdone', treeId: 't3', type: '换土', date: '2026-09-01', material: '', operator: '李慧', state: '已完成', createdAt: '', updatedAt: '', revision: 3 },
]

const supports: Support[] = [
  // overdue ~1yr
  { id: 's1', treeId: 't3', type: '支撑杆', installDate: '2018-01-01', checkCycleMon: 12, lastCheckDate: '2025-05-01', createdAt: '', updatedAt: '', revision: 3 },
  // not overdue
  { id: 's2', treeId: 't1', type: '避雷', installDate: '2026-01-01', checkCycleMon: 24, lastCheckDate: '2026-05-01', createdAt: '', updatedAt: '', revision: 3 },
]

const reviews: Review[] = [
  { id: 'r1', treeId: 't1', date: '2026-08-01', vigor: '濒危', trend: '下降', conclusion: '', followUp: '抢救', createdAt: '', updatedAt: '', revision: 3 },
  { id: 'r2', treeId: 't2', date: '2026-09-01', vigor: '衰弱', trend: '持平', conclusion: '', followUp: '复壮', createdAt: '', updatedAt: '', revision: 3 },
  { id: 'r3', treeId: 't3', date: '2026-09-20', vigor: '旺盛', trend: '持平', conclusion: '', followUp: '', createdAt: '', updatedAt: '', revision: 3 },
]

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('风险等级:')
assert(reviewRisk('濒危', null).rank === 3, '濒危 = 3')
assert(reviewRisk('衰弱', '下降').rank === 3, '衰弱+下降 = 3')
assert(reviewRisk('衰弱', '好转').rank === 2, '衰弱+好转 = 2')
assert(reviewRisk('旺盛', null).rank === 0, '旺盛 = 0')

console.log('超期天数:')
assert(measureOverdueDays('2026-09-01', ref) === 33, '措施超期 33 天')
assert(measureOverdueDays('2026-10-10', ref) === 0, '未到期措施 = 0')
assert(reviewOverdueDays('2026-08-01', ref) === 64, '复评距今天数 64')

console.log('候选生成:')
const candidates = buildScheduleCandidates({
  trees,
  measures,
  supports,
  reviews,
  takenSourceKeys: new Set(),
  reference: ref,
})
const keys = candidates.map((c) => c.key).sort()
const expectedKeys = ['measure:m1', 'measure:m2', 'review:r1', 'review:r2', 'support:s1'].sort()
assert(JSON.stringify(keys) === JSON.stringify(expectedKeys), `候选集合 = ${keys.join(',')}`)
assert(
  !keys.includes('review:r3') && !keys.includes('support:s2') && !keys.includes('measure:mdone'),
  '已完成措施 / 周期内加固件 / 旺盛复评不入台'
)

console.log('优先级排序（保护级别 → 超期天数 → 复评风险）:')
const sorted = [...candidates].sort(comparePriority)
const top = sorted[0]
assert(top.treeId === 't1', `一级古树排最前，实际 ${top.treeId}`)
const t1Order = sorted.filter((c) => c.treeId === 't1').map((c) => c.key)
assert(t1Order[0] === 'review:r1', `一级古树内濒危复评优先于未到期措施，实际 ${t1Order.join('>')}`)

console.log('派单约束:')
// 构造 10 个候选都给同一天同一负责人偏好，验证日上限 3
const many = Array.from({ length: 10 }, (_, i) => ({
  key: `c${i}`,
  treeId: `tree${i}`,
  preferredOperator: '王建军',
}))
// 需要对应古树保护级别无关；assignCandidates 只用 key/treeId/preferred
const assignments = assignCandidates({
  candidates: many,
  operators: ['王建军', '李慧'],
  startDate: ref,
  horizonDays: 30,
})
const day1Wang = assignments.filter((a) => a.plannedDate === ref && a.operator === '王建军').length
assert(day1Wang === MAX_DAILY_PER_OPERATOR, `王建军首日恰好 ${MAX_DAILY_PER_OPERATOR} 件，实际 ${day1Wang}`)
const day1Total = assignments.filter((a) => a.plannedDate === ref).length
assert(day1Total === 6, `首日两人合计 6 件，实际 ${day1Total}`)

console.log('同株同日互斥:')
const sameTree = [
  { key: 'a', treeId: 'treeA', preferredOperator: '王建军' },
  { key: 'b', treeId: 'treeA', preferredOperator: '王建军' },
]
const two = assignCandidates({ candidates: sameTree, operators: ['王建军'], startDate: ref, horizonDays: 30 })
assert(two[0].plannedDate !== two[1].plannedDate, `同株两条作业分到不同日期：${two.map((t) => t.plannedDate).join(', ')}`)
const wangDay2 = two.filter((t) => t.operator === '王建军' && t.plannedDate === ref).length
assert(wangDay2 === 1, '首日同株只排 1 单')

console.log('占用去重:')
const again = buildScheduleCandidates({
  trees,
  measures,
  supports,
  reviews,
  takenSourceKeys: new Set(['measure:m1', 'support:s1']),
  reference: ref,
})
assert(!again.some((c) => c.key === 'measure:m1' || c.key === 'support:s1'), '已在台/工单中的来源不重复入台')

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
