export const integrations = [
  { name: 'CRM Data Export', route: 'Dynamics 365 \u2192 Excel', src: 'Dynamics 365', dest: 'Excel', dept: 'Sales', status: 'green', msgs: '2,847', lastRun: '2 min ago', sparkData: [8, 12, 6, 15, 10, 18, 14, 20, 16, 22] },
  { name: 'Project Task Sync', route: 'Jira \u2192 SharePoint', src: 'Jira', dest: 'SharePoint', dept: 'Engineering', status: 'green', msgs: '891', lastRun: '5 min ago', sparkData: [5, 8, 4, 10, 6, 12, 8, 14, 10, 8] },
  { name: 'SAP Data Warehouse Sync', route: 'SAP ERP \u2192 TFS', src: 'SAP ERP', dest: 'TFS', dept: 'Finance', status: 'red', msgs: '0', lastRun: '42 min ago', sparkData: [15, 18, 12, 20, 0, 0, 0, 0, 0, 0] },
  { name: 'Recruitment Pipeline Sync', route: 'TARA \u2192 Dynamics 365', src: 'TARA', dest: 'Dynamics 365', dept: 'HR', status: 'green', msgs: '1,204', lastRun: '8 min ago', sparkData: [10, 14, 8, 16, 12, 18, 14, 20, 16, 22] },
  { name: 'eCommerce Order Sync', route: 'Shopify \u2192 NetSuite', src: 'Shopify', dest: 'NetSuite', dept: 'eCommerce', status: 'green', msgs: '3,420', lastRun: '3 min ago', sparkData: [20, 25, 18, 30, 22, 28, 24, 32, 26, 34] },
  { name: 'DevOps Notification Relay', route: 'GitHub \u2192 Slack', src: 'GitHub', dest: 'Slack', dept: 'DevOps', status: 'green', msgs: '47', lastRun: '1 min ago', sparkData: [2, 4, 1, 6, 3, 5, 2, 8, 4, 6] },
  { name: 'ITSM Ticket Bridge', route: 'Zendesk \u2192 ServiceNow', src: 'Zendesk', dest: 'ServiceNow', dept: 'Support', status: 'green', msgs: '234', lastRun: '7 min ago', sparkData: [8, 10, 6, 12, 8, 14, 10, 16, 12, 14] },
  { name: 'Ad Spend Report Export', route: 'Google Adwords \u2192 Excel', src: 'Google Adwords', dest: 'Excel', dept: 'Marketing', status: 'amber', msgs: '0', lastRun: '2 hrs ago', sparkData: [12, 14, 10, 16, 12, 0, 0, 0, 0, 0] },
  { name: 'Leave Balance Sync', route: 'Keka \u2192 Holiday Tracker', src: 'Keka', dest: 'Holiday Tracker', dept: 'HR', status: 'green', msgs: '412', lastRun: '30 min ago', sparkData: [6, 8, 4, 10, 6, 12, 8, 14, 10, 12] },
  { name: 'Search Index Pipeline', route: 'PostgreSQL \u2192 GSC', src: 'PostgreSQL', dest: 'GSC', dept: 'Engineering', status: 'green', msgs: '5,670', lastRun: '10 min ago', sparkData: [30, 35, 28, 40, 32, 38, 34, 42, 36, 40] },
];
