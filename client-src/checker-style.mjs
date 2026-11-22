/** Modal stays inside the settings section; native top-layer placement avoids a portal or global DOM writes. */
export const CHECKER_CSS = `
.mvp_bulkSection{margin-top:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px}
.mvp_bulkSection .mvp_applyRow{border-bottom:0}
.mvp_bulkSection .mvp_switch[aria-disabled="true"]{opacity:.55;cursor:default}
.mvp_bulkDialog{box-sizing:border-box;width:min(38rem,calc(100% - 24px));max-height:calc(100% - 24px);max-height:min(82dvh,46rem);overflow:auto;overscroll-behavior:contain;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:0;font:inherit;font-size:13px;line-height:1.55;overflow-wrap:anywhere}
.mvp_bulkDialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-label-primary) 42%,transparent)}
.mvp_bulkContent{padding:16px 20px 4px}
.mvp_bulkContent h3{margin:0 0 4px;font-size:16px;line-height:1.45}
.mvp_bulkContent p{margin:0 0 10px;color:var(--dsw-alias-label-secondary)}
.mvp_bulkTerms{margin:8px 0 16px}
.mvp_bulkTerms dt{margin-top:8px;font-weight:600}
.mvp_bulkTerms dd{margin:0;color:var(--dsw-alias-label-secondary)}
.mvp_bulkActions{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.mvp_bulkActions .mvp_button{height:auto;min-height:30px;white-space:normal}
.mvp_bulkItems{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.mvp_bulkItems summary{cursor:pointer;max-width:100%;color:var(--dsw-alias-label-primary)}
.mvp_bulkItems ol{margin:6px 0;padding-inline-start:2em;max-height:12rem;overflow:auto;scrollbar-gutter:stable}
.mvp_bulkItems li{padding:3px 0}
.mvp_bulkItems summary:focus-visible,.mvp_bulkItems ol:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_bulkKey{font-weight:500;color:var(--dsw-alias-label-primary)}
.mvp_bulkMeta{font-size:12px;color:var(--dsw-alias-label-secondary)}
`