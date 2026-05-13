import { useState } from 'react';
import { connectorCategories } from '../../data/connectorCategories';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useNavigate } from 'react-router-dom';

const categoryCards = [
  { key: 'rest', icon: '\u{1F310}', label: 'REST API' },
  { key: 'db', icon: '\u{1F5C3}', label: 'Database' },
  { key: 'file', icon: '\u{1F4C1}', label: 'File Share' },
  { key: 'saas', icon: '\u2601', label: 'SaaS Application' },
  { key: 'mq', icon: '\u{1F4E9}', label: 'Message Queue' },
  { key: 'webhook', icon: '\u{1F50C}', label: 'Webhook' },
  { key: 'scrape', icon: '\u{1F577}', label: 'Web Scraping' },
];

const endpoints = [
  { checked: true, path: '/contacts', method: 'GET', methodBadge: 'badge-info', access: 'R/W', accessTag: 'tag-both', desc: 'List and create contacts' },
  { checked: true, path: '/accounts', method: 'GET', methodBadge: 'badge-info', access: 'Read', accessTag: 'tag-read', desc: 'List accounts' },
  { checked: true, path: '/opportunities', method: 'POST', methodBadge: 'badge-success', access: 'R/W', accessTag: 'tag-both', desc: 'Create and manage opportunities' },
  { checked: false, path: '/leads', method: 'GET', methodBadge: 'badge-info', access: 'R/W', accessTag: 'tag-both', desc: 'Lead management' },
  { checked: true, path: '/cases', method: 'GET', methodBadge: 'badge-info', access: 'R/W', accessTag: 'tag-both', desc: 'Case lifecycle' },
  { checked: false, path: '/quotes', method: 'POST', methodBadge: 'badge-warning', access: 'Write', accessTag: 'tag-write', desc: 'Issue quotes' },
  { checked: false, path: '/products', method: 'GET', methodBadge: 'badge-info', access: 'R/W', accessTag: 'tag-both', desc: 'Product catalog' },
];

const publishedConnectors = [
  { name: 'Dynamics 365 CRM', v: 'v2.1', type: 'REST API', date: '2026-03-20' },
  { name: 'Jira Cloud', v: 'v3.0', type: 'REST API', date: '2026-03-18' },
  { name: 'Keka HR', v: 'v1.2', type: 'SaaS Application', date: '2026-03-15' },
  { name: 'Ahrefs SEO', v: 'v1.0', type: 'REST API', date: '2026-03-10' },
  { name: 'TARA Recruitment', v: 'v1.1', type: 'REST API', date: '2026-03-05' },
  { name: 'SharePoint Online', v: 'v2.0', type: 'REST API', date: '2026-02-28' },
  { name: 'Excel Files', v: 'v1.3', type: 'File Share', date: '2026-02-20' },
  { name: 'GSC API', v: 'v1.0', type: 'REST API', date: '2026-02-15' },
];

const versionHistory = [
  { v: 'v2.1.0', date: '2026-03-20', desc: 'Added retry policy configuration and dead letter queue support', current: true },
  { v: 'v2.0.0', date: '2026-02-15', desc: 'Major refactor: OAuth 2.0 support, batch processing, new entity model', current: false },
  { v: 'v1.2.0', date: '2026-01-10', desc: 'Added custom field mapping and transformation expressions', current: false },
  { v: 'v1.1.0', date: '2025-12-05', desc: 'Bug fix: connection timeout handling, added health check endpoint', current: false },
  { v: 'v1.0.0', date: '2025-11-01', desc: 'Initial release with basic CRUD operations and field mapping', current: false },
];

export default function StudioPage() {
  const [activeCategory, setActiveCategory] = useState(null);
  const [connectorName, setConnectorName] = useState('Dynamics 365 CRM');
  const [endpointChecks, setEndpointChecks] = useState(endpoints.map(e => e.checked));
  const { openDetailPane } = useDetailPane();
  const navigate = useNavigate();

  const toggleCategory = (key) => {
    setActiveCategory(prev => prev === key ? null : key);
  };

  const selectConnectorItem = (item) => {
    setConnectorName(item);
  };

  const showVersionHistoryPane = (name) => {
    const html = (
      <div>
        <div className="version-list">
          {versionHistory.map((v, i) => (
            <div key={i} className={`version-item ${v.current ? 'current' : ''}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="v-tag">
                  {v.v} {v.current && <span className="badge badge-primary" style={{ fontSize: '.6rem' }}>Current</span>}
                </span>
                <span className="v-date">{v.date}</span>
              </div>
              <div className="v-desc">{v.desc}</div>
            </div>
          ))}
        </div>
      </div>
    );
    openDetailPane('Version History: ' + name, html, 'Connector Studio > Published > ' + name);
  };

  const showPublished = () => {
    const content = (
      <div>
        {publishedConnectors.map((c, i) => (
          <div
            key={i}
            className="published-connector-item"
            onClick={() => showVersionHistoryPane(c.name)}
          >
            <div>
              <strong>{c.name}</strong>{' '}
              <span
                className="badge badge-success clickable"
                onClick={(e) => { e.stopPropagation(); showVersionHistoryPane(c.name); }}
              >
                {c.v}
              </span>
              <div style={{ fontSize: '.72rem', color: 'var(--text-dim)' }}>
                {c.type} | Published {c.date}
              </div>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={(e) => { e.stopPropagation(); showVersionHistoryPane(c.name); }}
            >
              &#128339; History
            </button>
          </div>
        ))}
      </div>
    );
    openDetailPane('Published Connectors', content, 'Connector Studio > Published');
  };

  const toggleEndpoint = (idx) => {
    setEndpointChecks(prev => {
      const next = [...prev];
      next[idx] = !next[idx];
      return next;
    });
  };

  const cat = activeCategory ? connectorCategories[activeCategory] : null;

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Connector Studio</div>
          <div className="page-subtitle">Design and publish connector templates</div>
        </div>
        <button className="btn btn-outline btn-sm" onClick={showPublished}>
          &#128065; View Published
        </button>
      </div>

      <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: 12 }}>System Category</div>
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}
        className="mb-16"
      >
        {categoryCards.map(c => (
          <div
            key={c.key}
            className="card connector-card"
            style={activeCategory === c.key ? { borderColor: 'var(--primary)' } : undefined}
            onClick={() => toggleCategory(c.key)}
          >
            <div className="conn-icon">{c.icon}</div>
            <div className="conn-label">{c.label}</div>
          </div>
        ))}
      </div>

      {cat && (
        <div className="card mb-24">
          <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: 8 }}>{cat.title}</div>
          <div>
            {cat.items.map((item, i) => (
              <div
                key={i}
                className="connector-list-item"
                onClick={() => selectConnectorItem(item)}
              >
                <span className="cli-dot"></span>
                {item}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ maxWidth: 900 }}>
        <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          &#127760; New REST API Connector <span className="badge badge-info">Draft</span>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Connector Name</label>
            <input type="text" value={connectorName} onChange={(e) => setConnectorName(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Version</label>
            <input type="text" defaultValue="1.0.0" style={{ maxWidth: 120 }} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Base URL</label>
            <input type="text" defaultValue="https://org.api.crm.dynamics.com/api/data/v9.2" />
          </div>
          <div className="form-group" style={{ maxWidth: 200 }}>
            <label>API Spec</label>
            <button className="btn btn-outline btn-sm" style={{ width: '100%', marginTop: 2 }}>
              &#128206; Upload OpenAPI
            </button>
          </div>
        </div>

        <div style={{ fontWeight: 600, fontSize: '.85rem', margin: '16px 0 8px' }}>Discovered Endpoints</div>
        <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          <table>
            <thead>
              <tr><th></th><th>Endpoint</th><th>Method</th><th>Access</th><th>Description</th></tr>
            </thead>
            <tbody>
              {endpoints.map((ep, i) => (
                <tr key={i}>
                  <td>
                    <input
                      type="checkbox"
                      checked={endpointChecks[i]}
                      onChange={() => toggleEndpoint(i)}
                    />
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>{ep.path}</td>
                  <td><span className={`badge ${ep.methodBadge}`}>{ep.method}</span></td>
                  <td><span className={`tag ${ep.accessTag}`}>{ep.access}</span></td>
                  <td style={{ color: 'var(--text-dim)' }}>{ep.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="form-group mt-16">
          <label>Authentication Type</label>
          <select defaultValue="oauth2-auth">
            <option value="apikey">API Key (Bearer Token)</option>
            <option value="oauth2-auth">OAuth 2.0 - Authorization Code</option>
            <option value="oauth2-client">OAuth 2.0 - Client Credentials</option>
            <option value="basic">Basic Authentication</option>
            <option value="custom">Custom Header</option>
          </select>
        </div>

        <div style={{ fontWeight: 600, fontSize: '.85rem', margin: '16px 0 8px' }}>Entity Modeller</div>
        <div className="card" style={{ background: 'var(--bg-main)', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 20 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 6, fontWeight: 600 }}>Raw Fields</div>
              <div style={{ fontFamily: 'monospace', fontSize: '.75rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                contactid, fullname, emailaddress1,<br />
                telephone1, jobtitle, company,<br />
                address1_city, address1_country,<br />
                createdon, modifiedon, statecode,<br />
                ownerid, parentcustomerid,<br />
                description, revenue
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', fontSize: '1.5rem', color: 'var(--primary)' }}>&rarr;</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 6, fontWeight: 600 }}>Grouped Entities</div>
              <div style={{ fontSize: '.8rem' }}>
                <div
                  style={{ padding: '4px 0', fontWeight: 600, color: 'var(--primary)', cursor: 'pointer' }}
                  onClick={() => navigate('/catalog')}
                >
                  &#9654; Contact <span className="badge badge-neutral" style={{ fontSize: '.6rem' }}>8 fields</span>
                </div>
                <div
                  style={{ padding: '4px 0', fontWeight: 600, color: 'var(--primary)', cursor: 'pointer' }}
                  onClick={() => navigate('/catalog')}
                >
                  &#9654; Account <span className="badge badge-neutral" style={{ fontSize: '.6rem' }}>5 fields</span>
                </div>
                <div
                  style={{ padding: '4px 0', fontWeight: 600, color: 'var(--primary)', cursor: 'pointer' }}
                  onClick={() => navigate('/catalog')}
                >
                  &#9654; Address <span className="badge badge-neutral" style={{ fontSize: '.6rem' }}>3 fields</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button className="btn btn-outline">Save Draft</button>
          <button className="btn btn-success" disabled title="Run test first">&#9654; Test Connection</button>
          <button className="btn btn-primary" disabled title="Test must pass before publish">Publish Connector</button>
        </div>
      </div>
    </div>
  );
}
