<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import AccountCard from '../components/AccountCard.vue';
import ServerForm from '../components/ServerForm.vue';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();

const remembered = computed(() => [...(store.config?.accounts || [])].sort((a, b) => b.lastUsed - a.lastUsed));

watch(remembered, xs => xs.forEach(a => void store.loadCounts(a.accountId)), { immediate: true });

onMounted(async () => {
  if (!store.ready) await store.init();
  if (store.account) router.replace('/');
});

async function use(accountId: string): Promise<void> {
  if (await store.switchTo(accountId)) router.replace('/');
}
</script>

<template>
  <div class="wrap">
    <div class="panel">
      <h1>连接服务器</h1>
      <p class="hint">地址、账号和密码只保存在本机配置里。</p>

      <ServerForm @done="router.replace('/')" />

      <div v-if="remembered.length" class="saved">
        <div class="saved-t">已保存的账号</div>
        <AccountCard v-for="a in remembered" :key="a.accountId" :account="a" :counts="store.counts[a.accountId]" @select="use(a.accountId)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  height: 100%;
  padding-top: var(--titlebar-h);
  display: grid;
  place-items: center;
}
.panel {
  width: 380px;
  max-height: calc(100% - 24px);
  overflow-y: auto;
  padding: 30px 30px 26px;
  border-radius: var(--r-panel);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}
h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 650;
  letter-spacing: -0.2px;
  color: var(--text);
}
.hint {
  margin: 6px 0 20px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
}
.saved {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  display: grid;
  gap: 8px;
}
.saved-t {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
}
</style>
