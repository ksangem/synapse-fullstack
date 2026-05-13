// ===== THEME =====
function initTheme() {
  const saved = localStorage.getItem('synapse-theme');
  if (saved === 'dark') {
    document.documentElement.className = 'dark-theme';
    document.getElementById('themeToggleBtn').innerHTML = '&#9790;';
  } else {
    document.documentElement.className = 'light-theme';
    document.getElementById('themeToggleBtn').innerHTML = '&#9788;';
  }
}
function toggleTheme() {
  const html = document.documentElement;
  if (html.classList.contains('light-theme')) {
    html.className = 'dark-theme';
    localStorage.setItem('synapse-theme', 'dark');
    document.getElementById('themeToggleBtn').innerHTML = '&#9790;';
  } else {
    html.className = 'light-theme';
    localStorage.setItem('synapse-theme', 'light');
    document.getElementById('themeToggleBtn').innerHTML = '&#9788;';
  }
}
initTheme();

// ===== TOAST =====
function showToast(msg) {
  const t = document.getElementById('toastNotif');
  document.getElementById('toastText').textContent = msg;
  t.style.transform = 'translateX(-50%) translateY(0)';
  setTimeout(() => { t.style.transform = 'translateX(-50%) translateY(80px)'; }, 2500);
}

// ===== FULLSCREEN =====
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}

// ===== DETAIL PANE =====
function openDetailPane(title, contentHTML, breadcrumb) {
  document.getElementById('dpTitle').textContent = title;
  document.getElementById('dpBody').innerHTML = contentHTML;
  const bc = document.getElementById('dpBreadcrumb');
  if (breadcrumb) { bc.innerHTML = breadcrumb; bc.style.display = 'block'; }
  else { bc.style.display = 'none'; }
  document.getElementById('detailPane').classList.add('open');
}

function closeDetailPane() {
  document.getElementById('detailPane').classList.remove('open');
}

// ===== CONTEXTUAL TOOLBAR =====
const toolbarConfig = {
  dashboard: [
    {icon:'\u23F8', label:'Pause All', action:"showToast('All adapters paused')"},
    {icon:'\u25B6', label:'Resume All', action:"showToast('All adapters resumed')"},
    {icon:'\uD83D\uDCCA', label:'Export Report', action:"showToast('Report exported')"}
  ],
  registry: [
    {icon:'\u2795', label:'New Adapter', action:"navigateTo('wizard')"},
    {icon:'\uD83D\uDCCB', label:'Clone Selected', action:"showToast('Clone ready')"},
    {icon:'\u23F8', label:'Bulk Pause', action:"showToast('Bulk pause applied')"},
    {icon:'\uD83D\uDCE5', label:'Import Config', action:"showToast('Import dialog opened')"}
  ],
  studio: [
    {icon:'\u2795', label:'New Connector', action:"showToast('New connector template')"},
    {icon:'\uD83D\uDCE5', label:'Import Spec', action:"showToast('Import spec dialog')"},
    {icon:'\uD83D\uDCCB', label:'Clone Template', action:"showToast('Template cloned')"}
  ],
  monitor: [
    {icon:'\uD83D\uDCE4', label:'Export Logs', action:"showToast('Logs exported')"},
    {icon:'\uD83D\uDD04', label:'Clear Filters', action:"showToast('Filters cleared')"},
    {icon:'\u26A1', label:'Toggle Real-time', action:"showToast('Real-time toggled')"}
  ],
  canvas: [
    {icon:'\uD83E\uDD16', label:'Auto-Map', action:'autoMap()'},
    {icon:'\u2716', label:'Clear All', action:'clearMappings()'},
    {icon:'\u2713', label:'Validate', action:"showToast('Mappings valid')"},
    {icon:'\uD83D\uDCBE', label:'Save Draft', action:"showToast('Draft saved')"},
    {icon:'\u21A9', label:'Undo', action:"showToast('Undo')"},
    {icon:'\u21AA', label:'Redo', action:"showToast('Redo')"}
  ],
  vault: [
    {icon:'\u2795', label:'Add Credential', action:"showToast('Add credential dialog')"},
    {icon:'\uD83D\uDD04', label:'Rotate Expiring', action:"showToast('Rotating expiring credentials')"},
    {icon:'\uD83D\uDCE4', label:'Export Audit', action:"showToast('Audit log exported')"}
  ],
  alerts: [
    {icon:'\u2713', label:'Acknowledge All', action:"showToast('All acknowledged')"},
    {icon:'\u2B06', label:'Escalate Selected', action:"showToast('Escalation sent')"},
    {icon:'\uD83D\uDD07', label:'Mute 1hr', action:"showToast('Muted for 1 hour')"}
  ],
  catalog: [
    {icon:'\u2795', label:'New Entity', action:"showToast('New entity form')"},
    {icon:'\uD83D\uDD17', label:'Merge Entities', action:"showToast('Merge wizard')"},
    {icon:'\uD83D\uDCE4', label:'Export Catalog', action:"showToast('Catalog exported')"}
  ],
  admin: [
    {icon:'\u2795', label:'Add User', action:"showToast('Add user dialog')"},
    {icon:'\uD83D\uDCE5', label:'Import Users', action:"showToast('Import users dialog')"},
    {icon:'\uD83D\uDCE4', label:'Export List', action:"showToast('User list exported')"}
  ],
  wizard: []
};

function updateToolbar(page) {
  const left = document.getElementById('toolbarLeft');
  const items = toolbarConfig[page] || [];
  left.innerHTML = items.map(i =>
    '<button class="toolbar-btn" onclick="'+i.action+'" title="'+i.label+'"><span class="tb-icon">'+i.icon+'</span> '+i.label+'</button>'
  ).join('');
}

// ===== NAVIGATION =====
function navigateTo(page) {
  // Close detail pane
  closeDetailPane();
  // Reset expanded rows
  document.querySelectorAll('.expandable-content.show').forEach(e => e.classList.remove('show'));
  // Scroll main content to top
  document.getElementById('mainContent').scrollTop = 0;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
  const nav = document.querySelector('.nav-item[data-page="' + page + '"]');
  if (nav) nav.classList.add('active');
  document.getElementById('notifDropdown').classList.remove('show');

  // Update contextual toolbar
  updateToolbar(page);

  // Render mapping if needed
  if (page === 'canvas') setTimeout(renderMappingCanvas, 100);
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
}

function toggleNotifications() {
  document.getElementById('notifDropdown').classList.toggle('show');
}

function toggleHelp() {
  document.getElementById('helpPanel').classList.toggle('open');
}

document.addEventListener('click', function(e) {
  const dd = document.getElementById('notifDropdown');
  if (dd.classList.contains('show') && !e.target.closest('.icon-btn') && !e.target.closest('.notification-dropdown')) {
    dd.classList.remove('show');
  }
  const sd = document.getElementById('searchDropdown');
  if (sd && sd.classList.contains('show') && !e.target.closest('.universal-search')) {
    sd.classList.remove('show');
  }
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    document.getElementById('searchDropdown').classList.remove('show');
    closeDetailPane();
  }
});

// ===== UNIVERSAL SEARCH =====
const searchData = {
  connectors: ['Dynamics 365 CRM','Jira Cloud','Keka HR','Ahrefs SEO','GSC API','Google Adwords','TFS','TARA Recruitment','Holiday Tracker','SharePoint Online','Excel Files','PostgreSQL','MySQL','SQL Server'],
  adapters: ['CRM Data Export','Project Task Sync','Leave Balance Sync','SEO Performance Pipeline','Ad Spend Report Export','Recruitment Pipeline Sync','TFS Build Pipeline Sync','SAP Data Warehouse Sync','eCommerce Order Sync','DevOps Notification Relay','Identity Federation Sync','ITSM Ticket Bridge','Marketing Lead Sync','Comms Analytics Pipeline','Search Index Pipeline'],
  entities: ['Issue','Sprint','Repository','Lead','Opportunity','Account','Invoice','Payment','Subscription','Employee','Department','Ticket','Asset'],
  help: ['Creating Your First Connector','Building an Integration','Understanding the Mapping Canvas','Managing Credentials','User Roles & Permissions','Monitoring & Alerting','Common Error Codes','Performance Tuning']
};

function handleUniversalSearch(query) {
  const dd = document.getElementById('searchDropdown');
  if (!query || query.length < 1) { dd.classList.remove('show'); return; }
  const q = query.toLowerCase();
  let html = '';
  const icons = { connectors: '&#127760;', adapters: '&#9881;', entities: '&#9871;', help: '&#10067;' };
  const pages = { connectors: 'studio', adapters: 'registry', entities: 'catalog', help: '' };
  for (const [cat, items] of Object.entries(searchData)) {
    const matches = items.filter(i => i.toLowerCase().includes(q));
    if (matches.length > 0) {
      html += '<div class="search-category-label">' + cat + '</div>';
      matches.slice(0, 4).forEach(m => {
        html += '<div class="search-result-item" onclick="navigateTo(\'' + pages[cat] + '\');document.getElementById(\'searchDropdown\').classList.remove(\'show\');document.getElementById(\'universalSearchInput\').value=\'\'"><span class="sri-icon">' + icons[cat] + '</span>' + m + '</div>';
      });
    }
  }
  if (!html) html = '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:.84rem">No results found</div>';
  dd.innerHTML = html;
  dd.classList.add('show');
}

// ===== HELP TABS =====
function switchHelpTab(tab, btn) {
  document.querySelectorAll('.help-tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('helpTabArticles').style.display = tab === 'articles' ? 'block' : 'none';
  const aiTab = document.getElementById('helpTabAI');
  aiTab.style.display = tab === 'ai' ? 'flex' : 'none';
}

// ===== AI CHAT =====
function askAI(question) {
  const msgs = document.getElementById('aiChatMessages');
  msgs.innerHTML += '<div class="ai-chat-msg user"><div class="ai-msg-bubble">' + question + '</div></div>';
  setTimeout(() => {
    const responses = {
      'How do I fix an OAuth token expiry?': 'To fix an expired OAuth token, navigate to <strong>Credential Vault</strong>, find the affected credential, and click <strong>Rotate</strong>. If the refresh token has also expired, you will need to re-authorize by clicking <strong>Re-authorize Credential</strong> in the alert detail panel.',
      'Explain AI auto-mapping': 'The AI Auto-Map feature analyzes source and destination field names, types, and sample data to automatically suggest field mappings. It uses semantic similarity and pattern matching to achieve 85-95% accuracy.',
      'How to set up retry policies?': 'Retry policies are configured in the Connection Wizard (Step 5). You can set: <strong>Max Retries</strong> (1-10), <strong>Retry Delay</strong>, <strong>Backoff Strategy</strong>, and <strong>Dead Letter Queue</strong>.'
    };
    const resp = responses[question] || 'That\'s a great question! Based on the Synapse documentation, I\'d recommend checking the relevant section in our help articles.';
    msgs.innerHTML += '<div class="ai-chat-msg bot"><div style="width:28px;height:28px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;color:#fff;font-size:.7rem;font-weight:700;flex-shrink:0">S</div><div class="ai-msg-bubble">' + resp + '</div></div>';
    msgs.scrollTop = msgs.scrollHeight;
  }, 800);
  msgs.scrollTop = msgs.scrollHeight;
}

function sendAIChat() {
  const input = document.getElementById('aiChatInput');
  if (!input.value.trim()) return;
  askAI(input.value.trim());
  input.value = '';
}

// ===== CONNECTOR STUDIO - CATEGORIES =====
const connectorCategories = {
  rest: { title: 'REST API Connectors', items: ['Dynamics 365 CRM', 'Google Ads API', 'Ahrefs API', 'GSC API', 'TARA Recruitment API', 'Jira Cloud API'] },
  saas: { title: 'SaaS Application Connectors', items: ['Keka HR', 'TARA Recruitment', 'TFS', 'Holiday Tracker', 'Ahrefs SEO'] },
  db: { title: 'Database Connectors', items: ['SQL Server', 'PostgreSQL', 'MySQL', 'MongoDB'] },
  file: { title: 'File Share Connectors', items: ['Excel Files', 'CSV Import', 'SharePoint Documents', 'Google Sheets'] },
  mq: { title: 'Message Queue Connectors', items: ['Azure Service Bus', 'RabbitMQ', 'AWS SQS'] },
  webhook: { title: 'Webhook Connectors', items: ['Generic Webhook', 'GitHub Webhooks', 'Stripe Webhooks'] },
  scrape: { title: 'Web Scraping Connectors', items: ['Generic Web Scraper', 'RSS Feed Reader'] }
};

let activeCategory = null;

function toggleConnectorCategory(catId, el) {
  document.querySelectorAll('.connector-card').forEach(c => c.style.borderColor = '');
  const panel = document.getElementById('connectorCategoryPanel');
  if (activeCategory === catId) { panel.style.display = 'none'; activeCategory = null; return; }
  activeCategory = catId;
  el.style.borderColor = 'var(--primary)';
  const cat = connectorCategories[catId];
  document.getElementById('connectorCategoryTitle').textContent = cat.title;
  document.getElementById('connectorCategoryItems').innerHTML = cat.items.map(item =>
    '<div class="connector-list-item" onclick="openConnectorForm(\'' + item + '\')"><span class="cli-dot"></span>' + item + '</div>'
  ).join('');
  panel.style.display = 'block';
}

function openConnectorForm(name) {
  document.getElementById('connectorNameInput').value = name;
  document.getElementById('connectorFormTitle').innerHTML = '&#127760; New Connector: ' + name + ' <span class="badge badge-info">Draft</span>';
  document.getElementById('connectorFormPanel').scrollIntoView({ behavior: 'smooth' });
}

function showPublishedConnectors() {
  let html = '';
  const connectors = [
    {name:'Dynamics 365 CRM',v:'v2.1',type:'REST API',date:'2026-03-20'},
    {name:'Jira Cloud',v:'v3.0',type:'REST API',date:'2026-03-18'},
    {name:'Keka HR',v:'v1.2',type:'SaaS Application',date:'2026-03-15'},
    {name:'Ahrefs SEO',v:'v1.0',type:'REST API',date:'2026-03-10'},
    {name:'TARA Recruitment',v:'v1.1',type:'REST API',date:'2026-03-05'},
    {name:'SharePoint Online',v:'v2.0',type:'REST API',date:'2026-02-28'},
    {name:'Excel Files',v:'v1.3',type:'File Share',date:'2026-02-20'},
    {name:'GSC API',v:'v1.0',type:'REST API',date:'2026-02-15'}
  ];
  connectors.forEach(c => {
    html += '<div class="published-connector-item" onclick="showVersionHistory(\'' + c.name + '\')"><div><strong>' + c.name + '</strong> <span class="badge badge-success clickable" onclick="event.stopPropagation();showVersionHistory(\'' + c.name + '\')">' + c.v + '</span><div style="font-size:.72rem;color:var(--text-dim)">' + c.type + ' | Published ' + c.date + '</div></div><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();showVersionHistory(\'' + c.name + '\')">&#128339; History</button></div>';
  });
  openDetailPane('Published Connectors', html, '<a onclick="navigateTo(\'studio\')">Connector Studio</a> &raquo; Published');
}

// ===== WIZARD =====
let wizardStep = 1;
function wizardNav(dir) {
  wizardStep += dir;
  if (wizardStep < 1) wizardStep = 1;
  if (wizardStep > 6) wizardStep = 6;
  updateWizard();
}
function updateWizard() {
  document.querySelectorAll('.wizard-step').forEach(s => s.style.display = 'none');
  const el = document.getElementById('wiz-step-' + wizardStep);
  if (el) el.style.display = 'block';
  document.querySelectorAll('.step').forEach((s, i) => {
    const n = i + 1;
    s.classList.remove('active', 'completed');
    if (n === wizardStep) s.classList.add('active');
    if (n < wizardStep) s.classList.add('completed');
  });
  document.getElementById('wizBack').disabled = wizardStep === 1;
  document.getElementById('wizNext').textContent = wizardStep === 6 ? 'Publish' : 'Next \u2192';
}

function selectWizCard(el, side) {
  const parent = el.closest('.grid-2 > div');
  parent.querySelectorAll('.connector-card').forEach(c => c.style.borderColor = 'var(--border)');
  el.style.borderColor = 'var(--primary)';
}

// ===== PASSWORD TOGGLE =====
function togglePassword(id) {
  const inp = document.getElementById(id);
  inp.type = inp.type === 'password' ? 'text' : 'password';
  if (inp.type === 'text') setTimeout(() => { inp.type = 'password'; }, 3000);
}

// ===== TEST CONNECTION =====
function testConnection(btn) {
  btn.textContent = 'Testing...';
  btn.disabled = true;
  setTimeout(() => {
    btn.innerHTML = '&#10003; Connected';
    btn.style.color = 'var(--success)';
    btn.style.borderColor = 'var(--success)';
  }, 1200);
}

// ===== MAPPING CANVAS (REDESIGNED) =====
const mappings = [
  { src: 'key', dest: 'ExternalId', confidence: 95, type: 'confirmed' },
  { src: 'summary', dest: 'Title', confidence: 92, type: 'confirmed' },
  { src: 'assignee.displayName', dest: 'AssignedTo', confidence: 87, type: 'manual' },
  { src: 'status.name', dest: 'Status', confidence: 95, type: 'confirmed' },
  { src: 'priority.name', dest: 'Priority', confidence: 90, type: 'confirmed' },
  { src: 'created', dest: 'CreatedDate', confidence: 88, type: 'manual' },
  { src: 'updated', dest: 'ModifiedDate', confidence: 85, type: 'manual' },
  { src: 'description', dest: 'Description', confidence: 72, type: 'pending' },
  { src: 'labels', dest: 'Tags', confidence: 68, type: 'pending' },
  { src: 'reporter.displayName', dest: 'Reporter', confidence: 82, type: 'manual' },
];

const sourceFields = [
  {name:'key',type:'string'},{name:'summary',type:'string'},{name:'assignee.accountId',type:'string'},
  {name:'assignee.displayName',type:'string'},{name:'status.name',type:'string'},{name:'priority.name',type:'string'},
  {name:'created',type:'datetime'},{name:'updated',type:'datetime'},{name:'description',type:'text'},
  {name:'labels',type:'array'},{name:'reporter.displayName',type:'string'}
];

const destFields = [
  {name:'Title',type:'string'},{name:'Description',type:'text'},{name:'AssignedTo',type:'string'},
  {name:'Status',type:'string'},{name:'Priority',type:'string'},{name:'CreatedDate',type:'date'},
  {name:'ModifiedDate',type:'date'},{name:'ExternalId',type:'string'},{name:'Tags',type:'string'},
  {name:'Reporter',type:'string'}
];

const pairColors = ['mp-c1','mp-c2','mp-c3','mp-c4','mp-c5','mp-c6','mp-c7','mp-c8','mp-c9','mp-c10'];
let selectedMappingField = null;
let mappingsActive = true;

function renderMappingCanvas() {
  const srcList = document.getElementById('sourceFieldsList');
  const destList = document.getElementById('destFieldsList');
  const centerCol = document.getElementById('mappingCenterCol');

  srcList.innerHTML = '';
  destList.innerHTML = '';
  centerCol.innerHTML = '<div style="font-size:.6rem;font-weight:700;color:var(--text-dim);margin-bottom:8px;text-align:center">#</div>';

  sourceFields.forEach(f => {
    const mapIdx = mappingsActive ? mappings.findIndex(m => m.src === f.name) : -1;
    const isMapped = mapIdx >= 0;
    const colorClass = isMapped ? pairColors[mapIdx % pairColors.length] : '';
    srcList.innerHTML += '<div class="mapping-field ' + (isMapped ? 'mapped' : '') + '" data-field="' + f.name + '" data-side="source" onclick="handleMappingFieldClick(\'' + f.name + '\',\'source\',' + mapIdx + ')">' +
      '<span class="map-dot ' + colorClass + '"></span>' +
      '<span class="field-name">' + f.name + '</span> <span class="field-type">' + f.type + '</span>' +
      (isMapped ? '<span class="map-num">' + (mapIdx+1) + '</span><span class="confidence-inline" style="color:' + (mappings[mapIdx].confidence>=85?'var(--success)':mappings[mapIdx].confidence>=70?'var(--warning)':'var(--error)') + '">' + mappings[mapIdx].confidence + '%</span>' : '') +
    '</div>';
  });

  destFields.forEach(f => {
    const mapIdx = mappingsActive ? mappings.findIndex(m => m.dest === f.name) : -1;
    const isMapped = mapIdx >= 0;
    const colorClass = isMapped ? pairColors[mapIdx % pairColors.length] : '';
    destList.innerHTML += '<div class="mapping-field ' + (isMapped ? 'mapped' : '') + '" data-field="' + f.name + '" data-side="dest" onclick="handleMappingFieldClick(\'' + f.name + '\',\'dest\',' + mapIdx + ')">' +
      '<span class="map-dot ' + colorClass + '"></span>' +
      '<span class="field-name">' + f.name + '</span> <span class="field-type">' + f.type + '</span>' +
      (isMapped ? '<span class="map-num">' + (mapIdx+1) + '</span>' : '') +
    '</div>';
  });

  // Center column pair indicators
  if (mappingsActive) {
    mappings.forEach((m, idx) => {
      centerCol.innerHTML += '<div class="mapping-pair-num ' + pairColors[idx % pairColors.length] + '" onclick="showMappingDetail(' + idx + ')" title="' + m.src + ' \u2192 ' + m.dest + '">' + (idx+1) + '</div>';
    });
  }
}

function handleMappingFieldClick(fieldName, side, mapIdx) {
  if (mapIdx >= 0) {
    showMappingDetail(mapIdx);
    return;
  }
  // Unmapped field - select for pairing
  if (selectedMappingField && selectedMappingField.side !== side) {
    // Create new mapping
    const newMap = side === 'source'
      ? { src: fieldName, dest: selectedMappingField.field, confidence: 100, type: 'manual' }
      : { src: selectedMappingField.field, dest: fieldName, confidence: 100, type: 'manual' };
    mappings.push(newMap);
    selectedMappingField = null;
    renderMappingCanvas();
    showToast('Mapping created: ' + newMap.src + ' \u2192 ' + newMap.dest);
    return;
  }
  selectedMappingField = { field: fieldName, side: side };
  // Highlight selected
  document.querySelectorAll('.mapping-field').forEach(f => f.classList.remove('selected'));
  const el = document.querySelector('.mapping-field[data-field="'+fieldName+'"][data-side="'+side+'"]');
  if (el) el.classList.add('selected');
}

function showMappingDetail(idx) {
  const m = mappings[idx];
  const confColor = m.confidence >= 85 ? 'var(--success)' : m.confidence >= 70 ? 'var(--warning)' : 'var(--error)';
  const presets = {none:'None (Direct Copy)',dateformat:'Date Format (YYYY-MM-DD)',uppercase:'Uppercase',lowercase:'Lowercase',trim:'Trim Whitespace',concat:'Concatenate',split:'Split',regex:'Regex Replace',join:'Join Array'};
  let presetsHTML = '';
  for (const [k,v] of Object.entries(presets)) {
    presetsHTML += '<option value="'+k+'">'+v+'</option>';
  }

  const html = '<div style="margin-bottom:16px">' +
    '<div style="font-size:.9rem;font-weight:700;margin-bottom:8px">' + m.src + ' &rarr; ' + m.dest + '</div>' +
    '<span class="badge" style="background:' + confColor.replace('var(','').replace(')','') + ';background:'+confColor+';color:#fff;opacity:.9">' + m.confidence + '% confidence</span> ' +
    (m.type !== 'manual' ? '<span class="badge badge-primary">AI-mapped</span>' : '<span class="badge badge-neutral">Manual</span>') +
  '</div>' +
  '<div class="form-group"><label>Preset Transformation</label><select>' + presetsHTML + '</select></div>' +
  '<div class="form-group"><label>Custom Expression</label><input type="text" placeholder="e.g., toUpperCase(trim(value))" style="font-family:monospace;font-size:.78rem"/></div>' +
  '<div class="form-group"><label>Describe in natural language</label><div style="display:flex;gap:8px"><input type="text" placeholder="e.g., Convert ISO date to DD/MM/YYYY format" style="flex:1"/><button class="btn btn-primary btn-sm">AI Generate</button></div></div>' +
  '<div style="font-weight:600;font-size:.82rem;margin:12px 0 4px">Preview</div>' +
  '<div style="display:flex;align-items:center;gap:12px;padding:10px;background:var(--bg-input);border-radius:var(--radius-sm);font-size:.82rem">' +
    '<span style="color:var(--text-dim)">2026-03-28T09:14:00Z</span><span style="color:var(--primary);font-weight:700">&rarr;</span><span style="color:var(--success);font-weight:600">2026-03-28</span>' +
  '</div>' +
  '<div style="display:flex;gap:8px;margin-top:16px">' +
    '<button class="btn btn-primary btn-sm" onclick="showToast(\'Transform applied\')">Apply</button>' +
    '<button class="btn btn-danger btn-sm" onclick="removeMapping('+idx+')">Remove Mapping</button>' +
  '</div>';

  openDetailPane('Mapping: ' + m.src + ' \u2192 ' + m.dest, html, '<a onclick="navigateTo(\'canvas\')">Mapping Canvas</a> &raquo; Field Pair #' + (idx+1));
}

function removeMapping(idx) {
  mappings.splice(idx, 1);
  closeDetailPane();
  renderMappingCanvas();
  showToast('Mapping removed');
}

function autoMap() {
  mappingsActive = false;
  renderMappingCanvas();
  setTimeout(() => {
    mappingsActive = true;
    renderMappingCanvas();
    showToast('AI Auto-Map complete: ' + mappings.length + ' fields mapped');
  }, 800);
}

function clearMappings() {
  mappingsActive = false;
  renderMappingCanvas();
  showToast('All mappings cleared');
}

// ===== INTEGRATION REGISTRY =====
const integrations = [
  { name: 'CRM Data Export', route: 'Dynamics 365 \u2192 Excel', src: 'Dynamics 365', dest: 'Excel', dept: 'Sales', status: 'green', msgs: '2,847', lastRun: '2 min ago', sparkData: [8,12,6,15,10,18,14,20,16,22] },
  { name: 'Project Task Sync', route: 'Jira \u2192 SharePoint', src: 'Jira', dest: 'SharePoint', dept: 'Engineering', status: 'green', msgs: '891', lastRun: '5 min ago', sparkData: [5,8,4,10,6,12,8,14,10,8] },
  { name: 'SAP Data Warehouse Sync', route: 'SAP ERP \u2192 TFS', src: 'SAP ERP', dest: 'TFS', dept: 'Finance', status: 'red', msgs: '0', lastRun: '42 min ago', sparkData: [15,18,12,20,0,0,0,0,0,0] },
  { name: 'Recruitment Pipeline Sync', route: 'TARA \u2192 Dynamics 365', src: 'TARA', dest: 'Dynamics 365', dept: 'HR', status: 'green', msgs: '1,204', lastRun: '8 min ago', sparkData: [10,14,8,16,12,18,14,20,16,22] },
  { name: 'eCommerce Order Sync', route: 'Shopify \u2192 NetSuite', src: 'Shopify', dest: 'NetSuite', dept: 'eCommerce', status: 'green', msgs: '3,420', lastRun: '3 min ago', sparkData: [20,25,18,30,22,28,24,32,26,34] },
  { name: 'DevOps Notification Relay', route: 'GitHub \u2192 Slack', src: 'GitHub', dest: 'Slack', dept: 'DevOps', status: 'green', msgs: '47', lastRun: '1 min ago', sparkData: [2,4,1,6,3,5,2,8,4,6] },
  { name: 'ITSM Ticket Bridge', route: 'Zendesk \u2192 ServiceNow', src: 'Zendesk', dest: 'ServiceNow', dept: 'Support', status: 'green', msgs: '234', lastRun: '7 min ago', sparkData: [8,10,6,12,8,14,10,16,12,14] },
  { name: 'Ad Spend Report Export', route: 'Google Adwords \u2192 Excel', src: 'Google Adwords', dest: 'Excel', dept: 'Marketing', status: 'amber', msgs: '0', lastRun: '2 hrs ago', sparkData: [12,14,10,16,12,0,0,0,0,0] },
  { name: 'Leave Balance Sync', route: 'Keka \u2192 Holiday Tracker', src: 'Keka', dest: 'Holiday Tracker', dept: 'HR', status: 'green', msgs: '412', lastRun: '30 min ago', sparkData: [6,8,4,10,6,12,8,14,10,12] },
  { name: 'Search Index Pipeline', route: 'PostgreSQL \u2192 GSC', src: 'PostgreSQL', dest: 'GSC', dept: 'Engineering', status: 'green', msgs: '5,670', lastRun: '10 min ago', sparkData: [30,35,28,40,32,38,34,42,36,40] },
];

function renderRegistry() {
  const grid = document.getElementById('registryGrid');
  grid.innerHTML = integrations.map((int, idx) => {
    const sparkBars = int.sparkData.map(v => '<div class="bar" style="height:' + ((v/42)*100) + '%"></div>').join('');
    const statusClass = int.status === 'red' ? 'error' : int.status === 'amber' ? 'warning' : 'success';
    return '<div class="card integration-card" onclick="showIntegrationDetail(' + idx + ')">' +
      '<div class="int-header"><span class="status-dot ' + int.status + '" onclick="event.stopPropagation();showIntegrationDetail(' + idx + ')"></span><span class="int-name">' + int.name + '</span></div>' +
      '<div style="font-size:.72rem;color:var(--text-dim);margin-bottom:6px">' + int.route + '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span class="badge badge-' + statusClass + '">' + (int.status === 'red' ? 'Error' : int.status === 'amber' ? 'Paused' : 'Active') + '</span>' +
        '<span style="font-size:.75rem;color:var(--text-dim)">' + int.dept + '</span>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:10px">' +
        '<div class="sparkline" onclick="event.stopPropagation();showSparkDetail(\'' + int.name + '\')">' + sparkBars + '</div>' +
        '<div style="text-align:right"><div style="font-size:.85rem;font-weight:600">' + int.msgs + '</div><div style="font-size:.68rem;color:var(--text-dim)">msgs/day</div></div>' +
      '</div>' +
      '<div class="int-meta"><span>Last: ' + int.lastRun + '</span><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();showVersionHistory(\'' + int.name + '\')" title="Version History">&#128339;</button></div>' +
    '</div>';
  }).join('');
}

function showSparkDetail(name) {
  openDetailPane(name + ' - Volume Chart', '<div style="text-align:center;padding:20px"><div style="font-size:.9rem;font-weight:600;margin-bottom:12px">Message Volume - Last 10 Intervals</div><svg width="100%" height="150" viewBox="0 0 300 150"><rect x="10" y="30" width="25" height="120" rx="3" fill="var(--primary)" opacity=".4"/><rect x="40" y="10" width="25" height="140" rx="3" fill="var(--primary)" opacity=".5"/><rect x="70" y="50" width="25" height="100" rx="3" fill="var(--primary)" opacity=".4"/><rect x="100" y="20" width="25" height="130" rx="3" fill="var(--primary)" opacity=".5"/><rect x="130" y="40" width="25" height="110" rx="3" fill="var(--primary)" opacity=".4"/><rect x="160" y="15" width="25" height="135" rx="3" fill="var(--primary)" opacity=".5"/><rect x="190" y="25" width="25" height="125" rx="3" fill="var(--primary)" opacity=".4"/><rect x="220" y="5" width="25" height="145" rx="3" fill="var(--primary)" opacity=".6"/><rect x="250" y="20" width="25" height="130" rx="3" fill="var(--primary)" opacity=".5"/></svg></div>', '<a onclick="navigateTo(\'registry\')">Registry</a> &raquo; ' + name + ' &raquo; Volume');
}

function showIntegrationDetail(idx) {
  const int = integrations[idx];
  const html = '<div class="grid-2 mb-16">' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Status</div><span class="badge badge-' + (int.status==='red'?'error':int.status==='amber'?'warning':'success') + '">' + (int.status==='red'?'Error':int.status==='amber'?'Paused':'Active') + '</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Schedule</div><span style="font-size:.85rem">Every 15 min</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Owner</div><span style="font-size:.85rem" class="clickable" onclick="showUserDetail(\'Anita Kumar\',\'anita.k@acme.com\',\'Admin\')">Anita Kumar</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Created</div><span style="font-size:.85rem">2026-01-15</span></div>' +
  '</div>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Field Mapping Summary</div>' +
  '<table class="mb-16"><thead><tr><th>Source</th><th>Destination</th><th>Transform</th></tr></thead><tbody>' +
    '<tr><td class="clickable" onclick="navigateTo(\'canvas\')">key</td><td>Title</td><td><span class="badge badge-primary">Concat</span></td></tr>' +
    '<tr><td class="clickable" onclick="navigateTo(\'canvas\')">assignee.displayName</td><td>AssignedTo</td><td><span class="badge badge-neutral">Direct</span></td></tr>' +
    '<tr><td class="clickable" onclick="navigateTo(\'canvas\')">status.name</td><td>Status</td><td><span class="badge badge-neutral">Direct</span></td></tr>' +
    '<tr><td class="clickable" onclick="navigateTo(\'canvas\')">created</td><td>CreatedDate</td><td><span class="badge badge-primary">DateFmt</span></td></tr>' +
  '</tbody></table>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Recent Runs</div>' +
  '<table><thead><tr><th>Timestamp</th><th>Records</th><th>Duration</th><th>Status</th></tr></thead><tbody>' +
    '<tr><td>2026-04-02 10:15:03</td><td>142</td><td>3.2s</td><td><span class="badge badge-success">Success</span></td></tr>' +
    '<tr><td>2026-04-02 10:00:01</td><td>89</td><td>2.1s</td><td><span class="badge badge-success">Success</span></td></tr>' +
    '<tr><td>2026-04-02 09:45:02</td><td>156</td><td>4.8s</td><td><span class="badge badge-success">Success</span></td></tr>' +
    '<tr><td>2026-04-02 09:30:01</td><td>12</td><td>0.9s</td><td><span class="badge badge-warning">Partial</span></td></tr>' +
  '</tbody></table>' +
  '<div style="display:flex;gap:8px;margin-top:16px"><button class="btn btn-ghost btn-sm" onclick="showVersionHistory(\'' + int.name + '\')">&#128339; Version History</button><button class="btn btn-ghost btn-sm" onclick="showViewLogs(\'' + int.name + '\')">&#128196; View Logs</button></div>';

  openDetailPane(int.name, html, '<a onclick="navigateTo(\'registry\')">Integration Registry</a> &raquo; ' + int.name);
}

// ===== ADAPTER DETAIL (Dashboard drill-down) =====
function showAdapterDetail(name, src, dest, status, msgs) {
  const isError = status === 'red';
  let html = '<div class="grid-2 mb-16">' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Source</div><span style="font-size:.85rem">' + src + '</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Destination</div><span style="font-size:.85rem">' + dest + '</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Status</div><span class="badge badge-' + (isError?'error':status==='amber'?'warning':'success') + '">' + (isError?'Error':status==='amber'?'Paused':'Active') + '</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Messages Today</div><span style="font-size:.85rem">' + (msgs||0).toLocaleString() + '</span></div>' +
  '</div>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Last 5 Runs</div>' +
  '<table class="mb-16"><thead><tr><th>Timestamp</th><th>Records</th><th>Duration</th><th>Status</th></tr></thead><tbody>' +
    '<tr><td>10:15:03</td><td>' + (Math.floor(msgs*0.4)||12) + '</td><td>3.2s</td><td><span class="badge badge-success">Success</span></td></tr>' +
    '<tr><td>10:00:01</td><td>' + (Math.floor(msgs*0.3)||8) + '</td><td>2.1s</td><td><span class="badge badge-success">Success</span></td></tr>' +
    '<tr><td>09:45:02</td><td>' + (Math.floor(msgs*0.5)||15) + '</td><td>4.8s</td><td><span class="badge badge-' + (isError?'error':'success') + '">' + (isError?'Failed':'Success') + '</span></td></tr>' +
    '<tr><td>09:30:01</td><td>' + (Math.floor(msgs*0.2)||5) + '</td><td>0.9s</td><td><span class="badge badge-success">Success</span></td></tr>' +
    '<tr><td>09:15:00</td><td>' + (Math.floor(msgs*0.35)||10) + '</td><td>2.5s</td><td><span class="badge badge-success">Success</span></td></tr>' +
  '</tbody></table>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Error Log</div>' +
  '<div class="json-block mb-16" style="font-size:.75rem;max-height:120px">' + (isError ? '<span style="color:var(--error)">Error: OAuth2TokenExpiredError at ' + src + 'Connector.authenticate<br>HTTP 401 Unauthorized - Token expired or revoked</span>' : 'No recent errors.') + '</div>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Config Summary</div>' +
  '<div class="grid-2 mb-16">' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Schedule</div><span style="font-size:.85rem">Every 15 min</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Retry Policy</div><span style="font-size:.85rem">3x Exponential</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Batch Size</div><span style="font-size:.85rem">100 records</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Owner</div><span style="font-size:.85rem" class="clickable" onclick="showUserDetail(\'Anita Kumar\',\'anita.k@acme.com\',\'Admin\')">Anita Kumar</span></div>' +
  '</div>';

  // Error actions: Create Ticket and Escalate
  if (isError) {
    html += '<div style="display:flex;gap:8px;margin-top:8px">' +
      '<button class="btn btn-danger btn-sm" onclick="openTicketForm(\'' + name + '\',\'Auth failure: OAuth2 token expired\')">Create Ticket</button>' +
      '<button class="btn btn-outline btn-sm" onclick="openEscalation(\'' + name + '\')">Escalate</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="showViewLogs(\'' + name + '\')">View Logs</button>' +
    '</div>';
  } else {
    html += '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="showViewLogs(\'' + name + '\')">View Logs</button></div>';
  }

  openDetailPane(name, html, '<a onclick="navigateTo(\'dashboard\')">Dashboard</a> &raquo; ' + name);
}

// ===== VIEW LOGS =====
function showViewLogs(name) {
  const html = '<div style="font-size:.82rem;color:var(--text-secondary);margin-bottom:12px">Showing last 10 log entries for <strong>' + name + '</strong></div>' +
    '<div class="json-block" style="max-height:400px;font-size:.72rem">' +
    '[10:15:03] INFO  Sync started. Batch: 1/3<br>' +
    '[10:15:04] INFO  Fetched 142 records from source<br>' +
    '[10:15:05] INFO  Transform pipeline: 142 records processed<br>' +
    '[10:15:06] INFO  Upserted 142 records to destination<br>' +
    '[10:15:06] INFO  Sync completed. Duration: 3.2s<br>' +
    '[10:00:01] INFO  Sync started. Batch: 1/1<br>' +
    '[10:00:02] INFO  Fetched 89 records from source<br>' +
    '[10:00:03] INFO  Sync completed. Duration: 2.1s<br>' +
    '[09:45:02] WARN  Partial sync: 3 records skipped (validation)<br>' +
    '[09:30:01] INFO  Sync completed. Duration: 0.9s<br>' +
    '</div>';
  openDetailPane(name + ' - Logs', html, '<a onclick="navigateTo(\'registry\')">Registry</a> &raquo; ' + name + ' &raquo; Logs');
}

// ===== TICKET FORM =====
function openTicketForm(adapterName, errorMsg) {
  const ticketId = 'TKT-' + (2800 + Math.floor(Math.random()*200));
  const html = '<div class="form-group"><label>Title</label><input type="text" value="' + adapterName + ' - ' + errorMsg + '" id="ticketTitle"/></div>' +
    '<div class="form-group"><label>Description</label><textarea id="ticketDesc" rows="4">' + errorMsg + '\n\nAdapter: ' + adapterName + '\nTimestamp: 2026-04-02 10:15:03 UTC\nImpact: Messages queued, sync halted</textarea></div>' +
    '<div class="form-row">' +
      '<div class="form-group"><label>Severity</label><select><option>Critical</option><option selected>High</option><option>Medium</option><option>Low</option></select></div>' +
      '<div class="form-group"><label>Assignee</label><select><option>Marcus Chen</option><option>Sarah Thompson</option><option>David Park</option><option>Elena Rodriguez</option></select></div>' +
    '</div>' +
    '<div class="form-group"><label>Adapter</label><input type="text" value="' + adapterName + '" readonly style="opacity:.6"/></div>' +
    '<div style="font-size:.82rem;font-weight:600;margin-bottom:8px">Attached Diagnostics</div>' +
    '<div class="check-item"><input type="checkbox" checked><span>Stack Trace</span></div>' +
    '<div class="check-item"><input type="checkbox" checked><span>Payload</span></div>' +
    '<div class="check-item"><input type="checkbox"><span>Mapping Config</span></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px">' +
      '<button class="btn btn-primary btn-sm" onclick="submitTicket(\'' + ticketId + '\')">Create Ticket</button>' +
      '<button class="btn btn-outline btn-sm" onclick="closeDetailPane()">Cancel</button>' +
    '</div>' +
    '<div id="ticketSuccess" style="display:none"></div>';
  openDetailPane('Create Ticket', html);
}

function submitTicket(ticketId) {
  document.getElementById('ticketSuccess').innerHTML = '<div class="success-msg">&#10003; ' + ticketId + ' created successfully</div>';
  document.getElementById('ticketSuccess').style.display = 'block';
}

function openEscalation(adapterName) {
  const html = '<div style="font-size:.9rem;font-weight:600;margin-bottom:12px">Escalate: ' + adapterName + '</div>' +
    '<p style="font-size:.85rem;color:var(--text-secondary);margin-bottom:16px">This will notify the on-call designer and create a P1 incident.</p>' +
    '<div class="form-group"><label>Escalation Level</label><select><option selected>P1 - Immediate</option><option>P2 - Urgent</option><option>P3 - Normal</option></select></div>' +
    '<div class="form-group"><label>Notify</label><div class="check-item"><input type="checkbox" checked><span>Marcus Chen (Designer)</span></div><div class="check-item"><input type="checkbox" checked><span>Lisa Nakamura (Admin)</span></div><div class="check-item"><input type="checkbox"><span>All Operators</span></div></div>' +
    '<div class="form-group"><label>Additional Notes</label><textarea rows="3" placeholder="Optional context for the escalation..."></textarea></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px">' +
      '<button class="btn btn-danger btn-sm" onclick="showToast(\'Escalation sent to on-call team\');closeDetailPane()">Confirm Escalation</button>' +
      '<button class="btn btn-outline btn-sm" onclick="closeDetailPane()">Cancel</button>' +
    '</div>';
  openDetailPane('Escalate - ' + adapterName, html);
}

// ===== MESSAGE MONITOR =====
const monitorData = [
  { time: '10:15:03', src: 'Dynamics 365', dest: 'Excel', adapter: 'CRM Data Export', status: 'Success', records: 142, dur: '3.2s', dir: '\u2192' },
  { time: '10:14:58', src: 'Jira', dest: 'SharePoint', adapter: 'Project Task Sync', status: 'Success', records: 23, dur: '1.1s', dir: '\u2192' },
  { time: '10:14:42', src: 'TARA', dest: 'Dynamics 365', adapter: 'Recruitment Pipeline Sync', status: 'Success', records: 67, dur: '2.8s', dir: '\u2192' },
  { time: '10:14:30', src: 'SAP ERP', dest: 'TFS', adapter: 'SAP Data Warehouse Sync', status: 'Failed', records: 0, dur: '0.3s', dir: '\u2192' },
  { time: '10:14:12', src: 'Shopify', dest: 'NetSuite', adapter: 'eCommerce Order Sync', status: 'Success', records: 312, dur: '5.6s', dir: '\u2192' },
  { time: '10:13:55', src: 'GitHub', dest: 'Slack', adapter: 'DevOps Notification Relay', status: 'Success', records: 8, dur: '0.4s', dir: '\u2192' },
  { time: '10:13:40', src: 'Zendesk', dest: 'ServiceNow', adapter: 'ITSM Ticket Bridge', status: 'Partial', records: 45, dur: '3.1s', dir: '\u2192' },
  { time: '10:13:22', src: 'PostgreSQL', dest: 'GSC', adapter: 'Search Index Pipeline', status: 'Success', records: 1204, dur: '8.2s', dir: '\u2192' },
  { time: '10:12:58', src: 'Keka', dest: 'Holiday Tracker', adapter: 'Leave Balance Sync', status: 'Success', records: 56, dur: '2.4s', dir: '\u2192' },
  { time: '10:12:30', src: 'Dynamics 365', dest: 'Excel', adapter: 'CRM Data Export', status: 'Success', records: 89, dur: '2.1s', dir: '\u2192' },
  { time: '10:12:15', src: 'TFS', dest: 'Excel', adapter: 'TFS Build Pipeline Sync', status: 'Success', records: 2340, dur: '4.5s', dir: '\u2192' },
  { time: '10:11:48', src: 'SAP ERP', dest: 'TFS', adapter: 'SAP Data Warehouse Sync', status: 'Failed', records: 0, dur: '0.2s', dir: '\u2192' },
  { time: '10:11:30', src: 'Mailchimp', dest: 'Dynamics 365', adapter: 'Marketing Lead Sync', status: 'Success', records: 178, dur: '3.8s', dir: '\u2190' },
  { time: '10:11:10', src: 'Twilio', dest: 'Segment', adapter: 'Comms Analytics Pipeline', status: 'Processing', records: 445, dur: '-', dir: '\u2192' },
  { time: '10:10:55', src: 'Ahrefs', dest: 'GSC', adapter: 'SEO Performance Pipeline', status: 'Success', records: 8920, dur: '12.3s', dir: '\u2192' },
];

function renderMonitor() {
  const tbody = document.getElementById('monitorBody');
  tbody.innerHTML = monitorData.map((row, idx) => {
    const statusMap = { Success: 'badge-success', Failed: 'badge-error', Partial: 'badge-warning', Processing: 'badge-info' };
    const failed = row.status === 'Failed';
    const processingIcon = row.status === 'Processing' ? '<span style="display:inline-block;animation:spin 1s linear infinite;font-size:.7rem">&#9696;</span> ' : '';
    return '<tr style="' + (failed ? 'border-left:3px solid var(--error)' : '') + ';cursor:pointer" onclick="toggleMonitorRow(' + idx + ')">' +
      '<td style="font-family:monospace;font-size:.78rem;color:var(--text-dim)">2026-04-02 ' + row.time + '</td>' +
      '<td class="clickable" onclick="event.stopPropagation();showAdapterDetail(\'' + row.adapter + '\',\'' + row.src + '\',\'' + row.dest + '\',\'' + (failed?'red':'green') + '\',' + row.records + ')">' + row.src + '</td>' +
      '<td style="color:var(--primary)">' + row.dir + '</td>' +
      '<td>' + row.dest + '</td>' +
      '<td style="font-size:.8rem" class="clickable" onclick="event.stopPropagation();showAdapterDetail(\'' + row.adapter + '\',\'' + row.src + '\',\'' + row.dest + '\',\'' + (failed?'red':'green') + '\',' + row.records + ')">' + row.adapter + '</td>' +
      '<td>' + processingIcon + '<span class="badge ' + statusMap[row.status] + '">' + row.status + '</span></td>' +
      '<td>' + row.records.toLocaleString() + '</td>' +
      '<td>' + row.dur + '</td>' +
      '<td>' + (failed ? '<button class="btn btn-sm btn-danger" style="font-size:.7rem;padding:2px 6px" onclick="event.stopPropagation();openTicketForm(\'' + row.adapter + '\',\'Failed: Auth error\')">Ticket</button> <button class="btn btn-sm btn-outline" style="font-size:.7rem;padding:2px 6px" onclick="event.stopPropagation();openEscalation(\'' + row.adapter + '\')">Escalate</button>' : '<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();showMonitorDetail(' + idx + ')" style="font-size:.75rem" title="View Details">Details</button>') + '</td>' +
    '</tr>' +
    '<tr class="expandable-content" id="monitor-expand-' + idx + '"><td colspan="9">' +
      '<div class="grid-2">' +
        '<div><div style="font-size:.78rem;color:var(--text-dim);margin-bottom:6px;font-weight:600">Payload Sample</div>' +
          '<div class="json-block">{<br>&nbsp;&nbsp;<span class="json-key">"messageId"</span>: <span class="json-string">"msg_' + String(idx+1).padStart(4,'0') + '_' + row.time.replace(/:/g,'') + '"</span>,<br>&nbsp;&nbsp;<span class="json-key">"adapter"</span>: <span class="json-string">"' + row.adapter + '"</span>,<br>&nbsp;&nbsp;<span class="json-key">"recordCount"</span>: <span class="json-number">' + row.records + '</span>,<br>&nbsp;&nbsp;<span class="json-key">"success"</span>: <span class="json-bool">' + (!failed) + '</span><br>}</div>' +
        '</div>' +
        '<div><div style="font-size:.78rem;color:var(--text-dim);margin-bottom:6px;font-weight:600">Field Mapping Trace</div>' +
          '<div style="font-size:.8rem;display:flex;flex-direction:column;gap:4px">' +
            '<div>key &rarr; ExternalId <span class="badge badge-success">OK</span></div>' +
            '<div>summary &rarr; Title <span class="badge badge-success">OK</span></div>' +
            '<div>status.name &rarr; Status <span class="badge badge-success">OK</span></div>' +
            (failed ? '<div>* &rarr; * <span class="badge badge-error">Auth Error</span></div>' : '<div>assignee &rarr; AssignedTo <span class="badge badge-success">OK</span></div>') +
          '</div></div></div></td></tr>';
  }).join('');
}

function toggleMonitorRow(idx) {
  document.getElementById('monitor-expand-' + idx).classList.toggle('show');
}

function showMonitorDetail(idx) {
  const row = monitorData[idx];
  const html = '<div class="grid-2 mb-16">' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Adapter</div><span class="clickable" onclick="showAdapterDetail(\'' + row.adapter + '\',\'' + row.src + '\',\'' + row.dest + '\',\'green\',' + row.records + ')">' + row.adapter + '</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Timestamp</div>2026-04-02 ' + row.time + '</div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Records</div>' + row.records + '</div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Duration</div>' + row.dur + '</div>' +
  '</div>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Payload</div>' +
  '<div class="json-block mb-16">{<br>&nbsp;&nbsp;<span class="json-key">"messageId"</span>: <span class="json-string">"msg_' + String(idx+1).padStart(4,'0') + '"</span>,<br>&nbsp;&nbsp;<span class="json-key">"adapter"</span>: <span class="json-string">"' + row.adapter + '"</span>,<br>&nbsp;&nbsp;<span class="json-key">"recordCount"</span>: <span class="json-number">' + row.records + '</span>,<br>&nbsp;&nbsp;<span class="json-key">"batchSize"</span>: <span class="json-number">100</span>,<br>&nbsp;&nbsp;<span class="json-key">"success"</span>: <span class="json-bool">true</span><br>}</div>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Mapping Trace</div>' +
  '<div style="font-size:.82rem"><div>key &rarr; ExternalId <span class="badge badge-success">OK</span></div><div>summary &rarr; Title <span class="badge badge-success">OK</span></div><div>status.name &rarr; Status <span class="badge badge-success">OK</span></div><div>assignee &rarr; AssignedTo <span class="badge badge-success">OK</span></div></div>';
  openDetailPane('Message Detail', html, '<a onclick="navigateTo(\'monitor\')">Trading Console</a> &raquo; msg_' + String(idx+1).padStart(4,'0'));
}

const spinStyle = document.createElement('style');
spinStyle.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
document.head.appendChild(spinStyle);

// ===== CREDENTIAL VAULT =====
const credentials = [
  { system: 'Dynamics 365 CRM', auth: 'OAuth 2.0', owner: 'Anita Kumar', rotated: '2026-03-15', expiry: '2026-06-15', status: 'active', days: 74 },
  { system: 'Jira Cloud', auth: 'API Token', owner: 'Marcus Chen', rotated: '2026-03-28', expiry: '2026-09-28', status: 'active', days: 179 },
  { system: 'SAP ERP', auth: 'OAuth 2.0', owner: 'Sarah Thompson', rotated: '2026-01-10', expiry: '2026-04-02', status: 'expired', days: 0 },
  { system: 'TARA Recruitment', auth: 'API Key', owner: 'David Park', rotated: '2026-02-20', expiry: '2027-02-20', status: 'active', days: 324 },
  { system: 'Excel Files', auth: 'IAM Access Key', owner: 'Elena Rodriguez', rotated: '2026-03-01', expiry: '2026-04-05', status: 'expiring', days: 3 },
  { system: 'SharePoint', auth: 'Client Secret', owner: 'Anita Kumar', rotated: '2026-03-20', expiry: '2026-09-20', status: 'active', days: 171 },
  { system: 'TFS', auth: 'Key Pair', owner: 'Marcus Chen', rotated: '2026-03-25', expiry: '2026-12-25', status: 'active', days: 267 },
  { system: 'PostgreSQL', auth: 'Password', owner: 'David Park', rotated: '2026-02-14', expiry: '2026-05-14', status: 'active', days: 42 },
];

function renderVault() {
  const tbody = document.getElementById('vaultBody');
  tbody.innerHTML = credentials.map((c, idx) => {
    const statusBadge = c.status === 'active' ? 'badge-success' : c.status === 'expiring' ? 'badge-warning' : 'badge-error';
    const statusLabel = c.status.charAt(0).toUpperCase() + c.status.slice(1);
    const countdownClass = c.days <= 0 ? 'urgent' : c.days <= 7 ? 'soon' : 'ok';
    const countdownText = c.days <= 0 ? 'Expired' : c.days + 'd remaining';
    return '<tr>' +
      '<td><strong class="clickable" onclick="showAdapterDetail(\'' + c.system + '\',\'' + c.system + '\',\'Target\',\'' + (c.status==='expired'?'red':'green') + '\',0)">' + c.system + '</strong></td>' +
      '<td><span class="badge badge-neutral">' + c.auth + '</span></td>' +
      '<td><span style="display:inline-flex;align-items:center;gap:6px"><span id="cred-' + idx + '" style="font-family:monospace;font-size:.78rem;letter-spacing:2px">\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022</span><button style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:.85rem" onclick="revealCred(' + idx + ')" title="Reveal (3s)">\uD83D\uDC41</button></span></td>' +
      '<td class="clickable" onclick="showUserDetail(\'' + c.owner + '\',\'' + c.owner.toLowerCase().replace(/ /g,'.') + '@acme.com\',\'Operator\')">' + c.owner + '</td>' +
      '<td>' + c.rotated + '</td>' +
      '<td><span class="countdown ' + countdownClass + '">' + countdownText + '</span></td>' +
      '<td><span class="badge ' + statusBadge + '">' + statusLabel + '</span></td>' +
      '<td><button class="btn btn-ghost btn-sm">Rotate</button> <button class="btn btn-ghost btn-sm" style="color:var(--error)">Revoke</button> <button class="btn btn-ghost btn-sm">Audit</button></td>' +
    '</tr>';
  }).join('');
}

function revealCred(idx) {
  const el = document.getElementById('cred-' + idx);
  const fakeKeys = ['dyn_live_4eC39HqL...x2mPJ','ATATT3xFfGF0...9kNv','eyJhbGciOiJSUz...','tara_live_51Nk...Qz','AKIAIOSFODNN...7EXAMPLE','9f86d081884c...e4a','tv_sess_jhFDE...wK','Sup3rS3cur3P@ss!'];
  el.textContent = fakeKeys[idx] || 'syn_sec_...redacted';
  el.style.color = 'var(--warning)';
  setTimeout(() => {
    el.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    el.style.color = '';
  }, 3000);
}

// ===== ALERTS =====
const alerts = [
  { severity: 'critical', icon: '\u26D4', title: 'SAP ERP Connector - Authentication Failure', adapter: 'SAP Data Warehouse Sync', time: '12 min ago', resolved: false, msg: 'OAuth2 refresh token expired. 23 messages queued.', stack: 'Error: OAuth2TokenExpiredError\n  at SAPConnector.authenticate\n  HTTP 401 Unauthorized' },
  { severity: 'warning', icon: '\u26A0', title: 'Dynamics 365 API Rate Limit at 85%', adapter: 'CRM Data Export', time: '34 min ago', resolved: false, msg: 'Approaching Dynamics 365 API call limit for current 24h window.', stack: 'Warning: RateLimitApproaching\n  Current: 85% of 10,000 daily limit' },
  { severity: 'warning', icon: '\u26A0', title: 'Excel Credential Expiring', adapter: 'Ad Spend Report Export', time: '1 hr ago', resolved: false, msg: 'IAM access key expires in 3 days. Rotation required.', stack: 'Warning: CredentialExpirySoon\n  Expiry: 2026-04-05' },
  { severity: 'info', icon: '\u2139', title: 'Jira-to-SharePoint migration completed', adapter: 'Project Task Sync', time: '2 hrs ago', resolved: true, msg: 'Batch migration of 4,200 issues completed successfully.', stack: '' },
  { severity: 'info', icon: '\u2139', title: 'New connector published: TARA Recruitment Platform', adapter: 'Connector Studio', time: '4 hrs ago', resolved: true, msg: 'Marcus Chen published TARA Recruitment connector v1.1.0 for candidate pipeline sync.', stack: '' },
  { severity: 'warning', icon: '\u26A0', title: 'PostgreSQL connection pool at 90%', adapter: 'Search Index Pipeline', time: '5 hrs ago', resolved: true, msg: 'Connection pool nearing maximum. Consider scaling.', stack: 'Warning: ConnectionPoolHigh\n  Active: 45/50 connections' },
  { severity: 'info', icon: '\u2139', title: 'Scheduled maintenance window approaching', adapter: 'Platform', time: '6 hrs ago', resolved: true, msg: 'System maintenance scheduled for 2026-04-03 02:00-04:00 UTC.', stack: '' },
];

function renderAlerts() {
  const container = document.getElementById('alertsList');
  container.innerHTML = alerts.map((a, idx) => {
    const bgColor = a.severity === 'critical' && !a.resolved ? 'var(--error-dim)' : 'transparent';
    const borderColor = a.severity === 'critical' ? 'var(--error)' : a.severity === 'warning' ? 'var(--warning)' : 'var(--info)';
    return '<div class="card mb-8" data-severity="' + a.severity + '" style="background:' + bgColor + ';border-left:3px solid ' + borderColor + ';cursor:pointer;padding:12px 16px" onclick="showAlertDetail(' + idx + ')">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<span style="font-size:1.1rem">' + a.icon + '</span>' +
          '<div>' +
            '<div style="font-weight:600;font-size:.88rem">' + a.title + '</div>' +
            '<div style="font-size:.75rem;color:var(--text-dim)"><span class="clickable" onclick="event.stopPropagation();showAdapterDetail(\'' + a.adapter + '\',\'Source\',\'Dest\',\'' + (a.severity==='critical'?'red':'green') + '\',0)">' + a.adapter + '</span> &middot; ' + a.time + '</div>' +
          '</div>' +
        '</div>' +
        '<span class="badge ' + (a.resolved ? 'badge-success' : (a.severity==='critical' ? 'badge-error' : 'badge-warning')) + '">' + (a.resolved ? 'Resolved' : 'Unresolved') + '</span>' +
      '</div>' +
      '<div style="font-size:.82rem;color:var(--text-secondary);margin-top:6px;margin-left:30px">' + a.msg + '</div>' +
    '</div>';
  }).join('');
}

function showAlertDetail(idx) {
  const a = alerts[idx];
  const titleColor = a.severity === 'critical' ? 'var(--error)' : a.severity === 'warning' ? 'var(--warning)' : 'var(--info)';
  let html = '<div style="color:' + titleColor + ';font-weight:700;font-size:1rem;margin-bottom:12px">&#9888; ' + a.title + '</div>' +
    '<div class="grid-2 mb-16">' +
      '<div><div style="font-size:.75rem;color:var(--text-dim)">Severity</div><span class="badge badge-' + (a.severity==='critical'?'error':a.severity==='warning'?'warning':'info') + '">' + a.severity.charAt(0).toUpperCase()+a.severity.slice(1) + '</span></div>' +
      '<div><div style="font-size:.75rem;color:var(--text-dim)">Adapter</div><span class="clickable" onclick="showAdapterDetail(\'' + a.adapter + '\',\'Source\',\'Dest\',\'' + (a.severity==='critical'?'red':'green') + '\',0)">' + a.adapter + '</span></div>' +
      '<div><div style="font-size:.75rem;color:var(--text-dim)">Time</div>' + a.time + '</div>' +
      '<div><div style="font-size:.75rem;color:var(--text-dim)">Status</div><span class="badge ' + (a.resolved?'badge-success':'badge-error') + '">' + (a.resolved?'Resolved':'Unresolved') + '</span></div>' +
    '</div>' +
    '<div style="font-size:.85rem;color:var(--text-secondary);margin-bottom:16px">' + a.msg + '</div>';

  if (a.stack) {
    html += '<div class="accordion-header" onclick="this.nextElementSibling.classList.toggle(\'show\')">Stack Trace <span style="color:var(--text-dim)">&#9660;</span></div>' +
      '<div class="accordion-body"><div class="json-block" style="font-size:.72rem;color:var(--error)">' + a.stack.replace(/\n/g,'<br>') + '</div></div>';
  }

  html += '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">';
  if (!a.resolved) {
    html += '<button class="btn btn-primary btn-sm" onclick="showToast(\'Credential re-authorization started\')">Re-authorize Credential</button>' +
      '<button class="btn btn-outline btn-sm" onclick="showToast(\'Retrying queued messages\')">Retry Queued</button>' +
      '<button class="btn btn-danger btn-sm" onclick="openTicketForm(\'' + a.adapter + '\',\'' + a.title + '\')">Create Ticket</button>' +
      '<button class="btn btn-outline btn-sm" onclick="openEscalation(\'' + a.adapter + '\')">Escalate to Designer</button>';
  }
  html += '<button class="btn btn-ghost btn-sm" onclick="showToast(\'Alert suppressed\')">Suppress</button></div>';

  openDetailPane('Alert: ' + a.title.substring(0,30) + '...', html, '<a onclick="navigateTo(\'alerts\')">Alerts</a> &raquo; ' + a.adapter);
}

// ===== ADMIN =====
function switchAdminTab(btn, tab) {
  btn.closest('.tab-bar').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('admin-users').style.display = tab === 'users' ? 'block' : 'none';
  document.getElementById('admin-apps').style.display = tab === 'apps' ? 'block' : 'none';
}

function showUserDetail(name, email, role) {
  const html = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">' +
    '<div style="width:48px;height:48px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;color:#fff;font-size:1rem;font-weight:700">' + name.split(' ').map(n=>n[0]).join('') + '</div>' +
    '<div><div style="font-weight:700;font-size:1rem">' + name + '</div><div style="font-size:.82rem;color:var(--text-dim)">' + email + '</div></div>' +
  '</div>' +
  '<div class="grid-2 mb-16">' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Role</div><span class="badge badge-primary">' + role + '</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Status</div><span class="badge badge-success">Active</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Adapters</div>8</div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Last Active</div>Recently</div>' +
  '</div>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Assigned Adapters</div>' +
  '<div style="font-size:.82rem;display:flex;flex-direction:column;gap:4px;margin-bottom:16px">' +
    '<span class="clickable" onclick="showAdapterDetail(\'CRM Data Export\',\'Dynamics 365\',\'Excel\',\'green\',342)">CRM Data Export <span class="status-dot green"></span></span>' +
    '<span class="clickable" onclick="showAdapterDetail(\'Project Task Sync\',\'Jira\',\'SharePoint\',\'green\',89)">Project Task Sync <span class="status-dot green"></span></span>' +
  '</div>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Recent Activity</div>' +
  '<div style="font-size:.8rem;color:var(--text-secondary)">' +
    '<div style="padding:4px 0">Modified CRM Data Export mapping - 2 hrs ago</div>' +
    '<div style="padding:4px 0">Published Jira Cloud connector v3.0 - Yesterday</div>' +
    '<div style="padding:4px 0">Rotated SAP ERP credentials - 3 days ago</div>' +
  '</div>';
  openDetailPane('User: ' + name, html, '<a onclick="navigateTo(\'admin\')">Administration</a> &raquo; ' + name);
}

function showClientDetail(name, tier, calls) {
  const html = '<div class="grid-2 mb-16">' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Application</div><strong>' + name + '</strong></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Tier</div><span class="badge badge-' + (tier==='Heavy'?'error':tier==='Moderate'?'warning':'info') + '">' + tier + '</span></div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">API Calls (30d)</div>' + calls.toLocaleString() + '</div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Status</div><span class="badge badge-success">Active</span></div>' +
  '</div>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Rate Limits</div>' +
  '<div style="font-size:.82rem;margin-bottom:16px">' +
    '<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>Daily</span><span>' + Math.round(calls/30) + ' / 10,000</span></div>' +
    '<div class="usage-bar"><div class="usage-bar-fill" style="width:' + Math.min(100,Math.round(calls/300)) + '%;background:var(--primary)"></div></div>' +
  '</div>';
  openDetailPane('Client: ' + name, html, '<a onclick="navigateTo(\'admin\')">Administration</a> &raquo; Client Apps &raquo; ' + name);
}

// ===== ENTITY CATALOG =====
function selectEntity(el, name, dept, fields) {
  document.querySelectorAll('.tree-item.child').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('entityName').textContent = name;
  document.getElementById('entityDept').textContent = dept;
  const types = {id:'string',key:'string',name:'string',summary:'string',description:'text',status:'enum',priority:'enum',assignee:'reference',reporter:'reference',created:'datetime',updated:'datetime',labels:'array',email:'string',company:'string',source:'string',score:'number',amount:'number',stage:'enum',probability:'number',closeDate:'date',owner:'reference',industry:'string',website:'string',phone:'string',annualRevenue:'number',employees:'number',number:'string',currency:'string',dueDate:'date',customerId:'reference',lineItems:'array',method:'enum',transactionId:'string',date:'datetime',invoiceId:'reference',plan:'string',startDate:'date',endDate:'date',renewalDate:'date',department:'string',title:'string',manager:'reference',hireDate:'date',head:'reference',budget:'number',headcount:'number',location:'string',costCenter:'string',category:'string',sla:'string',type:'enum',serialNumber:'string',purchaseDate:'date',goal:'text',boardId:'reference',completedIssues:'number',url:'string',language:'string',stars:'number',forks:'number',lastCommit:'datetime',branches:'array',state:'enum',billingAddress:'object',accountId:'reference',assignedTo:'reference',createdDate:'datetime'};
  const usages = [95,90,85,80,75,70,65,60,55,50,45,40,35];
  const tbody = document.querySelector('#entityFieldsTable tbody');
  tbody.innerHTML = fields.map((f,i) => {
    const u = usages[i%usages.length];
    const uColor = u>70?'var(--success)':u>40?'var(--primary)':'var(--warning)';
    return '<tr><td style="font-family:monospace;font-size:.78rem" class="clickable" onclick="showEntityFieldDetail(\'' + f + '\',\'' + name + '\')">' + f + '</td><td>' + f.replace(/([A-Z])/g,' $1').replace(/^./,s=>s.toUpperCase()) + '</td><td><span class="badge badge-neutral">' + (types[f]||'string') + '</span></td><td style="color:var(--text-dim)">Auto-generated description</td><td><div class="usage-bar" style="width:80px"><div class="usage-bar-fill" style="width:' + u + '%;background:' + uColor + '"></div></div></td></tr>';
  }).join('');
}

function showEntityFieldDetail(fieldName, entityName) {
  const html = '<div class="grid-2 mb-16">' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Entity</div>' + entityName + '</div>' +
    '<div><div style="font-size:.75rem;color:var(--text-dim)">Field</div><span style="font-family:monospace">' + fieldName + '</span></div>' +
  '</div>' +
  '<div style="font-weight:600;font-size:.85rem;margin-bottom:8px">Used In Mappings</div>' +
  '<div style="font-size:.82rem;display:flex;flex-direction:column;gap:4px">' +
    '<span class="clickable" onclick="navigateTo(\'canvas\')">Jira Issues &rarr; SharePoint Tasks</span>' +
    '<span class="clickable" onclick="navigateTo(\'canvas\')">Azure DevOps &rarr; Jira Cloud</span>' +
  '</div>';
  openDetailPane('Field: ' + fieldName, html, '<a onclick="navigateTo(\'catalog\')">Entity Catalog</a> &raquo; ' + entityName + ' &raquo; ' + fieldName);
}

// ===== VERSION HISTORY =====
function showVersionHistory(name) {
  const versions = [
    { v: 'v2.1.0', date: '2026-03-20', desc: 'Added retry policy configuration and dead letter queue support', current: true },
    { v: 'v2.0.0', date: '2026-02-15', desc: 'Major refactor: OAuth 2.0 support, batch processing, new entity model', current: false },
    { v: 'v1.2.0', date: '2026-01-10', desc: 'Added custom field mapping and transformation expressions', current: false },
    { v: 'v1.1.0', date: '2025-12-05', desc: 'Bug fix: connection timeout handling, added health check endpoint', current: false },
    { v: 'v1.0.0', date: '2025-11-01', desc: 'Initial release with basic CRUD operations and field mapping', current: false },
  ];
  let html = '<div class="version-list">';
  versions.forEach((v,i) => {
    html += '<div class="version-item ' + (v.current?'current':'') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span class="v-tag">' + v.v + ' ' + (v.current?'<span class="badge badge-primary" style="font-size:.6rem">Current</span>':'') + '</span>' +
        '<span class="v-date">' + v.date + '</span>' +
      '</div>' +
      '<div class="v-desc">' + v.desc + '</div>' +
      (i < versions.length - 1 ? '<button class="btn btn-ghost btn-sm mt-8" onclick="showVersionDiff(\'' + v.v + '\',\'' + versions[i+1].v + '\')">Compare with ' + versions[i+1].v + '</button>' : '') +
    '</div>';
  });
  html += '</div><div id="versionDiffInline"></div>';
  openDetailPane('Version History: ' + name, html, '<a onclick="navigateTo(\'registry\')">Registry</a> &raquo; ' + name + ' &raquo; History');
}

function showVersionDiff(v1, v2) {
  const area = document.getElementById('versionDiffInline');
  if (area) {
    area.innerHTML = '<div style="font-weight:600;font-size:.85rem;margin:16px 0 8px">Diff: ' + v1 + ' vs ' + v2 + '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<div style="flex:1;background:var(--bg-input);border-radius:var(--radius-sm);padding:10px;font-family:monospace;font-size:.72rem;overflow-x:auto">' +
          '<div style="font-weight:600;margin-bottom:8px">' + v1 + '</div>' +
          '<span class="diff-add">+ retryPolicy: { maxRetries: 3 }</span><br>' +
          '<span class="diff-add">+ deadLetterQueue: enabled</span><br>' +
          '<span style="color:var(--text-dim)">  schedule: "0 */15 * * *"</span><br>' +
          '<span class="diff-add">+ healthCheck: "/api/health"</span>' +
        '</div>' +
        '<div style="flex:1;background:var(--bg-input);border-radius:var(--radius-sm);padding:10px;font-family:monospace;font-size:.72rem;overflow-x:auto">' +
          '<div style="font-weight:600;margin-bottom:8px">' + v2 + '</div>' +
          '<span class="diff-remove">- retryPolicy: { maxRetries: 1 }</span><br>' +
          '<span class="diff-remove">- (no dead letter queue)</span><br>' +
          '<span style="color:var(--text-dim)">  schedule: "0 */15 * * *"</span><br>' +
          '<span class="diff-remove">- (no health check)</span>' +
        '</div>' +
      '</div>';
  }
}

// ===== ADMIN FUNCTIONS =====
function showEditRoleForm(name, currentRole) {
  const html = '<div style="font-weight:700;font-size:1rem;margin-bottom:16px">Edit Role: ' + name + '</div>' +
    '<div class="form-group"><label>Current Role</label><span class="badge badge-primary">' + currentRole + '</span></div>' +
    '<div class="form-group"><label>New Role</label><select id="newRoleSelect"><option' + (currentRole==='Admin'?' selected':'') + '>Admin</option><option' + (currentRole==='Designer'?' selected':'') + '>Designer</option><option' + (currentRole==='Operator'?' selected':'') + '>Operator</option><option' + (currentRole==='Viewer'?' selected':'') + '>Viewer</option></select></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px">' +
      '<button class="btn btn-primary btn-sm" onclick="showToast(\'Role updated for ' + name + '\');closeDetailPane()">Save</button>' +
      '<button class="btn btn-outline btn-sm" onclick="closeDetailPane()">Cancel</button>' +
    '</div>';
  openDetailPane('Edit Role', html, '<a onclick="navigateTo(\'admin\')">Administration</a> &raquo; Edit Role');
}

function deactivateUser(name) {
  if (confirm('Deactivate user ' + name + '? This will revoke all access.')) {
    showToast(name + ' has been deactivated');
  }
}

// ===== FILTER SYSTEM =====
function initFilters() {
  // Dashboard status filter chips
  const dashChips = document.querySelectorAll('#page-dashboard .filter-chips .chip');
  // Add filter chips to dashboard if not present
  const dashHeader = document.querySelector('#page-dashboard .page-header');
  if (dashHeader && !document.getElementById('dashFilterChips')) {
    const chipDiv = document.createElement('div');
    chipDiv.id = 'dashFilterChips';
    chipDiv.className = 'filter-chips mb-12';
    chipDiv.innerHTML = '<span class="chip active" data-filter="all" onclick="filterDashboard(\'all\',this)">All</span>' +
      '<span class="chip" data-filter="green" onclick="filterDashboard(\'green\',this)">Active</span>' +
      '<span class="chip" data-filter="amber" onclick="filterDashboard(\'amber\',this)">Paused</span>' +
      '<span class="chip" data-filter="red" onclick="filterDashboard(\'red\',this)">Error</span>';
    const tilesHeader = document.querySelector('#page-dashboard [style*="Adapter Health"]');
    if (tilesHeader) tilesHeader.parentElement.after(chipDiv);
  }

  // Add data-status to dashboard tiles
  document.querySelectorAll('#dashboardTiles .adapter-tile').forEach(tile => {
    if (tile.querySelector('.status-dot.red')) tile.setAttribute('data-status', 'red');
    else if (tile.querySelector('.status-dot.amber')) tile.setAttribute('data-status', 'amber');
    else tile.setAttribute('data-status', 'green');
  });

  // Registry filter chips - wire up existing chips
  const regChips = document.querySelectorAll('#page-registry .filter-chips .chip');
  regChips.forEach(chip => {
    chip.onclick = function() { filterRegistry(this); };
  });

  // Monitor filters - wire up existing checkboxes
  const monitorChecks = document.querySelectorAll('#page-monitor .check-item input[type="checkbox"]');
  monitorChecks.forEach(cb => {
    cb.addEventListener('change', filterMonitor);
  });
  const monitorAdapterSelect = document.querySelector('#page-monitor select');
  if (monitorAdapterSelect) monitorAdapterSelect.addEventListener('change', filterMonitor);

  // Alerts severity select
  const alertSelect = document.querySelector('#page-alerts select');
  if (alertSelect) alertSelect.addEventListener('change', filterAlerts);
}

function filterDashboard(status, chip) {
  document.querySelectorAll('#dashFilterChips .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  document.querySelectorAll('#dashboardTiles .adapter-tile').forEach(tile => {
    if (status === 'all' || tile.getAttribute('data-status') === status) {
      tile.closest('.card').style.display = '';
    } else {
      tile.closest('.card').style.display = 'none';
    }
  });
}

function filterRegistry(clickedChip) {
  const chips = document.querySelectorAll('#page-registry .filter-chips .chip');
  const text = clickedChip.textContent.trim();
  if (text === 'All') {
    chips.forEach(c => c.classList.remove('active'));
    clickedChip.classList.add('active');
  } else {
    chips[0].classList.remove('active'); // Remove 'All'
    clickedChip.classList.toggle('active');
    const anyActive = Array.from(chips).some((c, i) => i > 0 && c.classList.contains('active'));
    if (!anyActive) chips[0].classList.add('active');
  }
  const activeFilters = Array.from(chips).filter(c => c.classList.contains('active')).map(c => c.textContent.trim().toLowerCase());
  const cards = document.querySelectorAll('#registryGrid .integration-card');
  cards.forEach(card => {
    const cardText = card.textContent.toLowerCase();
    if (activeFilters.includes('all')) { card.style.display = ''; return; }
    const match = activeFilters.some(f => {
      if (f === 'active') return card.querySelector('.badge-success');
      if (f === 'error') return card.querySelector('.badge-error');
      return cardText.includes(f);
    });
    card.style.display = match ? '' : 'none';
  });
}

function filterMonitor() {
  const checks = document.querySelectorAll('#page-monitor .check-item input[type="checkbox"]');
  const showSuccess = checks[0] ? checks[0].checked : true;
  const showFailed = checks[1] ? checks[1].checked : true;
  const showPartial = checks[2] ? checks[2].checked : true;
  const adapterSelect = document.querySelector('#page-monitor select');
  const adapterFilter = adapterSelect ? adapterSelect.value : 'All Adapters';

  const rows = document.querySelectorAll('#monitorBody > tr:not(.expandable-content)');
  rows.forEach((row, idx) => {
    const statusBadge = row.querySelector('.badge');
    const status = statusBadge ? statusBadge.textContent.trim() : '';
    let show = true;
    if (status === 'Success' && !showSuccess) show = false;
    if (status === 'Failed' && !showFailed) show = false;
    if (status === 'Partial' && !showPartial) show = false;
    if (adapterFilter !== 'All Adapters') {
      const adapterCell = row.cells[4];
      if (adapterCell && !adapterCell.textContent.includes(adapterFilter)) show = false;
    }
    row.style.display = show ? '' : 'none';
    const expandRow = document.getElementById('monitor-expand-' + idx);
    if (expandRow && !show) expandRow.style.display = 'none';
  });
}

function filterAlerts() {
  const select = document.querySelector('#page-alerts select');
  const val = select ? select.value : 'All Severities';
  const items = document.querySelectorAll('#alertsList > .card');
  items.forEach(item => {
    const sev = item.getAttribute('data-severity');
    if (val === 'All Severities') { item.style.display = ''; return; }
    if (val === 'Critical Only' && sev === 'critical') { item.style.display = ''; return; }
    if (val === 'Warnings' && sev === 'warning') { item.style.display = ''; return; }
    item.style.display = 'none';
  });
}

// ===== INIT =====
renderRegistry();
renderMonitor();
renderVault();
renderAlerts();
renderMappingCanvas();
updateToolbar('dashboard');
setTimeout(initFilters, 200);

// Mark error tiles
document.querySelectorAll('.adapter-tile').forEach(tile => {
  if (tile.querySelector('.status-dot.red')) tile.classList.add('error');
});
