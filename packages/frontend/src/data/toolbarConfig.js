// Per-page contextual toolbar buttons.
//   navigateTo: '<route>'  → router navigation
//   action: '<id>'         → dispatched to the page via the toolbar bus (real handler)
//   todo: true             → feature not built yet; honest "coming soon" toast (no fake success)
export const toolbarConfig = {
  dashboard: [
    { icon: '⏸', label: 'Pause All', action: 'dash_pauseAll' },
    { icon: '▶', label: 'Resume All', action: 'dash_resumeAll' },
    { icon: '📊', label: 'Export Report', action: 'dash_export' },
  ],
  registry: [
    { icon: '➕', label: 'New Adapter', navigateTo: 'wizard' },
    { icon: '📤', label: 'Export', action: 'reg_export' },
    { icon: '📋', label: 'Clone Selected', todo: true },
    { icon: '📥', label: 'Import Config', todo: true },
  ],
  studio: [
    { icon: '➕', label: 'New Connector', action: 'studio_new' },
    { icon: '📥', label: 'Import Spec', todo: true },
    { icon: '📋', label: 'Clone Template', todo: true },
  ],
  monitor: [
    { icon: '📤', label: 'Export Logs', action: 'mon_export' },
    { icon: '🔄', label: 'Clear Filters', action: 'mon_clearFilters' },
    { icon: '⚡', label: 'Toggle Real-time', action: 'mon_toggleRealtime' },
  ],
  canvas: [
    { icon: '🤖', label: 'Auto-Map', action: 'canvas_autoMap' },
    { icon: '✖', label: 'Clear All', action: 'canvas_clearAll' },
    { icon: '💾', label: 'Save', action: 'canvas_save' },
    { icon: '✓', label: 'Validate', todo: true },
    { icon: '↩', label: 'Undo', todo: true },
    { icon: '↪', label: 'Redo', todo: true },
  ],
  vault: [
    { icon: '➕', label: 'Add Credential', action: 'vault_add' },
    { icon: '📤', label: 'Export Audit', action: 'vault_export' },
    { icon: '🔄', label: 'Rotate Expiring', todo: true },
  ],
  alerts: [
    { icon: '✓', label: 'Acknowledge All', todo: true },
    { icon: '⬆', label: 'Escalate Selected', todo: true },
    { icon: '🔇', label: 'Mute 1hr', todo: true },
  ],
  catalog: [
    { icon: '📤', label: 'Export Catalog', action: 'catalog_export' },
    { icon: '➕', label: 'New Entity', todo: true },
    { icon: '🔗', label: 'Merge Entities', todo: true },
  ],
  admin: [
    { icon: '➕', label: 'Add User', action: 'admin_addUser' },
    { icon: '📤', label: 'Export List', action: 'admin_export' },
    { icon: '📥', label: 'Import Users', todo: true },
  ],
  wizard: [],
  connected: [],
  push: [],
};
