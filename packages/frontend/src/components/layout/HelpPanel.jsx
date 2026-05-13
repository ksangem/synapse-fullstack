import { useState, useRef } from 'react';

const helpArticles = [
  {
    category: 'Getting Started',
    articles: [
      { title: 'Creating Your First Connector', desc: 'Step-by-step guide to building integrations' },
      { title: 'Understanding the Dashboard', desc: 'Monitor your integration health at a glance' },
      { title: 'Quick Start: Connection Wizard', desc: 'Use the wizard to set up connections fast' },
    ],
  },
  {
    category: 'Administration',
    articles: [
      { title: 'User Roles & Permissions', desc: 'Configure team access and security settings' },
      { title: 'Managing Credentials', desc: 'Securely store and rotate API keys and tokens' },
      { title: 'Audit Log Reference', desc: 'Track all changes and actions in the platform' },
    ],
  },
  {
    category: 'Troubleshooting',
    articles: [
      { title: 'Common Error Codes', desc: 'Diagnose and resolve integration failures' },
      { title: 'Performance Tuning', desc: 'Optimize throughput and reduce latency' },
      { title: 'Retry & Dead Letter Queues', desc: 'Handle failed messages gracefully' },
    ],
  },
];

const botWelcome = "Hi! I'm Synapse AI Assistant. How can I help you today?";
const suggestions = [
  'How do I create a connector?',
  'What do error codes mean?',
  'How to set up alerts?',
];

const aiResponses = [
  "That's a great question! You can create a connector by navigating to the Connector Studio page and clicking \"New Connector\". From there, select the connector type and configure the authentication settings.",
  "Error codes in Synapse follow a standard pattern. 4xx codes indicate client-side issues (authentication, permissions), while 5xx codes indicate server-side problems. Check the Alerts page for detailed error descriptions.",
  "To set up alerts, go to the Alerts page and click \"Create Alert Rule\". You can configure thresholds for latency, error rates, and throughput. Notifications can be sent via email, Slack, or webhook.",
  "I can help with that! Please check the relevant documentation section in the Articles tab for detailed guides, or ask me a more specific question.",
];

export default function HelpPanel({ isOpen, onClose }) {
  const [activeTab, setActiveTab] = useState('articles');
  const [articleSearch, setArticleSearch] = useState('');
  const [messages, setMessages] = useState([
    { role: 'bot', text: botWelcome },
  ]);
  const [chatInput, setChatInput] = useState('');
  const responseIndexRef = useRef(0);

  function sendAIChat(text) {
    if (!text.trim()) return;
    const userMsg = { role: 'user', text: text.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setTimeout(() => {
      const response = aiResponses[responseIndexRef.current % aiResponses.length];
      responseIndexRef.current += 1;
      setMessages((prev) => [...prev, { role: 'bot', text: response }]);
    }, 800);
  }

  function handleChatKeyDown(e) {
    if (e.key === 'Enter') {
      sendAIChat(chatInput);
    }
  }

  const filteredArticles = helpArticles.map((cat) => ({
    ...cat,
    articles: cat.articles.filter(
      (a) =>
        a.title.toLowerCase().includes(articleSearch.toLowerCase()) ||
        a.desc.toLowerCase().includes(articleSearch.toLowerCase())
    ),
  })).filter((cat) => cat.articles.length > 0);

  return (
    <div className={`help-panel${isOpen ? ' open' : ''}`}>
      <div className="help-panel-header">
        <span style={{ fontWeight: 700, fontSize: '.95rem' }}>Help Center</span>
        <button className="dp-close" onClick={onClose}>&times;</button>
      </div>

      <div className="help-tabs">
        <button
          className={`help-tab-btn${activeTab === 'articles' ? ' active' : ''}`}
          onClick={() => setActiveTab('articles')}
        >
          Articles
        </button>
        <button
          className={`help-tab-btn${activeTab === 'ai' ? ' active' : ''}`}
          onClick={() => setActiveTab('ai')}
        >
          AI Assistant
        </button>
      </div>

      {activeTab === 'articles' && (
        <div className="help-panel-body">
          <div style={{ marginBottom: '12px' }}>
            <input
              type="text"
              placeholder="Search articles..."
              value={articleSearch}
              onChange={(e) => setArticleSearch(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          {filteredArticles.map((cat) => (
            <div key={cat.category} style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-dim)', fontWeight: 700, marginBottom: '6px' }}>
                {cat.category}
              </div>
              {cat.articles.map((article) => (
                <div key={article.title} className="help-article">
                  <div className="help-title">{article.title}</div>
                  <div className="help-desc">{article.desc}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {activeTab === 'ai' && (
        <div className="ai-chat-container">
          <div className="ai-chat-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`ai-chat-msg ${msg.role}`}>
                <div className="ai-msg-bubble">
                  {msg.text}
                  {i === 0 && msg.role === 'bot' && (
                    <div style={{ marginTop: '10px' }}>
                      {suggestions.map((s) => (
                        <span
                          key={s}
                          className="ai-chip"
                          onClick={() => sendAIChat(s)}
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="ai-chat-input-area">
            <input
              type="text"
              placeholder="Ask anything..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
            />
            <button className="btn btn-primary btn-sm" onClick={() => sendAIChat(chatInput)}>
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
