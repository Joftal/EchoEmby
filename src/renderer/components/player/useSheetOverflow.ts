import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/** A sheet whose list runs past its cap stops mid-row, and a row sliced in half with no scrollbar reads as
 *  a broken panel rather than as a list. Give this the ref of a sheet body and it watches the element,
 *  saying whether anything is still below the fold; the panel fades its bottom edge on that. */
export function useSheetOverflow(bodyEl: Ref<HTMLElement | null>): {
  more: Ref<boolean>;
  measure: () => void;
} {
  const more = ref(false);
  const measure = (): void => {
    const el = bodyEl.value;
    if (el) more.value = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
  };
  let watch: ResizeObserver | null = null;
  onMounted(() => {
    measure();
    watch = new ResizeObserver(measure);
    if (bodyEl.value) watch.observe(bodyEl.value);
  });
  onBeforeUnmount(() => watch?.disconnect());
  return { more, measure };
}
