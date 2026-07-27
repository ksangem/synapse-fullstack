// Per-page contextual toolbar buttons.
//   icon: key into the shared SVG set (components/ui/Icon.jsx) — the toolbar sits
//         directly under the topbar, so emoji here clashed with its line-art.
//   navigateTo: '<route>'  → router navigation
//   action: '<id>'         → dispatched to the page via the toolbar bus (real handler)
//   todo: true             → feature not built yet; honest "coming soon" toast (no fake success)
export const toolbarConfig = {
  dashboard: [
    { icon: 'pause', label: 'Pause All', action: 'dash_pauseAll' },
    { icon: 'play', label: 'Resume All', action: 'dash_resumeAll' },
    { icon: 'chart', label: 'Export Report', action: 'dash_export' },
  ],
  registry: [
    { icon: 'plus', label: 'New Integration', navigateTo: 'wizard' },
    { icon: 'upload', label: 'Export', action: 'reg_export' },
    { icon: 'copy', label: 'Clone Selected', todo: true },
    { icon: 'download', label: 'Import Config', todo: true },
  ],
  studio: [
    { icon: 'plus', label: 'New Connector', action: 'studio_new' },
    { icon: 'download', label: 'Import Spec', todo: true },
    { icon: 'copy', label: 'Clone Template', todo: true },
  ],
  /* Monitor deliberately has no toolbar actions. Export / Clear filters /
     Real-time each existed BOTH here and on the page, and the page versions are
     strictly better: the toggle shows its state, Export disables when there is
     nothing to export, and Clear filters appears only when a filter is on. */
  monitor: [],
  canvas: [
    { icon: 'wand', label: 'Auto-Map', action: 'canvas_autoMap' },
    { icon: 'close', label: 'Clear All', action: 'canvas_clearAll' },
    { icon: 'save', label: 'Save', action: 'canvas_save' },
    { icon: 'check', label: 'Validate', todo: true },
    { icon: 'undo', label: 'Undo', todo: true },
    { icon: 'redo', label: 'Redo', todo: true },
  ],
  vault: [
    { icon: 'plus', label: 'Add Credential', action: 'vault_add' },
    { icon: 'upload', label: 'Export Audit', action: 'vault_export' },
    { icon: 'refresh', label: 'Rotate Expiring', todo: true },
  ],
  alerts: [
    { icon: 'check', label: 'Acknowledge All', todo: true },
    { icon: 'escalate', label: 'Escalate Selected', todo: true },
    { icon: 'mute', label: 'Mute 1hr', todo: true },
  ],
  catalog: [
    { icon: 'upload', label: 'Export Catalog', action: 'catalog_export' },
    { icon: 'plus', label: 'New Entity', todo: true },
    { icon: 'link', label: 'Merge Entities', todo: true },
  ],
  admin: [
    { icon: 'plus', label: 'Add User', action: 'admin_addUser' },
    { icon: 'upload', label: 'Export List', action: 'admin_export' },
    { icon: 'download', label: 'Import Users', todo: true },
  ],
  wizard: [],
  connected: [],
  push: [],
};
