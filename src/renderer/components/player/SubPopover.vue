<script setup lang="ts">
import { computed, inject, ref, type Ref } from 'vue';
import { ChevronLeft } from 'lucide-vue-next';
import { usePlayerStore } from '../../stores/player';

/** The second level of the card. It is declared inside the panel that offers it, next to the rows that
 *  open it, and teleported into the shared card so that the card can size itself to this list and retire
 *  the first level while it is up.
 *
 *  `name` rather than a `v-if` at the call site: the component has to stay mounted for its own leave
 *  transition to run, which is what lets a drill-in slide back out the way it came in. */
/** The optional `wide` keeps a drill-in at the width of the card's widest sheet. The card sizes itself to
 *  whatever is up, which is right for a list of rows; for a sheet whose own rows are short (弹幕样式) that
 *  would shrink the panel and snap it sideways on every drill-in and back. */
/** `back` is the sheet the arrow returns to when this one was opened from another drill-in rather than from
 *  the card itself: 「手动搜索」 goes back to 「弹幕轨道」, the list it was opened to fix, instead of throwing the
 *  whole card away. */
const props = defineProps<{ name: string; title: string; wide?: boolean; back?: string }>();
const player = usePlayerStore();
const card = inject<Ref<HTMLElement | null>>('pl-sheet-card', ref(null));
const open = computed(() => player.sub === props.name);
</script>

<template>
  <Teleport :to="card || 'body'" defer>
    <Transition name="pl-sub">
      <div v-if="open" class="pl-sub" :class="{ wide: props.wide }" role="dialog" :aria-label="title">
        <div class="pl-head">
          <button class="ib" title="返回" @click="player.toggleSub(props.back || '')">
            <ChevronLeft :size="18" />
          </button>
          <span class="pl-title">{{ title }}</span>
        </div>
        <div class="pl-body">
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
