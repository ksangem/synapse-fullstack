import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../hooks/useTheme';
import { useConfirm } from '../../hooks/useConfirm';
import Icon from '../ui/Icon';

/* The account menu.

   It used to be an avatar, a name, and an always-visible power icon whose single
   unconfirmed click ended the session — no dropdown, no session info, and a
   `:has()` nested-hover rule in the stylesheet working around the fact that a
   button was nested inside a hover-styled container.

   Now it is a real menu: `aria-haspopup`, roving focus with the arrow keys,
   Escape to close, focus returned to the trigger, and a confirmed sign-out. */
export default function UserMenu() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const close = useCallback((returnFocus) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Click-outside and Escape. Bound only while open so the app carries no
  // listeners for a menu nobody has opened.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) close(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Opening moves focus into the menu, which is what makes it usable without a mouse.
  useEffect(() => {
    if (open) menuRef.current?.querySelector('[role="menuitem"]')?.focus();
  }, [open]);

  const onMenuKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menuRef.current.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  const signOut = async () => {
    close(false);
    const ok = await confirm({
      title: 'Sign out?',
      message: 'You will need to sign in again to reach your integrations.',
      danger: true,
      confirmLabel: 'Sign out',
    });
    if (ok) logout();
  };

  const initials = (user?.email || '?').slice(0, 2).toUpperCase();
  const name = user?.email ? user.email.split('@')[0] : 'Signed out';

  return (
    <div className="user-menu-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="user-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={user?.email}
      >
        <span className="user-avatar" aria-hidden="true">{initials}</span>
        <span className="user-name">{name}{user?.role ? ` · ${user.role}` : ''}</span>
        <span className={`user-caret${open ? ' is-open' : ''}`} aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="user-dropdown" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}
          aria-label="Account">
          <div className="user-dd-head">
            <span className="user-avatar user-avatar--lg" aria-hidden="true">{initials}</span>
            <div className="user-dd-id">
              <div className="user-dd-email" title={user?.email}>{user?.email || 'Not signed in'}</div>
              {user?.role && <div className="user-dd-role">{user.role}</div>}
            </div>
          </div>

          <div className="user-dd-sep" role="separator" />

          <button type="button" role="menuitem" className="user-dd-item"
            onClick={() => { toggleTheme(); close(true); }}>
            <span className="user-dd-icon"><Icon name={theme === 'light' ? 'moon' : 'sun'} size={15} /></span>
            Switch to {theme === 'light' ? 'dark' : 'light'} theme
          </button>

          <div className="user-dd-sep" role="separator" />

          <button type="button" role="menuitem" className="user-dd-item is-danger" onClick={signOut}>
            <span className="user-dd-icon"><Icon name="power" size={15} /></span>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
