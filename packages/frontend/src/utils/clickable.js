/* Makes a non-button element behave like a button for keyboard users.

   The app had 51 elements that responded to a mouse click but were invisible to the
   keyboard — no focus, no Enter/Space. Spreading `clickable(fn)` gives an element the
   role, a tab stop, and Enter/Space activation in one place, so the three never drift
   apart the way they do when each site hand-rolls an onKeyDown.

   Use a real <button> where you can. This is for cases where the clickable region is
   a layout element (a card, a row, a tree node) that cannot become a button without
   restructuring the markup. */
export function clickable(onActivate, { label, disabled = false } = {}) {
  if (disabled) return { 'aria-disabled': true };
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onClick: onActivate,
    onKeyDown: (e) => {
      // Space must not scroll the page; Enter must not submit a surrounding form.
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        onActivate(e);
      }
    },
  };
}
