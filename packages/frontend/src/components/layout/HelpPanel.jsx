import { useState, useEffect, useMemo } from 'react';
import { helpArticles, helpCategories, searchArticles } from '../../data/helpContent';
import HelpDocModal from '../help/HelpDocModal';
import Icon from '../ui/Icon';

// Group the flat registry into { category, articles[] } in category order.
function groupByCategory(articles) {
  return helpCategories
    .map((category) => ({
      category,
      articles: articles.filter((a) => a.category === category),
    }))
    .filter((cat) => cat.articles.length > 0);
}

export default function HelpPanel({ isOpen, onClose }) {
  const [activeTab, setActiveTab] = useState('articles');
  const [articleSearch, setArticleSearch] = useState('');
  const [askQuery, setAskQuery] = useState('');
  const [openSlug, setOpenSlug] = useState(null); // which doc the modal shows

  // Close the panel on Escape while it's open — but only when the doc modal
  // isn't up (the modal has its own Escape handler that stops propagation).
  useEffect(() => {
    if (!isOpen) return undefined;
    function handleKey(e) {
      if (e.key === 'Escape' && !openSlug) onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, openSlug]);

  // Filter the article list by the drawer search box.
  const grouped = useMemo(() => {
    const q = articleSearch.trim().toLowerCase();
    const filtered = !q
      ? helpArticles
      : helpArticles.filter(
          (a) =>
            a.title.toLowerCase().includes(q) ||
            a.desc.toLowerCase().includes(q) ||
            (a.keywords || '').toLowerCase().includes(q)
        );
    return groupByCategory(filtered);
  }, [articleSearch]);

  const askResults = useMemo(() => searchArticles(askQuery), [askQuery]);

  // Following an internal app link from a doc should dismiss the whole overlay.
  function handleDocNavigate() {
    setOpenSlug(null);
    onClose();
  }

  return (
    <>
      <div
        className={`help-panel${isOpen ? ' open' : ''}`}
        role="dialog"
        aria-modal="false"
        aria-label="Help Center"
        aria-hidden={!isOpen}
      >
        <div className="help-panel-header">
          <span style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-md)' }}>Help Center</span>
          <button className="dp-close" onClick={onClose} aria-label="Close help" title="Close"><Icon name="close" size={16} /></button>
        </div>

        <div className="help-tabs">
          <button
            className={`help-tab-btn${activeTab === 'articles' ? ' active' : ''}`}
            onClick={() => setActiveTab('articles')}
          >
            Articles
          </button>
          <button
            className={`help-tab-btn${activeTab === 'ask' ? ' active' : ''}`}
            onClick={() => setActiveTab('ask')}
          >
            Ask
          </button>
        </div>

        {activeTab === 'articles' && (
          <div className="help-panel-body">
            <div style={{ marginBottom: '12px' }}>
              <input
                type="text"
                placeholder="Search articles..."
                aria-label="Search help articles"
                value={articleSearch}
                onChange={(e) => setArticleSearch(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            {grouped.length === 0 && (
              <div className="help-empty">No articles match &ldquo;{articleSearch}&rdquo;.</div>
            )}
            {grouped.map((cat) => (
              <div key={cat.category} style={{ marginBottom: '16px' }}>
                <div className="help-cat-label">{cat.category}</div>
                {cat.articles.map((article) => (
                  <button
                    key={article.slug}
                    type="button"
                    className="help-article"
                    onClick={() => setOpenSlug(article.slug)}
                  >
                    <div className="help-title">{article.title}</div>
                    <div className="help-desc">{article.desc}</div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        {activeTab === 'ask' && (
          <div className="help-panel-body">
            <div className="help-ask-intro">
              Ask a question and we&apos;ll point you to the right docs.
            </div>
            <div style={{ margin: '10px 0 14px' }}>
              <input
                type="text"
                placeholder="e.g. how do I replay a failed message?"
                aria-label="Ask a question"
                value={askQuery}
                onChange={(e) => setAskQuery(e.target.value)}
                autoFocus
                style={{ width: '100%' }}
              />
            </div>
            {askQuery.trim() === '' && (
              <div className="help-ask-suggestions">
                {['Create a connector', 'What error codes mean', 'Set up alerts', 'Replay the dead letter queue'].map((s) => (
                  <button key={s} type="button" className="ai-chip" onClick={() => setAskQuery(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {askQuery.trim() !== '' && askResults.length === 0 && (
              <div className="help-empty">
                No matching docs. Try different words, or browse the Articles tab.
              </div>
            )}
            {askResults.map((article) => (
              <button
                key={article.slug}
                type="button"
                className="help-article help-ask-result"
                onClick={() => setOpenSlug(article.slug)}
              >
                <div className="help-ask-result-cat">{article.category}</div>
                <div className="help-title">{article.title}</div>
                <div className="help-desc">{article.desc}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <HelpDocModal
        slug={openSlug}
        onClose={() => setOpenSlug(null)}
        onOpenDoc={(slug) => setOpenSlug(slug)}
        onNavigate={handleDocNavigate}
      />
    </>
  );
}
