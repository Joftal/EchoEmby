<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Account } from '../../shared/types';
import AccountCard from '../components/AccountCard.vue';
import ServerForm from '../components/ServerForm.vue';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();

const sheet = ref<{ account?: Account } | null>(null);

/** Most recently used first, matching the order LoginView offers. */
const accounts = computed(() => [...(store.config?.accounts || [])].sort((a, b) => b.lastUsed - a.lastUsed));

watch(accounts, xs => xs.forEach(a => void store.loadCounts(a.accountId)), { immediate: true });

onMounted(async () => {
  if (!store.ready) await store.init();
  if (!store.account) router.replace('/login');
  window.addEventListener('keydown', onKey, true);
});

onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));

/* Capture phase, because the titlebar owns Esc as 「go home」 on the same window: in the bubble phase the
   sheet closed and the page navigated away with it. */
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !sheet.value) return;
  e.stopPropagation();
  sheet.value = null;
}

async function use(id: string): Promise<void> {
  if (store.config?.activeAccountId === id) {
    router.push('/');
    return;
  }
  if (await store.switchTo(id)) router.push('/');
}

async function remove(id: string): Promise<void> {
  const active = await store.remove(id);
  if (!active) router.replace('/login');
}
</script>

<template>
  <div class="page">
    <div class="col">
      <header class="head">
        <h1>服务器</h1>
        <button class="add" type="button" @click="sheet = {}">
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M12 5.5v13M5.5 12h13" />
          </svg>
          <span>添加服务器</span>
        </button>
      </header>

      <div class="list">
        <AccountCard
          v-for="a in accounts"
          :key="a.accountId"
          :account="a"
          :active="a.accountId === store.config?.activeAccountId"
          :counts="store.counts[a.accountId]"
          editable
          @select="use(a.accountId)"
          @edit="sheet = { account: a }"
          @remove="remove(a.accountId)"
        />
        <p v-if="!accounts.length" class="empty">还没有保存的服务器。</p>
      </div>
    </div>

    <Transition name="sheet">
      <div v-if="sheet" class="scrim" @click.self="sheet = null">
        <div class="dlg" role="dialog" aria-modal="true">
          <div class="sh">
            <b>{{ sheet.account ? '编辑服务器' : '添加服务器' }}</b>
            <button class="x" type="button" @click="sheet = null">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
              </svg>
            </button>
          </div>
          <ServerForm :account="sheet.account" @done="sheet = null" />
        </div>
      </div>
    </Transition>

    <Transition name="toast">
      <!-- The form reports its own failures in place, so the toast only covers switch/remove. -->
      <div v-if="store.error && !sheet" class="toast">{{ store.error }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.page {
  --side: clamp(10px, 1.8vw, 26px);
  --gutter: calc(var(--nav-w) + var(--side));
  position: relative;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  /* Only the left side pays for the overlay sidebar; padding the right the same way shoved the page off-centre. */
  padding: calc(var(--titlebar-h) + 22px) var(--side) 46px var(--gutter);
  transition: padding var(--rail-dur) var(--rail-ease);
}
.col {
  max-width: 1180px;
  margin: 0 auto;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 22px;
  margin-bottom: 20px;
}
h1 {
  margin: 0;
  font-size: clamp(22px, 2.6vw, 30px);
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--text);
}
.add {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 15px;
  border-radius: 999px;
  background: var(--ink);
  color: var(--on-ink);
  font-size: 13px;
  font-weight: 600;
  box-shadow: var(--shadow-sm);
  transition: transform var(--hov) var(--ease-out), box-shadow var(--hov) var(--ease);
}
.add:hover {
  transform: translate3d(0, -2px, 0);
  box-shadow: var(--shadow);
}
.add:active {
  transform: scale(0.97);
}
.add .ic {
  width: 14px;
  height: 14px;
}
/* auto-fit collapses the tracks no account fills, so two servers span the row instead of leaving a hole. */
.list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 14px;
  align-items: start;
}
/* The cards come out of the config read, so they land after the page carrying them has already arrived.
   Each one fades as it mounts instead of the grid filling in a single frame. */
.list > * {
  animation: fade-in 0.3s var(--ease) both;
}
.empty {
  padding: 26px 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
}
.scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(18, 18, 26, 0.24);
  backdrop-filter: blur(10px) saturate(160%);
}
.dlg {
  width: min(420px, 100%);
  padding: 18px 20px 20px;
  border-radius: var(--r-modal);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}
.sh {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.sh b {
  font-size: 14px;
  font-weight: 640;
  color: var(--text);
}
.x {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--chip);
  color: var(--text-dim);
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease);
}
.x:hover {
  background: var(--chip-hi);
  color: var(--text);
}
.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.22s var(--ease);
}
.sheet-enter-active .dlg,
.sheet-leave-active .dlg {
  transition: transform 0.34s var(--ease-out), opacity 0.22s var(--ease);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from .dlg,
.sheet-leave-to .dlg {
  opacity: 0;
  transform: translate3d(0, 16px, 0) scale(0.97);
}
</style>
