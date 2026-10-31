import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

/* How long a wait has to last before it earns a picture of itself.
 *  Measured on this machine: a page whose rows come from the disk cache renders its first frame with content
 *  in 89-112ms (浏览), and 0 frames of skeleton (首页/设置/详情/收藏). Everything under 120ms was therefore a
 *  shimmer that appeared and vanished inside one blink — the one thing worse than a slow page, because it says
 *  "loading" about a page that was never loading. Above the threshold the skeleton still does its job, since a
 *  real ask on this gateway is 450-550ms and 在看 is 1.8s. */
export const SKEL_MS = 120;

/* A skeleton's own delay, as a boolean that turns on only if the wait outlives `ms`.
 *  The skeleton keeps its place in the template's v-if chain — this gates its paint instead of its existence,
 *  because several pages put an empty-state branch right after the loading one, and pulling the loading branch
 *  out for 120ms would flash "没有内容" at every navigation. */
export function useSlowFlag(source: () => boolean, ms = SKEL_MS) {
  const live = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stop: (() => void) | null = null;
  /* The gate opens at mount, not at setup: a card's picture URL is a computed that reaches for fields declared
     further down the same setup body, so reading it while setup is still running throws「Cannot access before
     initialization」. Nothing is on screen yet at that point anyway. */
  onMounted(() => {
    stop = watch(
      source,
      (waiting) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (!waiting) {
          live.value = false;
          return;
        }
        timer = setTimeout(() => {
          timer = null;
          live.value = true;
        }, ms);
      },
      { immediate: true },
    );
  });
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
    timer = null;
    stop?.();
  });
  return live;
}
