import { useNavigate } from 'react-router-dom';

/*
 * Renders a help article's block[] body. Shared by the in-drawer modal reader
 * (HelpDocModal) and the standalone /help/:slug route (HelpDocPage), so the same
 * content looks identical everywhere.
 *
 * Props:
 *   article    — the article object from helpContent.js
 *   onDocLink  — (slug) => void : how a `doclink` block navigates (open another
 *                doc in the modal, or navigate on the standalone page). Optional;
 *                falls back to navigating to /help/:slug.
 *   onNavigate — called after an internal `link` block navigates (e.g. to close
 *                the drawer/modal). Optional.
 */
export default function HelpDocView({ article, onDocLink, onNavigate }) {
  const navigate = useNavigate();

  if (!article) {
    return (
      <div className="help-doc">
        <p>Sorry, that article could not be found.</p>
      </div>
    );
  }

  function handleLink(to) {
    navigate(to);
    if (onNavigate) onNavigate();
  }

  function handleDocLink(slug) {
    if (onDocLink) onDocLink(slug);
    else handleLink(`/help/${slug}`);
  }

  return (
    <div className="help-doc">
      {article.body.map((block, i) => renderBlock(block, i, { handleLink, handleDocLink }))}
    </div>
  );
}

function renderBlock(block, key, { handleLink, handleDocLink }) {
  switch (block.type) {
    case 'h2':
      return <h2 key={key}>{block.text}</h2>;
    case 'p':
      return <p key={key}>{block.text}</p>;
    case 'ul':
      return (
        <ul key={key}>
          {block.items.map((it, j) => <li key={j}>{it}</li>)}
        </ul>
      );
    case 'steps':
      return (
        <ol key={key} className="help-steps">
          {block.items.map((it, j) => <li key={j}>{it}</li>)}
        </ol>
      );
    case 'code':
      return (
        <pre key={key} className="help-code" aria-label={block.lang ? `${block.lang} code` : 'code'}>
          <code>{block.code}</code>
        </pre>
      );
    case 'callout':
      return (
        <div key={key} className={`help-callout help-callout--${block.variant || 'note'}`}>
          <span className="help-callout-icon" aria-hidden="true">{calloutIcon(block.variant)}</span>
          <span>{block.text}</span>
        </div>
      );
    case 'table':
      return (
        <div key={key} className="help-table-wrap">
          <table className="help-table">
            <thead>
              <tr>{block.headers.map((h, j) => <th scope="col" key={j}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'link':
      return (
        <button
          key={key}
          type="button"
          className="help-doc-link"
          onClick={() => handleLink(block.to)}
        >
          {block.text} <span aria-hidden="true">→</span>
        </button>
      );
    case 'doclink':
      return (
        <button
          key={key}
          type="button"
          className="help-doc-link help-doc-link--doc"
          onClick={() => handleDocLink(block.slug)}
        >
          {block.text} <span aria-hidden="true">›</span>
        </button>
      );
    default:
      return null;
  }
}

function calloutIcon(variant) {
  if (variant === 'tip') return '\u{1F4A1}';   // 💡
  if (variant === 'warn') return '⚠';     // ⚠
  return 'ℹ';                             // ℹ
}
