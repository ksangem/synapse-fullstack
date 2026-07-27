import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getArticle, helpArticles } from '../../data/helpContent';
import HelpDocView from './HelpDocView';

/*
 * Standalone /help/:slug page — what the modal's "Open in new tab" button loads.
 * Renders the same HelpDocView inside the normal app shell, with its own header
 * and a link back to the app. Cross-doc links navigate to sibling /help routes.
 */
export default function HelpDocPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const article = getArticle(slug);

  // Keep the browser tab title meaningful for bookmarks / new tabs.
  useEffect(() => {
    const prev = document.title;
    document.title = article ? `${article.title} · Synapse Help` : 'Help · Synapse';
    return () => { document.title = prev; };
  }, [article]);

  return (
    <div className="help-doc-page">
      <div className="help-doc-page-bar">
        <button type="button" className="link-btn" onClick={() => navigate('/dashboard')}>
          ← Back to Synapse
        </button>
        {article && <span className="help-doc-page-cat">{article.category}</span>}
      </div>

      {article ? (
        <article className="help-doc-page-content">
          <h1 className="help-doc-page-title">{article.title}</h1>
          <p className="help-doc-page-desc">{article.desc}</p>
          <HelpDocView article={article} onDocLink={(s) => navigate(`/help/${s}`)} />
        </article>
      ) : (
        <div className="help-doc-page-content">
          <h1 className="help-doc-page-title">Article not found</h1>
          <p className="help-doc-page-desc">
            We couldn&apos;t find a help article for &ldquo;{slug}&rdquo;. Browse the topics below:
          </p>
          <ul className="help-doc-notfound-list">
            {helpArticles.slice(0, 12).map((a) => (
              <li key={a.slug}>
                <button type="button" className="link-btn" onClick={() => navigate(`/help/${a.slug}`)}>
                  {a.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
