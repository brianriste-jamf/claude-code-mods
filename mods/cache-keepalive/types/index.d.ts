/** What the band line shows; `off` draws nothing. */
export type KeepaliveView =
  | { kind: 'off' }
  | { kind: 'busy' | 'cold'; pings: number; limit: number }
  | { kind: 'spent'; pings: number; limit: number; lapsesInMs: number }
  | { kind: 'waiting'; pings: number; limit: number; nextPingMs: number; warmForMs: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-keepalive': { view: KeepaliveView }
  }
}
