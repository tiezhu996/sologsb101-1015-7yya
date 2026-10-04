<script setup lang="ts">
/**
 * <WorkOrderTag> 当前工单标签
 * 被复壮措施台账、加固件页、复评页与养护总览消费：
 * 有已生成未完工工单时显示工单号、计划日期与负责人；无工单时显示占位。
 */
import { computed } from 'vue'
import { Tickets } from '@element-plus/icons-vue'
import type { WorkOrder } from '@/types/workOrder'
import { WORK_KIND_LABEL } from '@/types/workOrder'

const props = withDefaults(
  defineProps<{
    order?: WorkOrder | null
    /** 无工单时是否渲染「—」占位 */
    showEmpty?: boolean
    size?: 'default' | 'small'
  }>(),
  {
    order: null,
    showEmpty: true,
    size: 'small',
  }
)

const tooltip = computed<string>(() => {
  if (!props.order) return ''
  return `${WORK_KIND_LABEL[props.order.kind]} · ${props.order.plannedDate} · 负责人 ${props.order.operator}`
})
</script>

<template>
  <el-tooltip v-if="order" :content="tooltip" placement="top">
    <el-tag type="primary" :size="size === 'small' ? 'small' : 'default'" effect="light" class="work-order-tag">
      <el-icon class="work-order-tag__icon"><Tickets /></el-icon>
      <span>{{ order.code || '待生成工单号' }}</span>
      <span class="work-order-tag__date">{{ order.plannedDate }}</span>
    </el-tag>
  </el-tooltip>
  <span v-else-if="showEmpty" class="work-order-tag__empty">—</span>
</template>

<style scoped>
.work-order-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
}

.work-order-tag__icon {
  flex: none;
}

.work-order-tag__date {
  font-weight: 400;
  opacity: 0.78;
}

.work-order-tag__empty {
  color: #b3aa9c;
}
</style>
