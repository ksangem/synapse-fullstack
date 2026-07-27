/* Inline stroke icons for control positions.

   The app leans on emoji glyphs, which is fine in prose but wrong inside a
   button: emoji render in the platform's own colours, so a colour-neutral eye
   sat next to a bright-orange clipboard in the same action cluster, and neither
   inherited the button's disabled or hover colour. These are single-path SVGs on
   currentColor, so an icon button now looks like the button it lives in.

   Everything is 24×24 in userspace and scaled by `size`; stroke width stays
   visually constant because vector-effect is not needed at these sizes. */

const PATHS = {
  eye: 'M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff: 'M4 4l16 16 M9.9 5.8A9.6 9.6 0 0 1 12 5.5c7 0 10.5 6.5 10.5 6.5a17 17 0 0 1-3.7 4.4 M6.4 7.6A16.7 16.7 0 0 0 1.5 12S5 18.5 12 18.5c1.6 0 3-.3 4.2-.8 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  copy: 'M9 9h10v12H9z M15 9V3H5v12h4',
  rotate: 'M20 12a8 8 0 1 1-2.3-5.6 M20 3v5h-5',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M5.6 5.6l12.8 12.8',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.3-4.3',
  download: 'M12 3v12 M7 11l5 5 5-5 M4 21h16',
  play: 'M7 4.5v15l13-7.5z',
  external: 'M14 4h6v6 M20 4l-9 9 M17 14v5H5V7h5',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.2L21 8 M21 12a9 9 0 0 1-15.5 6.2L3 16 M21 3v5h-5 M3 21v-5h5',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  check: 'M4 12.5l5 5L20 6.5',
  close: 'M6 6l12 12 M18 6L6 18',
  pencil: 'M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.7z M14.5 6.5l3 3',
  pause: 'M8 5v14 M16 5v14',

  /* ── Navigation + chrome ────────────────────────────────────────────────
     These replace the sidebar's Unicode dingbats and the topbar's emoji, which
     were two incompatible icon styles stacked directly on top of each other:
     monochrome line-art in the sidebar, full-colour emoji in the bar above it.

     Two of the dingbats were also plain wrong. The "Connection Wizard" icon was
     U+26A9 ⚩ — the horizontal male with stroke sign, an intersex/transgender
     symbol — and "Entity Catalog" was U+268F ⚏, a digram for greater yin. Both
     were arbitrary shape-matches carrying real, unrelated meanings, and several
     of the set fell back to tofu across Windows/macOS/Linux font stacks. */
  dashboard: 'M4 13h7V4H4z M13 8h7V4h-7z M13 20h7v-9h-7z M4 20h7v-5H4z',
  registry: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.4 8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  monitor: 'M3 8h13 M12 4l4 4-4 4 M21 16H8 M12 12l-4 4 4 4',
  alerts: 'M12 3.5 2.5 20h19z M12 10v4 M12 17.2v.1',
  studio: 'M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.7z M14.5 6.5l3 3 M3 3l1.5 3L8 7.5 4.5 9 3 12l-1.5-3L-1 7.5 2.5 6z',
  wizard: 'M5 19 17 7 M14.5 4.5 19.5 9.5 M15.8 3.2a1.8 1.8 0 0 1 2.5 0l2.5 2.5a1.8 1.8 0 0 1 0 2.5l-2 2-5-5z M4 12l1 2.5L7.5 15.5 5 16.5 4 19 3 16.5.5 15.5 3 14.5z',
  canvas: 'M3 7h7 M7 4 3.5 7 7 10 M21 17h-7 M17 14l3.5 3-3.5 3 M10 7h4a4 4 0 0 1 0 8h-4',
  catalog: 'M4 6.5C4 5.1 6.7 4 10 4s6 1.1 6 2.5S13.3 9 10 9 4 7.9 4 6.5Z M4 6.5v11C4 18.9 6.7 20 10 20s6-1.1 6-2.5v-11 M4 12c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5 M19 11v9 M22 14l-3-3-3 3',
  connections: 'M9.5 14.5 6.7 17.3a3.9 3.9 0 0 1-5.5-5.5l2.8-2.8 M14.5 9.5l2.8-2.8a3.9 3.9 0 0 1 5.5 5.5l-2.8 2.8 M8.5 15.5l7-7',
  vault: 'M5 10.5h14v10H5z M8 10.5V7a4 4 0 0 1 8 0v3.5 M12 14.5v2.5',
  admin: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M2 20a7 7 0 0 1 14 0 M17.5 11a3 3 0 1 0 0-6 M18 20a6.5 6.5 0 0 0-2-4.7',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M9.3 9.3a2.8 2.8 0 1 1 3.7 2.6c-.6.2-1 .8-1 1.5v.6 M12 17.2v.1',
  bell: 'M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z M13.7 19.5a2 2 0 0 1-3.4 0',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  expand: 'M8 3H3v5 M16 3h5v5 M21 16v5h-5 M3 16v5h5',
  collapse: 'M3 8h5V3 M21 8h-5V3 M16 21v-5h5 M8 21v-5H3',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z M12 1.5v2 M12 20.5v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1.5 12h2 M20.5 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4',
  moon: 'M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.6 6.6 0 0 0 10.8 10.8Z',
  power: 'M12 3v9 M6.3 6.3a8 8 0 1 0 11.4 0',

  /* ── Contextual-toolbar actions ─────────────────────────────────────────
     The toolbar sits directly beneath the topbar, so its emoji rendered at
     OS-specific sizes and baselines right next to the bar's line-art. */
  plus: 'M12 5v14 M5 12h14',
  upload: 'M12 16V4 M7 8l5-5 5 5 M4 21h16',
  chart: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  save: 'M4 4h11l5 5v11H4z M8 4v5h7 M8 20v-6h8v6',
  wand: 'M5 19 15 9 M13 3l1 2.5L16.5 6.5 14 7.5 13 10 12 7.5 9.5 6.5 12 5.5z M19.5 12l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  undo: 'M9 14 4 9l5-5 M4 9h9a7 7 0 0 1 0 14h-3',
  redo: 'M15 14l5-5-5-5 M20 9h-9a7 7 0 0 0 0 14h3',
  mute: 'M4 4l16 16 M18 9a6 6 0 0 0-9.3-5 M6 9c0 5-2 6.5-2 6.5h11 M13.7 19.5a2 2 0 0 1-3.4 0',
  escalate: 'M12 20V5 M6 11l6-6 6 6',
  link: 'M9.5 14.5 6.7 17.3a3.9 3.9 0 0 1-5.5-5.5l2.8-2.8 M14.5 9.5l2.8-2.8a3.9 3.9 0 0 1 5.5 5.5l-2.8 2.8 M8.5 15.5l7-7',
};

export default function Icon({ name, size = 14, className = '', title }) {
  const d = PATHS[name];
  /* Nav and chrome icons are now data-driven keys, so a typo would render an
     invisible nothing rather than a wrong glyph. Say so in dev. */
  if (!d) {
    if (import.meta.env.DEV) console.warn(`[Icon] unknown icon name: "${name}"`);
    return null;
  }
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      /* Decorative unless the caller gives it a title; the surrounding button
         carries the accessible name in every current use. */
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}
