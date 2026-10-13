<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Account } from '../../shared/types';
import { useAppStore } from '../stores/app';

const props = defineProps<{ account?: Account }>();
const emit = defineEmits<{ (e: 'done'): void }>();

const store = useAppStore();
const label = ref(props.account?.label || '');
const baseUrl = ref(props.account?.baseUrl || '');
const urlEl = ref<HTMLInputElement | null>(null);
const username = ref(props.account?.username || '');
const password = ref('');
const busy = ref(false);
const shake = ref(false);
const ping = ref<{ state: 'idle' | 'checking' | 'ok' | 'fail'; text: string }>({ state: 'idle', text: '' });

// An empty password is a valid submission: Emby users can exist without one, so the
// server decides. Only edit mode reads empty as "keep what is stored".
const canSubmit = computed(() => !!baseUrl.value.trim() && !!username.value.trim() && !busy.value);

let timer: number | null = null;
watch(baseUrl, () => {
  if (timer !== null) window.clearTimeout(timer);
  const raw = baseUrl.value.trim();
  if (!raw || raw === props.account?.baseUrl) {
    ping.value = { state: 'idle', text: '' };
    return;
  }
  ping.value = { state: 'checking', text: '正在连接…' };
  timer = window.setTimeout(async () => {
    const r = await window.echoemby.app.pingServer(raw);
    ping.value = r.ok && r.data ? { state: 'ok', text: `${r.data.serverName} · ${r.data.version}` } : { state: 'fail', text: String(r.error || '连不上').slice(0, 70) };
  }, 700);
});

onBeforeUnmount(() => {
  if (timer !== null) window.clearTimeout(timer);
});

onMounted(() => urlEl.value?.focus());

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  const a = props.account;
  const ok = a
    ? await store.update({ accountId: a.accountId, label: label.value.trim(), baseUrl: baseUrl.value, username: username.value, password: password.value || undefined })
    : await store.login(baseUrl.value, username.value, password.value);
  busy.value = false;
  if (ok) {
    password.value = '';
    emit('done');
    return;
  }
  shake.value = true;
  setTimeout(() => (shake.value = false), 420);
}
</script>

<template>
  <form class="form" :class="{ shake }" @submit.prevent="submit">
    <label v-if="account">
      <span>显示名称</span>
      <input v-model="label" type="text" placeholder="留空则用服务器名" maxlength="24" spellcheck="false" autocomplete="off" />
    </label>

    <label>
      <span>服务器地址</span>
      <input ref="urlEl" v-model="baseUrl" type="text" placeholder="https://media.example.com:8096" spellcheck="false" autocomplete="off" />
    </label>
    <p v-if="ping.state !== 'idle'" class="ping" :class="ping.state">{{ ping.text }}</p>

    <label>
      <span>用户名</span>
      <input v-model="username" type="text" placeholder="Emby 用户名" autocomplete="username" />
    </label>
    <label>
      <span>密码</span>
      <input v-model="password" type="password" :placeholder="account ? '不修改则留空' : '无密码可留空'" autocomplete="new-password" />
    </label>

    <p v-if="store.error" class="err">{{ store.error }}</p>

    <button class="go" type="submit" :disabled="!canSubmit">
      <span v-if="busy">{{ account ? '保存中…' : '连接中…' }}</span>
      <span v-else>{{ account ? '保存' : '连接' }}</span>
    </button>
  </form>
</template>

<style scoped>
.form.shake {
  animation: shake 0.42s var(--ease);
}
@keyframes shake {
  20%, 60% { transform: translate3d(-7px, 0, 0); }
  40%, 80% { transform: translate3d(7px, 0, 0); }
}
label {
  display: block;
  margin-bottom: 13px;
}
label span {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 6px;
  letter-spacing: 0.3px;
}
input {
  width: 100%;
  padding: 11px 13px;
  border-radius: var(--radius);
  background: #f4f4f7;
  border: 1px solid var(--line);
  outline: none;
  color: var(--text);
  transition: border-color var(--hov) var(--ease), box-shadow var(--hov) var(--ease),
    background var(--hov) var(--ease);
}
input::placeholder {
  color: var(--text-faint);
}
input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  background: #fff;
}
.ping {
  margin: -7px 0 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  min-height: 15px;
}
.ping.ok {
  color: var(--accent);
}
.ping.fail {
  color: var(--danger);
}
.err {
  color: var(--danger);
  font-size: 13px;
  margin: 4px 0 10px;
}
.go {
  width: 100%;
  margin-top: 6px;
  padding: 12px;
  border-radius: var(--radius);
  background: var(--ink);
  color: var(--on-ink);
  font-weight: 600;
  box-shadow: 0 10px 24px rgba(18, 18, 34, 0.18);
  transition: transform var(--hov) var(--ease-out), box-shadow var(--hov) var(--ease), opacity var(--hov) var(--ease);
}
.go:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 14px 30px rgba(18, 18, 34, 0.24);
}
.go:active:not(:disabled) {
  transform: scale(0.98);
}
.go:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
