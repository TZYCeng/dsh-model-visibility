export const CSS = `
.mvp_page{box-sizing:border-box;width:100%;height:100%;min-height:0;flex-direction:column;display:flex;overflow-y:auto;padding-bottom:24px}
.mvp_head{flex:none;flex-direction:column;gap:6px;padding:4px 0 14px;display:flex}
.mvp_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.mvp_desc{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}
.mvp_toolbar{border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;display:flex}
.mvp_summary{color:var(--dsw-alias-label-secondary);flex:1;min-width:0;font-size:12px;line-height:18px}
.mvp_actions{flex:none;align-items:center;justify-content:flex-end;gap:8px;display:flex;flex-wrap:wrap}
.mvp_button{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 10px;font-family:inherit;font-size:12px;line-height:18px}
.mvp_button--accent{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent)}
.mvp_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mvp_button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_button:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.mvp_group{flex:none;flex-direction:column;display:flex}
.mvp_groupHead{justify-content:space-between;align-items:center;gap:12px;padding:14px 0 6px;display:flex}
.mvp_groupTitle{color:var(--dsw-alias-label-primary);align-items:baseline;row-gap:2px;gap:8px;font-size:14px;font-weight:500;line-height:22px;display:flex;flex-wrap:wrap}
.mvp_groupName{min-width:0}
.mvp_collapse{box-sizing:border-box;flex:none;align-self:center;width:18px;height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:4px;justify-content:center;align-items:center;padding:0;font-family:inherit;font-size:11px;line-height:18px;display:inline-flex}
.mvp_collapse:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mvp_collapse:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_groupCount{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.mvp_row{border-bottom:.5px solid var(--dsw-alias-border-l1);justify-content:space-between;align-items:center;gap:16px;padding:10px 0;display:flex}
.mvp_row--gen{background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 4%, transparent)}
.mvp_row--kind-image{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-business-primary) 70%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 4%, transparent)}
.mvp_row--kind-video{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 4%, transparent)}
.mvp_row--kind-embedding{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-warn-primary) 70%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 4%, transparent)}
.mvp_row--kind-rerank{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-error-primary) 60%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 3%, transparent)}
.mvp_row--kind-audio{box-shadow:inset 2px 0 0 color-mix(in srgb, color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-state-error-primary)) 70%, transparent);background:transparent;background:color-mix(in srgb, color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-state-error-primary)) 4%, transparent)}
.mvp_row--kind-classifier{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-error-secondary) 60%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-error-secondary) 3%, transparent)}
.mvp_row--kind-translation{box-shadow:inset 2px 0 0 var(--dsw-alias-border-l2)}
.mvp_rowText{flex-direction:column;gap:2px;min-width:0;display:flex}
.mvp_rowTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.mvp_rowMeta{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}
.mvp_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:6px 0}
.mvp_switch{position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background-color .15s ease}
.mvp_switch[aria-checked="true"]{background:var(--dsw-alias-bg-base)}
.mvp_switch:disabled{opacity:.45;cursor:default}
.mvp_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mvp_thumb{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background-color .15s ease}
.mvp_switch[aria-checked="true"] .mvp_thumb{background:var(--dsw-alias-label-primary);transform:translateX(16px)}
.mvp_tags{flex-wrap:wrap;align-items:center;gap:4px;margin-top:4px;display:flex}
.mvp_tag{box-sizing:border-box;max-width:100%;height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;align-items:center;padding:0 6px;font-size:11px;line-height:16px;display:inline-flex;overflow:hidden;text-overflow:ellipsis}
.mvp_tag--accent{color:var(--dsw-alias-brand-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent)}
.mvp_tag--vision{color:var(--dsw-alias-state-business-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)}
.mvp_tag--kind{font-weight:500}
.mvp_tag--kind-image{color:var(--dsw-alias-state-business-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent)}
.mvp_tag--kind-video{color:var(--dsw-alias-state-success-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent)}
.mvp_tag--kind-embedding{color:var(--dsw-alias-state-warn-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent)}
.mvp_tag--kind-rerank{color:var(--dsw-alias-state-error-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent)}
.mvp_tag--kind-audio{color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-state-error-primary));background:transparent;background:color-mix(in srgb, color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-state-error-primary)) 12%, transparent);border-color:color-mix(in srgb, color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-state-error-primary)) 50%, transparent)}
.mvp_tag--kind-classifier{color:var(--dsw-alias-state-error-secondary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-error-secondary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-secondary) 55%, transparent)}
.mvp_tag--kind-translation{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2)}
.mvp_tag--kind-unknown{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.mvp_tag--inferred{border-style:dashed}
.mvp_tag--muted{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l1)}
.mvp_groupCap{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;line-height:16px}
.mvp_kindCount--image{color:var(--dsw-alias-state-business-primary)}
.mvp_kindCount--video{color:var(--dsw-alias-state-success-primary)}
.mvp_kindCount--other{color:var(--dsw-alias-state-warn-primary)}
.mvp_applyRow{flex:none;align-items:flex-start;gap:10px;margin:8px 0 2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:8px 10px;display:flex;background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 4%, transparent)}
.mvp_applyText{flex-direction:column;gap:2px;min-width:0;display:flex}
.mvp_applyTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px}
.mvp_applyHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mvp_applyRow .mvp_switch{margin-top:1px}
.mvp_groupProbe{color:var(--dsw-alias-label-tertiary);border:.5px dashed var(--dsw-alias-border-l2);border-radius:4px;max-width:100%;white-space:nowrap;text-overflow:ellipsis;padding:0 5px;font-size:10px;line-height:15px;overflow:hidden}
.mvp_filters{align-items:center;gap:6px;padding:8px 0 2px;display:flex;flex-wrap:wrap}
.mvp_filterLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mvp_search{align-items:center;gap:6px;display:flex;min-width:220px;flex:1 1 220px}
.mvp_searchInput{box-sizing:border-box;width:100%;height:28px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 8px;font-family:inherit;font-size:12px;line-height:18px}
.mvp_searchInput:focus-visible,.mvp_contextSelect:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_context{align-items:center;gap:6px;display:flex}
.mvp_contextSelect{box-sizing:border-box;height:24px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 6px;font-family:inherit;font-size:11px;line-height:18px}
.mvp_filter{box-sizing:border-box;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 9px;font-family:inherit;font-size:11px;line-height:18px}
.mvp_filter:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mvp_filter[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)}
.mvp_filter:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_note{color:var(--dsw-alias-label-tertiary);flex:none;padding:6px 0 0;font-size:10px;line-height:15px}
.mvp_legend{color:var(--dsw-alias-label-tertiary);flex:none;padding:8px 0 2px;font-size:11px;line-height:16px}
.mvp_fallback{color:var(--dsw-alias-label-secondary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);border-radius:var(--dsw-radius-sm,6px);padding:6px 8px;font-size:11px;line-height:16px;margin-top:8px}
.mvp_rowActions{flex:none;align-items:center;gap:8px;display:flex}
.mvp_editButton{height:24px;padding:0 8px;font-size:11px;line-height:18px}
.mvp_editButton[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent)}
.mvp_editor{box-sizing:border-box;border:.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);border-radius:var(--dsw-radius-sm,6px);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 4%, transparent);margin:2px 0 12px;padding:10px 12px;flex-direction:column;gap:10px;display:flex}
.mvp_editorHead{flex-direction:column;gap:2px;display:flex}
.mvp_editorTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px}
.mvp_editorSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mvp_editorGrid{flex-wrap:wrap;align-items:flex-end;gap:10px 16px;display:flex}
.mvp_field{flex-direction:column;gap:4px;min-width:140px;display:flex}
.mvp_field--wide{flex:1 1 100%}
.mvp_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.mvp_select,.mvp_number{box-sizing:border-box;height:26px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 8px;font-family:inherit;font-size:12px;line-height:18px}
.mvp_number{width:180px}
.mvp_select:focus-visible,.mvp_number:focus-visible,.mvp_chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_chips{flex-wrap:wrap;align-items:center;gap:6px;display:flex}
.mvp_chip{box-sizing:border-box;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 10px;font-family:inherit;font-size:11px;line-height:18px}
.mvp_chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mvp_chip[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)}
.mvp_chip:disabled{opacity:.45;cursor:default}
.mvp_editorFooter{justify-content:space-between;align-items:center;gap:12px;display:flex;flex-wrap:wrap}
.mvp_editorNote{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px;flex:1 1 220px;min-width:0}
.mvp_check{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.mvp_check input{accent-color:var(--dsw-alias-brand-primary, #4c8dff);margin:0}
.mvp_editorActions{flex:none;align-items:center;gap:6px;display:flex;flex-wrap:wrap}
/* ---------------------------------------------------- usage & checker */

.mvp_usage {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border, transparent);
  border-radius: 10px;
  background: transparent;
  background: color-mix(in srgb, currentColor 4%, transparent);
}

.mvp_usage--off {
  opacity: 0.75;
}

.mvp_usageHead {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mvp_usageTitle {
  font-weight: 600;
  font-size: 12px;
}

.mvp_usageComputing {
  color: var(--dsw-alias-text-tertiary, currentColor);
  font-size: 11px;
}

.mvp_usageActions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.mvp_usageRanges {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.mvp_stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mvp_statLabel {
  font-size: 11px;
  color: var(--dsw-alias-text-tertiary, currentColor);
}

.mvp_statValue {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.mvp_stat--total .mvp_statValue {
  font-weight: 600;
}

.mvp_usageHint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--dsw-alias-text-tertiary, currentColor);
}

.mvp_usageHint--warn {
  color: var(--dsw-alias-danger, #d0605e);
}

.mvp_checker {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border, transparent);
  border-radius: 10px;
}

.mvp_checkerHead {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.mvp_checkerTitle {
  font-weight: 600;
  font-size: 12px;
}

.mvp_checkerSummary {
  margin-left: auto;
  font-size: 11px;
  color: var(--dsw-alias-text-tertiary, currentColor);
}

.mvp_checker--closed.mvp_checker {
  padding: 8px 12px;
}

.mvp_checkerBody {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mvp_checkerHint {
  font-size: 11px;
  color: var(--dsw-alias-text-tertiary, currentColor);
}

.mvp_checkerForm {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  max-width: 560px;
}

.mvp_checkerActions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mvp_checkerSwitchText {
  font-size: 12px;
}

.mvp_checkerProgress {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-text-secondary, currentColor);
}

`
