/* source → destination, named by WHAT they are rather than by their technology.

   "SharePoint → PostgreSQL" is true of a dozen connections at once, so a list of
   them read as a column of identical rows; `PerformanceManagementSystem.P-360 →
   pulse.employees` says which one you are looking at. The system name stays, dimmed
   and in parentheses, because it is still what tells you how to reason about the
   endpoint — it is just not the identifying part.

   The Dashboard tile and the Registry card rendered this pair inline and character
   for character identically. Now that the label has structure (scope + system) it
   gets one owner instead of two copies. */

export default function EndpointRoute({ tile }) {
  const node = (icon, scope, system, label) => (
    <span className="ucard-node" title={label}>
      <span className="ucard-ico" aria-hidden="true">{icon}</span>
      <span className="ucard-scope">{scope || system}</span>
      {/* Only when there IS a scope — otherwise the system name would print twice. */}
      {scope ? <span className="ucard-sys">({system})</span> : null}
    </span>
  );

  return (
    <>
      {node(tile.srcIcon, tile.srcScope, tile.src, tile.srcLabel)}
      <span className="ucard-arrow" aria-hidden="true">&rarr;</span>
      {node(tile.destIcon, tile.destScope, tile.dest, tile.destLabel)}
    </>
  );
}
