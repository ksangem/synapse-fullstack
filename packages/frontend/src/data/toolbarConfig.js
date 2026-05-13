export const toolbarConfig = {
  dashboard: [
    { icon: '\u23F8', label: 'Pause All' },
    { icon: '\u25B6', label: 'Resume All' },
    { icon: '\uD83D\uDCCA', label: 'Export Report' },
  ],
  registry: [
    { icon: '\u2795', label: 'New Adapter', navigateTo: 'wizard' },
    { icon: '\uD83D\uDCCB', label: 'Clone Selected' },
    { icon: '\u23F8', label: 'Bulk Pause' },
    { icon: '\uD83D\uDCE5', label: 'Import Config' },
  ],
  studio: [
    { icon: '\u2795', label: 'New Connector' },
    { icon: '\uD83D\uDCE5', label: 'Import Spec' },
    { icon: '\uD83D\uDCCB', label: 'Clone Template' },
  ],
  monitor: [
    { icon: '\uD83D\uDCE4', label: 'Export Logs' },
    { icon: '\uD83D\uDD04', label: 'Clear Filters' },
    { icon: '\u26A1', label: 'Toggle Real-time' },
  ],
  canvas: [
    { icon: '\uD83E\uDD16', label: 'Auto-Map', action: 'autoMap' },
    { icon: '\u2716', label: 'Clear All', action: 'clearMappings' },
    { icon: '\u2713', label: 'Validate' },
    { icon: '\uD83D\uDCBE', label: 'Save Draft' },
    { icon: '\u21A9', label: 'Undo' },
    { icon: '\u21AA', label: 'Redo' },
  ],
  vault: [
    { icon: '\u2795', label: 'Add Credential' },
    { icon: '\uD83D\uDD04', label: 'Rotate Expiring' },
    { icon: '\uD83D\uDCE4', label: 'Export Audit' },
  ],
  alerts: [
    { icon: '\u2713', label: 'Acknowledge All' },
    { icon: '\u2B06', label: 'Escalate Selected' },
    { icon: '\uD83D\uDD07', label: 'Mute 1hr' },
  ],
  catalog: [
    { icon: '\u2795', label: 'New Entity' },
    { icon: '\uD83D\uDD17', label: 'Merge Entities' },
    { icon: '\uD83D\uDCE4', label: 'Export Catalog' },
  ],
  admin: [
    { icon: '\u2795', label: 'Add User' },
    { icon: '\uD83D\uDCE5', label: 'Import Users' },
    { icon: '\uD83D\uDCE4', label: 'Export List' },
  ],
  wizard: [],
  connected: [],
  push: [],
};
