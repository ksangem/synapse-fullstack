import { useState } from 'react';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useNavigate } from 'react-router-dom';

const departments = [
  {
    name: 'Engineering',
    entities: [
      { name: 'Issue', fields: ['id', 'key', 'summary', 'description', 'status', 'priority', 'assignee', 'reporter', 'created', 'updated', 'labels', 'type'] },
      { name: 'Sprint', fields: ['id', 'name', 'state', 'startDate', 'endDate'] },
      { name: 'Repository', fields: ['id', 'name', 'url', 'language', 'stars', 'forks', 'lastCommit', 'branches', 'type'] },
    ],
  },
  {
    name: 'Sales',
    entities: [
      { name: 'Lead', fields: ['id', 'name', 'email', 'company', 'source', 'status', 'score', 'assignedTo', 'createdDate', 'phone'] },
      { name: 'Opportunity', fields: ['id', 'name', 'amount', 'stage', 'probability', 'closeDate', 'owner', 'accountId'] },
      { name: 'Account', fields: ['id', 'name', 'industry', 'website', 'phone', 'billingAddress', 'annualRevenue', 'employees', 'email', 'status', 'type'] },
    ],
  },
  {
    name: 'Finance',
    entities: [
      { name: 'Invoice', fields: ['id', 'number', 'amount', 'currency', 'dueDate', 'status', 'customerId'] },
      { name: 'Payment', fields: ['id', 'amount', 'method', 'status', 'transactionId', 'date'] },
      { name: 'Subscription', fields: ['id', 'plan', 'status', 'startDate', 'renewalDate'] },
    ],
  },
  {
    name: 'HR',
    entities: [
      { name: 'Employee', fields: ['id', 'name', 'email', 'department', 'title', 'manager', 'hireDate', 'status', 'phone'] },
      { name: 'Department', fields: ['id', 'name', 'head', 'budget', 'headcount', 'location'] },
    ],
  },
  {
    name: 'Operations',
    entities: [
      { name: 'Ticket', fields: ['id', 'title', 'description', 'priority', 'status', 'assignee', 'category', 'sla'] },
      { name: 'Asset', fields: ['id', 'name', 'type', 'serialNumber', 'location', 'assignedTo', 'purchaseDate'] },
    ],
  },
];

const types = {
  id: 'string', key: 'string', name: 'string', summary: 'string', description: 'text',
  status: 'enum', priority: 'enum', assignee: 'reference', reporter: 'reference',
  created: 'datetime', updated: 'datetime', labels: 'array', email: 'string',
  company: 'string', source: 'string', score: 'number', amount: 'number',
  stage: 'enum', probability: 'number', closeDate: 'date', owner: 'reference',
  industry: 'string', website: 'string', phone: 'string', annualRevenue: 'number',
  employees: 'number', number: 'string', currency: 'string', dueDate: 'date',
  customerId: 'reference', lineItems: 'array', method: 'enum', transactionId: 'string',
  date: 'datetime', invoiceId: 'reference', plan: 'string', startDate: 'date',
  endDate: 'date', renewalDate: 'date', department: 'string', title: 'string',
  manager: 'reference', hireDate: 'date', head: 'reference', budget: 'number',
  headcount: 'number', location: 'string', costCenter: 'string', category: 'string',
  sla: 'string', type: 'enum', serialNumber: 'string', purchaseDate: 'date',
  goal: 'text', boardId: 'reference', completedIssues: 'number', url: 'string',
  language: 'string', stars: 'number', forks: 'number', lastCommit: 'datetime',
  branches: 'array', state: 'enum', billingAddress: 'object', accountId: 'reference',
  assignedTo: 'reference', createdDate: 'datetime',
};

const usages = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35];

export default function CatalogPage() {
  const [selectedEntity, setSelectedEntity] = useState({ name: 'Issue', dept: 'Engineering', fields: departments[0].entities[0].fields });
  const [expandedDepts, setExpandedDepts] = useState({ Engineering: true, Sales: true, Finance: true, HR: true, Operations: true });
  const { openDetailPane } = useDetailPane();
  const navigate = useNavigate();

  const toggleDept = (deptName) => {
    setExpandedDepts(prev => ({ ...prev, [deptName]: !prev[deptName] }));
  };

  const selectEntity = (entity, deptName) => {
    setSelectedEntity({ name: entity.name, dept: deptName, fields: entity.fields });
  };

  const showFieldDetail = (fieldName, entityName) => {
    const content = (
      <div>
        <div className="grid-2 mb-16">
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Entity</div>
            {entityName}
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Field</div>
            <span style={{ fontFamily: 'monospace' }}>{fieldName}</span>
          </div>
        </div>
        <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Used In Mappings</div>
        <div style={{ fontSize: '.82rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="clickable" onClick={() => navigate('/canvas')}>
            Jira Issues &rarr; SharePoint Tasks
          </span>
          <span className="clickable" onClick={() => navigate('/canvas')}>
            Azure DevOps &rarr; Jira Cloud
          </span>
        </div>
      </div>
    );
    openDetailPane(
      'Field: ' + fieldName,
      content,
      'Entity Catalog > ' + entityName + ' > ' + fieldName
    );
  };

  const usageColor = (u) => u > 70 ? 'var(--success)' : u > 40 ? 'var(--primary)' : 'var(--warning)';

  const formatLabel = (f) => f.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Master Entity Catalog</div>
          <div className="page-subtitle">Canonical data model reference</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, height: 'calc(100vh - 200px)' }}>
        {/* Tree nav */}
        <div className="card tree-nav" style={{ overflowY: 'auto', flexShrink: 0, padding: 12 }}>
          <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 8, fontWeight: 600 }}>Departments</div>
          {departments.map(dept => (
            <div key={dept.name}>
              <div
                className="tree-item parent"
                onClick={() => toggleDept(dept.name)}
                style={{ cursor: 'pointer' }}
              >
                {expandedDepts[dept.name] ? '\u25BC' : '\u25B6'} {dept.name}
              </div>
              {expandedDepts[dept.name] && dept.entities.map(entity => (
                <div
                  key={entity.name}
                  className={`tree-item child${selectedEntity.name === entity.name && selectedEntity.dept === dept.name ? ' active' : ''}`}
                  onClick={() => selectEntity(entity, dept.name)}
                >
                  {entity.name}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Entity detail panel */}
        <div style={{ flex: 1, overflowY: 'auto' }} id="entityDetailPanel">
          <div className="card mb-16">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>{selectedEntity.name}</span>{' '}
                <span className="badge badge-primary">{selectedEntity.dept}</span>
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>
                Used by 3 connectors, 4 adapters
              </div>
            </div>
            <table>
              <thead>
                <tr><th>Field</th><th>Label</th><th>Type</th><th>Description</th><th>Usage</th></tr>
              </thead>
              <tbody>
                {selectedEntity.fields.map((f, i) => {
                  const u = usages[i % usages.length];
                  return (
                    <tr key={f}>
                      <td
                        style={{ fontFamily: 'monospace', fontSize: '.78rem' }}
                        className="clickable"
                        onClick={() => showFieldDetail(f, selectedEntity.name)}
                      >
                        {f}
                      </td>
                      <td>{formatLabel(f)}</td>
                      <td><span className="badge badge-neutral">{types[f] || 'string'}</span></td>
                      <td style={{ color: 'var(--text-dim)' }}>Auto-generated description</td>
                      <td>
                        <div className="usage-bar" style={{ width: 80 }}>
                          <div
                            className="usage-bar-fill"
                            style={{ width: u + '%', background: usageColor(u) }}
                          ></div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: 12 }}>Cross-References</div>
            <div className="grid-2">
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 6, fontWeight: 600 }}>
                  Connectors Using This Entity
                </div>
                <div style={{ fontSize: '.85rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="clickable" onClick={() => navigate('/studio')}>
                    &#127760; Jira Cloud REST API <span className="badge badge-success">Published</span>
                  </span>
                  <span className="clickable" onClick={() => navigate('/studio')}>
                    &#127760; Azure DevOps REST API <span className="badge badge-success">Published</span>
                  </span>
                  <span className="clickable" onClick={() => navigate('/studio')}>
                    &#128451; PostgreSQL Issue Tracker <span className="badge badge-info">Draft</span>
                  </span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 6, fontWeight: 600 }}>
                  Adapters Using This Entity
                </div>
                <div style={{ fontSize: '.85rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="clickable" onClick={() => navigate('/registry')}>
                    Project Task Sync <span className="status-dot green"></span>
                  </span>
                  <span className="clickable" onClick={() => navigate('/registry')}>
                    Jira &rarr; Confluence <span className="status-dot green"></span>
                  </span>
                  <span className="clickable" onClick={() => navigate('/registry')}>
                    Azure DevOps &rarr; Jira <span className="status-dot green"></span>
                  </span>
                  <span className="clickable" onClick={() => navigate('/registry')}>
                    Jira &rarr; Slack Notifier <span className="status-dot amber"></span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
