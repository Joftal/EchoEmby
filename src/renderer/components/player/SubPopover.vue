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
const props = defineProps<{ name: string; title: string }>();
const player = usePlayerStore();
const card = inject<Ref<HTMLElement | null>>('pl-sheet-card', ref(null));
const open = computed(() => player.sub === props.name);
</script>

<template>
  <Teleport :to="card || 'body'" defer>
    <Transition name="pl-sub">
      <div v-if="open" class="pl-sub" role="dialog" :aria-label="title">
        <div class="pl-head">
          <button class="ib" title="返回" @click="player.toggleSub('')">
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
