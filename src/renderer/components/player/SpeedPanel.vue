<script setup lang="ts">
import PanelShell from './PanelShell.vue';
import { SPEED_STEPS, usePlayerStore } from '../../stores/player';

const player = usePlayerStore();
</script>

<template>
  <PanelShell title="播放速度">
    <div class="pl-chips">
      <button v-for="v in SPEED_STEPS" :key="v" class="pl-chip" :class="{ on: player.state.speed === v }" @click="player.cmd({ action: 'speed', value: v })">{{ v === 1 ? '原速' : `${v}×` }}</button>
    </div>
    <div class="pl-sep"></div>
    <div class="pl-sect">逐帧</div>
    <div class="pl-chips">
      <button class="pl-chip" @click="player.cmd({ action: 'frameStep', value: -1 })">← 一帧</button>
      <button class="pl-chip" @click="player.cmd({ action: 'frameStep', value: 1 })">一帧 →</button>
      <button class="pl-chip" @click="player.cmd({ action: 'restart' })">回到开头</button>
    </div>
  </PanelShell>
</template>
