/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LAZYORCH_URL?: string;
  readonly VITE_LAZYORCH_TOKEN?: string;
  readonly VITE_USE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
