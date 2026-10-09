// The provider's WorkerEntrypoint adapter is unused by our fetch handlers.
// Keep the real OAuth provider and cryptography in Node-based protocol tests.
export class WorkerEntrypoint {}
Object.defineProperty(globalThis, 'Cloudflare', { value: { compatibilityFlags: { global_fetch_strictly_public: true } }, configurable: true });
