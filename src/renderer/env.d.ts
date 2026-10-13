/// <reference types="vite/client" />

import type { EchoEmbyApi } from '../shared/api';

declare global {
  interface Window {
    echoemby: EchoEmbyApi;
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const c: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default c;
}

export {};
