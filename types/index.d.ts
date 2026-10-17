/** One finished review, as the band and `/second-opinion` show it. */
export type Review = {
  ok: boolean
  line: string
  details: string[]
  files: number
  lines: number
  model: string
  cost: number
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'second-opinion': { last: Review | null; isDismissed: boolean; isExpanded: boolean }
  }
}
