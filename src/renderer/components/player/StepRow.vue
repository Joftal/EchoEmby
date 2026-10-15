<script setup lang="ts">
/** One knob as the reference draws it: the name on the left, − / the value / + on the right. The caller
 *  formats the value, because half of these read out a unit and the other half read out a word. */
const props = defineProps<{ label: string; text: string; canDown?: boolean; canUp?: boolean }>();
const emit = defineEmits<{ down: []; up: [] }>();
</script>

<template>
  <div class="pl-line">
    <span class="label">{{ props.label }}</span>
    <span class="pl-step">
      <button :disabled="props.canDown === false" @click="emit('down')">−</button>
      <span class="v">{{ props.text }}</span>
      <button :disabled="props.canUp === false" @click="emit('up')">+</button>
    </span>
  </div>
</template>

<style scoped>
button:disabled {
  opacity: 0.35;
}
</style>
