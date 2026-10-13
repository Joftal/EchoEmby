import { ref } from 'vue';
import { defineStore } from 'pinia';
import { emptyPlayerState, type PlayerState } from '../../shared/types';

export const usePlayerStore = defineStore('player', () => {
  const state = ref<PlayerState>(emptyPlayerState());
  const busy = ref(false);
  const error = ref('');
  let off: (() => void) | null = null;

  function attach(): void {
    if (off) return;
    off = window.echoemby.player.onState(s => {
      state.value = s;
    });
    void refresh();
  }

  function detach(): void {
    off?.();
    off = null;
  }

  async function refresh(): Promise<void> {
    state.value = await window.echoemby.player.state();
  }

  async function play(itemId: string): Promise<boolean> {
    busy.value = true;
    error.value = '';
    const r = await window.echoemby.player.play(itemId);
    busy.value = false;
    if (!r.ok) error.value = r.error || '无法开始播放';
    return !!r.ok;
  }

  async function cmd(action: string, value?: unknown): Promise<void> {
    const r = await window.echoemby.player.command({ action, value });
    if (!r.ok && r.error) error.value = r.error;
  }

  async function setFullscreen(on: boolean): Promise<void> {
    await window.echoemby.player.fullscreen(on);
  }

  async function close(): Promise<void> {
    await window.echoemby.player.close();
    state.value = emptyPlayerState();
  }

  return { state, busy, error, attach, detach, play, cmd, setFullscreen, close };
});
