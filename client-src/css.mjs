export const CSS = `
/* ---------------------------------------------------------------- shell */
.mvp_page{box-sizing:border-box;width:100%;height:100%;min-height:0;flex-direction:column;display:flex;overflow-y:auto;padding-bottom:24px}

/* --------------------------------------------------------------- header */
.mvp_head{flex:none;align-items:center;gap:12px;padding:2px 0 10px;display:flex;flex-wrap:wrap}
.mvp_headMain{flex:1;min-width:0;align-items:baseline;gap:10px;display:flex;flex-wrap:wrap}
.mvp_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.mvp_summary{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.mvp_summary--dim{color:var(--dsw-alias-label-tertiary)}
.mvp_headActions{flex:none;align-items:center;gap:6px;display:flex;flex-wrap:wrap}
.mvp_about{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);margin-bottom:10px;padding:8px 12px;background:transparent;background:color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent)}
.mvp_aboutP{color:var(--dsw-alias-label-secondary);margin:0 0 6px;font-size:12px;line-height:18px}
.mvp_aboutP:last-child{margin-bottom:0}

/* -------------------------------------------------------------- buttons */
.mvp_button{box-sizing:border-box;height:26px;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 9px;font-family:inherit;font-size:12px;line-height:18px}
.mvp_button--quiet{color:var(--dsw-alias-label-secondary);border-color:transparent}
.mvp_button--quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.mvp_button--accent{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent)}
.mvp_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mvp_button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_button:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.6}

/* ---------------------------------------------------------------- usage */
.mvp_usage{flex:none;color:var(--dsw-alias-label-secondary);align-items:center;gap:3px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);padding:4px 0;font-size:12px;line-height:18px;display:flex;flex-wrap:wrap}
/* A permanent second line prevents a scan/export/error from moving every model below it.
   Use scrollable overflow rather than clipping a long diagnostic at narrow widths / large text. */
.mvp_usageStatus{display:flex;flex:0 0 100%;height:1.6em;min-height:1.6em;min-width:0;overflow:auto;align-items:baseline;gap:0 1em;line-height:1.5;font-size:11px;scrollbar-width:thin;color:var(--dsw-alias-label-secondary)}
.mvp_usageStatusText{flex:none;white-space:nowrap}
.mvp_usage--off{color:var(--dsw-alias-label-tertiary)}
.mvp_usageLabel{color:var(--dsw-alias-label-tertiary);align-items:baseline;gap:6px;flex:none;display:inline-flex}
.mvp_usageComputing{color:var(--dsw-alias-brand-primary);font-size:11px}
.mvp_usageRanges{flex:1;min-width:0;align-items:baseline;gap:16px;display:flex;flex-wrap:wrap}
.mvp_stat{align-items:baseline;gap:5px;display:inline-flex;white-space:nowrap}
/* The dash on a cold read and the formatted count on the next read take the same slot. */
.mvp_usageRanges .mvp_statValue{display:inline-block;min-inline-size:5.2ch}
.mvp_statLabel{color:var(--dsw-alias-label-tertiary);font-size:11px}
.mvp_statValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-size:13px;font-weight:500}
.mvp_stat--total .mvp_statValue{color:var(--dsw-alias-brand-primary)}
.mvp_usageActions{flex:none;align-items:center;gap:4px;display:flex}
.mvp_usageHint{width:100%;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mvp_usageHint--warn{color:var(--dsw-alias-state-error-primary)}

/* --------------------------------------------------------------- filters */
.mvp_filters{flex:none;align-items:center;gap:8px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:8px 0;display:flex;flex-wrap:wrap}
.mvp_searchInput{box-sizing:border-box;flex:1 1 180px;min-width:150px;max-width:320px;height:26px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 8px;font-family:inherit;font-size:12px}
.mvp_searchInput:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.mvp_filterGroup{align-items:center;gap:4px;display:flex;flex-wrap:wrap}
.mvp_filterGroup--push{margin-left:auto}
.mvp_filter{box-sizing:border-box;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 9px;font-family:inherit;font-size:11px;line-height:16px}
.mvp_filter[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, transparent)}
.mvp_filter:hover:not([aria-pressed="true"]){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}
.mvp_filter:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_contextSelect{box-sizing:border-box;height:24px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;font-family:inherit;font-size:11px}

/* ------------------------------------------------------- applyInput row */
.mvp_applyRow{flex:none;align-items:center;gap:10px;border-bottom:.5px solid var(--dsw-alias-border-l1);padding:8px 0;display:flex}
.mvp_applyText{flex:1;min-width:0;align-items:baseline;gap:8px;display:flex;flex-wrap:wrap}
.mvp_applyTitle{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.mvp_applyHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}

/* --------------------------------------------------------------- banners */
.mvp_banner{flex:none;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);margin:8px 0;padding:6px 10px;font-size:12px;line-height:18px}
.mvp_banner--warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, transparent)}
.mvp_banner--error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent)}
.mvp_note{flex:none;color:var(--dsw-alias-label-tertiary);padding:6px 0;font-size:11px;line-height:16px}

/* ---------------------------------------------------------------- groups */
.mvp_groups{flex:none;flex-direction:column;display:flex}
.mvp_group{flex:none;flex-direction:column;display:flex}
.mvp_groupHead{justify-content:space-between;align-items:center;gap:12px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:10px 0 6px;display:flex}
.mvp_groupTitle{flex:1;min-width:0;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:0;align-items:baseline;column-gap:8px;row-gap:2px;padding:0;font-family:inherit;font-size:13px;font-weight:500;line-height:20px;display:flex;flex-wrap:wrap}
.mvp_groupTitle:hover .mvp_groupName{color:var(--dsw-alias-brand-primary)}
.mvp_groupTitle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.mvp_chevron{flex:none;align-self:center;width:12px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}
.mvp_groupName{min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.mvp_groupCount{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;font-variant-numeric:tabular-nums}
.mvp_groupCap{color:var(--dsw-alias-label-tertiary);align-items:baseline;gap:3px;font-size:11px;font-weight:400;display:inline-flex}
.mvp_sep{opacity:.5}
.mvp_kindCount{font-variant-numeric:tabular-nums}
.mvp_kindCount--image{color:var(--dsw-alias-state-business-primary)}
.mvp_kindCount--video{color:var(--dsw-alias-state-success-primary)}
.mvp_kindCount--other{color:var(--dsw-alias-state-warn-primary)}
.mvp_groupProbe{color:var(--dsw-alias-label-tertiary);border:.5px dashed var(--dsw-alias-border-l2);border-radius:4px;max-width:100%;white-space:nowrap;text-overflow:ellipsis;padding:0 5px;font-size:10px;line-height:15px;overflow:hidden}
.mvp_groupProbe--warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}

/* ------------------------------------------------------------------ rows */
.mvp_row{justify-content:space-between;align-items:center;gap:16px;border-bottom:.5px solid var(--dsw-alias-border-l1);padding:8px 0 8px 6px;display:flex}
.mvp_row--off .mvp_rowTitle{color:var(--dsw-alias-label-secondary)}
.mvp_visibilityLabel{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500}
.mvp_row--gen{background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 3%, transparent)}
.mvp_row--kind-image{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-business-primary) 70%, transparent)}
.mvp_row--kind-video{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, transparent)}
.mvp_row--kind-embedding{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-warn-primary) 70%, transparent)}
.mvp_row--kind-rerank{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-error-primary) 60%, transparent)}
.mvp_row--kind-audio{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-state-error-primary))}
.mvp_row--kind-classifier{box-shadow:inset 2px 0 0 color-mix(in srgb, var(--dsw-alias-state-error-secondary) 60%, transparent)}
.mvp_row--kind-translation{box-shadow:inset 2px 0 0 var(--dsw-alias-border-l2)}
.mvp_rowText{flex-direction:column;gap:3px;min-width:0;display:flex}
.mvp_rowHead{align-items:baseline;gap:8px;min-width:0;display:flex;flex-wrap:wrap}
.mvp_rowTitle{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.mvp_rowMeta{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:100%;font-size:11px;line-height:18px;overflow:hidden}
.mvp_rowActions{flex:none;align-items:center;gap:6px;display:flex}
.mvp_editButton{height:24px;padding:0 8px;font-size:11px}

/* ---------------------------------------------------------------- switch */
.mvp_switch{position:relative;flex:none;box-sizing:border-box;width:34px;height:19px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background-color .15s ease}
.mvp_switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.mvp_switch:disabled{opacity:.45;cursor:default}
.mvp_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mvp_thumb{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px var(--dsw-alias-border-l2);transition:transform .15s ease}
.mvp_switch[aria-checked="true"] .mvp_thumb{transform:translateX(15px)}
.mvp_switch[aria-checked="false"] .mvp_thumb{background:var(--dsw-alias-label-secondary)}

/* ------------------------------------------------------------------ tags */
.mvp_tags{flex-wrap:wrap;align-items:center;gap:4px;display:flex}
.mvp_tag{box-sizing:border-box;max-width:100%;height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;align-items:center;padding:0 5px;font-size:10px;line-height:15px;display:inline-flex;overflow:hidden;text-overflow:ellipsis}
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

/* --------------------------------------------------------------- editor */
.mvp_editor{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);margin:4px 0 8px;padding:10px 12px;background:transparent;background:color-mix(in srgb, var(--dsw-alias-label-primary) 2%, transparent)}
.mvp_editorHead{margin-bottom:8px}
.mvp_editorTitle{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.mvp_editorSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mvp_editorGrid{flex-wrap:wrap;align-items:flex-start;gap:8px 14px;display:flex}
.mvp_field{flex-direction:column;gap:3px;min-width:140px;display:flex}
.mvp_field--wide{flex:1 1 100%}
.mvp_fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mvp_select,.mvp_number{box-sizing:border-box;height:26px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 6px;font-family:inherit;font-size:12px}
.mvp_chips{flex-wrap:wrap;gap:4px;display:flex}
.mvp_chip{box-sizing:border-box;height:23px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 9px;font-family:inherit;font-size:11px}
.mvp_chip[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, transparent)}
.mvp_chip:disabled{opacity:.45;cursor:default}
.mvp_check{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;font-size:12px;line-height:18px;display:inline-flex;cursor:pointer}
.mvp_editorNote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mvp_editorError{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;margin-top:6px}
.mvp_editorFooter{justify-content:space-between;align-items:flex-end;gap:12px;margin-top:10px;display:flex;flex-wrap:wrap}
.mvp_editorActions{align-items:center;gap:6px;display:flex}

/* -------- shared list, field sources, confirmation and status surfaces */
.mvp_page > *{min-width:0}
.mvp_modelBlock{flex:none;min-width:0}
.mvp_listTools{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:4px 0;font-size:12px}
.mvp_details{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
.mvp_details summary{cursor:pointer;width:fit-content;max-width:100%}
.mvp_details p,.mvp_preview p{margin:4px 0;line-height:1.55}
.mvp_listTools .mvp_details[open],.mvp_applyRow .mvp_details[open]{flex:1 1 100%}
.mvp_applyRow{flex-wrap:wrap}
.mvp_visibilityLabel,.mvp_factsButton{font-size:11px}
.mvp_factsButton{color:var(--dsw-alias-label-secondary);background:none;border:0;font-family:inherit;cursor:pointer;padding:1px 4px;text-decoration:underline;text-underline-offset:2px}
.mvp_facts{font-size:12px;color:var(--dsw-alias-label-secondary);padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}
.mvp_facts ul,.mvp_targetList{margin:4px 0;padding-inline-start:20px}
.mvp_sourcesLinks{display:flex;flex-wrap:wrap;gap:4px 12px}
.mvp_sourcesLinks a{color:var(--dsw-alias-brand-primary);overflow-wrap:anywhere}
.mvp_receipt{flex:none;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);border-inline-start:3px solid var(--dsw-alias-brand-primary);margin:6px 0;padding:5px 10px;overflow-wrap:anywhere}
.mvp_preview{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);border-inline-start:2px solid var(--dsw-alias-border-l2);margin-top:6px;padding:4px 10px;overflow-wrap:anywhere}
.mvp_editor{flex:none;min-width:0;overflow-wrap:anywhere}
.mvp_editorHead{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 8px}
.mvp_editorTitle{margin:0;font-weight:550}
.mvp_editor .mvp_field{box-sizing:border-box;max-width:100%;border:0;margin:0;padding:0;min-inline-size:0}
.mvp_editor .mvp_fieldLabel{color:var(--dsw-alias-label-secondary)}
.mvp_editor .mvp_editorActions,.mvp_dialog .mvp_editorActions{flex-wrap:wrap}
.mvp_editor .mvp_editorFooter{align-items:center;gap:8px 12px}
.mvp_editorNote{margin:4px 0}
.mvp_details summary:focus-visible,.mvp_factsButton:focus-visible,.mvp_sourcesLinks a:focus-visible,.mvp_editor :focus-visible,.mvp_dialog :focus-visible,.mvp_contextSelect:focus-visible,.mvp_usageStatus:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mvp_targetList{max-height:11rem;overflow:auto}
.mvp_dialog{box-sizing:border-box;width:min(32rem,calc(100% - 32px));max-height:80dvh;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:16px 20px;font:inherit;font-size:13px;line-height:1.55;overflow-wrap:anywhere}
.mvp_dialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-label-primary) 35%,transparent)}
.mvp_dialogTitle{font-size:15px;line-height:1.5;margin:0}
.mvp_dialog .mvp_editorActions{justify-content:flex-end;margin-top:12px}
.mvp_debug,.mvp_aboutPanel{flex:none;min-width:0}
@media(max-width:520px){.mvp_row{gap:5px}.mvp_rowActions{gap:3px}.mvp_searchInput{width:100%;max-width:none;flex-basis:100%}.mvp_groupHead{gap:5px}.mvp_editor{padding:8px}.mvp_usageRanges{gap:4px 7px}}
@media(prefers-reduced-motion:reduce){.mvp_thumb,.mvp_switch,.mvp_progressFill{transition:none}}

/* --------------------------------------------------------------- checker */
.mvp_checker{flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);margin-top:12px;overflow:hidden}
.mvp_checkerBar{display:flex;align-items:center;gap:6px;padding-right:4px}
.mvp_checkerBar .mvp_button{flex-shrink:0}
.mvp_checkerHead{box-sizing:border-box;flex:1;min-width:0;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:0;align-items:baseline;gap:4px 8px;padding:7px 10px;font-family:inherit;font-size:12px;line-height:18px;display:flex;flex-wrap:wrap}
.mvp_checkerHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mvp_checkerHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.mvp_checkerTitle{font-weight:500;flex:none}
.mvp_checkerSummary{color:var(--dsw-alias-label-secondary);flex:1 1 120px;min-width:0;font-size:11px;font-variant-numeric:tabular-nums}
.mvp_badge{flex:none;color:var(--dsw-alias-state-warn-primary);border:.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);border-radius:999px;padding:0 6px;font-size:10px;line-height:15px}
.mvp_checkerBody{border-top:.5px solid var(--dsw-alias-border-l2);padding:10px}
.mvp_checkerModes{min-inline-size:0;border:0;margin:0 0 6px;padding:0;display:flex;flex-wrap:wrap;gap:4px 6px}
.mvp_checkerModes legend{margin-bottom:4px;padding:0}
.mvp_checkerMode{align-items:center;gap:5px;display:inline-flex;padding:4px 8px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);cursor:pointer;font-size:12px;line-height:16px}
.mvp_checkerMode input{margin:0;accent-color:var(--dsw-alias-brand-primary)}
.mvp_checkerMode:has(input:checked){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent)}
.mvp_checkerMode:has(input:disabled){cursor:default;opacity:.75}
.mvp_checkerMode:has(input:focus-visible){outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_checkerHint{color:var(--dsw-alias-label-secondary);margin:0 0 8px;font-size:11px;line-height:16px}
.mvp_checkerForm,.mvp_checkerAdvanced{align-items:flex-end;gap:8px;display:flex;flex-wrap:wrap}
.mvp_checkerForm .mvp_field,.mvp_checkerAdvanced .mvp_field{min-width:0;max-width:100%}
.mvp_checkerForm .mvp_select,.mvp_checkerAdvanced .mvp_select{min-width:120px;max-width:100%}
.mvp_checkerAdvanced{padding:6px 0}
.mvp_checkerAdvanced .mvp_check{min-height:26px}
.mvp_checkerDetails{margin-top:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.mvp_checkerDetails summary{cursor:pointer;width:fit-content;max-width:100%}
.mvp_checkerDetails summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mvp_checkerOptionNote{color:var(--dsw-alias-state-warn-primary)}
.mvp_checkerNotice{box-sizing:border-box;margin-top:5px;overflow-wrap:anywhere}
.mvp_checkerBar + .mvp_checkerNotice{margin:0;padding:0 10px 6px}
.mvp_checkerProgress{align-items:center;gap:5px 10px;margin-top:8px;display:flex;flex-wrap:wrap}
.mvp_progressBar{flex:1 1 160px;min-width:120px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
.mvp_progressFill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s ease;display:block}
.mvp_checkerProgressText{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.mvp_checkerErrors{margin-top:10px}
.mvp_checkerErrorsTitle{color:var(--dsw-alias-state-warn-primary);margin-bottom:4px;font-size:11px;line-height:16px}
.mvp_errorList{max-height:150px;color:var(--dsw-alias-label-secondary);margin:0;padding-left:18px;font-size:11px;line-height:16px;overflow-y:auto}
.mvp_errorList li{margin-bottom:3px;overflow-wrap:anywhere}
.mvp_sources{margin-top:10px}
.mvp_sourcesTitle{color:var(--dsw-alias-label-tertiary);margin-bottom:4px;font-size:11px;line-height:16px}
.mvp_sourceList{max-height:150px;margin:0;padding:0;list-style:none;font-size:11px;line-height:16px;overflow-y:auto}
.mvp_sourceList li{flex-wrap:wrap;align-items:baseline;gap:6px;padding:2px 0;display:flex}
.mvp_sourceName{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mvp_sourceState{flex:none;border-radius:4px;padding:0 4px;font-size:10px;line-height:14px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.mvp_source--ok .mvp_sourceState{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)}
.mvp_source--bad .mvp_sourceState{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}
.mvp_sourceCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.mvp_sourceMsg{flex:1 1 100%;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}

/* ---------------------------------------------------------------- footer */
.mvp_footer{flex:none;align-items:center;gap:14px;color:var(--dsw-alias-label-tertiary);border-top:.5px solid var(--dsw-alias-border-l1);margin-top:12px;padding-top:8px;font-size:11px;line-height:16px;display:flex;flex-wrap:wrap}
.mvp_footerItem{min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
`
