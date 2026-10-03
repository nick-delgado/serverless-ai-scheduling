/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev server only: `off` disables the MSW mock API (src/mocks), so `/api` goes to the network. */
  readonly VITE_MOCK_API?: string;
}
