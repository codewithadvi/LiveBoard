// Small outline icons, drawn on a 24-unit grid with one stroke weight so they
// read as a family. Each value is the inside of an <svg>; icon() wraps it.

const P = {
  select: '<path d="M6 3.5v14l3.8-3.4 2.6 6 2.4-1-2.6-5.8 5.2-.4z"/>',
  hand: '<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 10.5V4.5a1.5 1.5 0 0 1 3 0V10M14 10V6.5a1.5 1.5 0 0 1 3 0V13M8 12.4l-1.6-1.8a1.5 1.5 0 0 0-2.3 1.9l3.2 5.6a5 5 0 0 0 4.3 2.4h1.6a4.4 4.4 0 0 0 4.4-4.4V13"/>',
  pen: '<path d="M4 20l1.1-4.2L16.6 4.3a2 2 0 0 1 2.8 2.8L7.9 18.7z"/><path d="M14.6 6.4l3 3"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="3"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  arrow: '<path d="M5 19L19 5M10 5h9v9"/>',
  line: '<path d="M5 19L19 5"/>',
  text: '<path d="M6 6h12M12 6v13M9 19h6"/>',
  eraser: '<path d="M19.5 19.5H9L4.6 15a1.6 1.6 0 0 1 0-2.2l8.2-8.2a1.6 1.6 0 0 1 2.2 0l4.4 4.4a1.6 1.6 0 0 1 0 2.2L12.5 19.5"/><path d="M8 9.5l6.5 6.5"/>',
  laser: '<circle cx="12" cy="12" r="2.4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  undo: '<path d="M8.5 4.5L4 9l4.5 4.5"/><path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H9"/>',
  redo: '<path d="M15.5 4.5L20 9l-4.5 4.5"/><path d="M20 9h-9.5a5.5 5.5 0 0 0 0 11H15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6M12 16.6v.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/>',
  moon: '<path d="M20 14.2A8 8 0 1 1 9.8 4a6.4 6.4 0 0 0 10.2 10.2z"/>',
  grid: '<path d="M4 4h16v16H4zM4 12h16M12 4v16"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.3 14a4.2 4.2 0 0 0 7.4 0M9 9.6v.4M15 9.6v.4"/>',
  duplicate: '<path d="M8.5 8.5h10v10h-10z"/><path d="M5.5 15.5v-10h10"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M6.8 7l.9 12.5h8.6L17.2 7M10 11v5.5M14 11v5.5"/>',
  forward: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  backward: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  front: '<path d="M12 20V8M6 14l6-6 6 6M5 4h14"/>',
  back: '<path d="M12 4v12M6 10l6 6 6-6M5 20h14"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M4 16l4.5-4.5 4 4 2.5-2.5L20 17M9 9.5v.01"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4M5 19.5h14"/>',
  home: '<path d="M4 11l8-7 8 7M6 9.5V20h12V9.5"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  // style panel
  hatch: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M4.5 13L13 4.5M4.5 19.5L19.5 4.5M11 19.5l8.5-8.5"/>',
  cross: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M4.5 13L13 4.5M4.5 19.5L19.5 4.5M11 19.5l8.5-8.5M11 4.5l8.5 8.5M4.5 4.5l15 15M4.5 11l8.5 8.5"/>',
  solid: '<rect x="4" y="4" width="16" height="16" rx="2.5" fill="currentColor"/>',
  w1: '<path d="M4 12h16" stroke-width="1"/>',
  w2: '<path d="M4 12h16" stroke-width="2.2"/>',
  w4: '<path d="M4 12h16" stroke-width="4"/>',
  w6: '<path d="M4 12h16" stroke-width="6"/>',
  solidLine: '<path d="M3 12h18"/>',
  dashed: '<path d="M3 12h4M10 12h4M17 12h4"/>',
  dotted: '<path d="M4 12h.01M8.5 12h.01M13 12h.01M17.5 12h.01" stroke-width="3"/>',
  clean: '<path d="M3 12h18"/>',
  sketchy: '<path d="M3 12.5c3-2.5 5 2.5 8 0s6-2.5 10 0"/>',
  wild: '<path d="M3 12c2-6 3.5 6 6 0s3.5-6 6 0 3.5 6 6 0"/>',
  sharp: '<path d="M5 19V5h14"/>',
  round: '<path d="M5 19v-8a6 6 0 0 1 6-6h8"/>',
  none: '<rect x="4" y="4" width="16" height="16" rx="8"/><path d="M6 18L18 6"/>',
} as const;

export type IconName = keyof typeof P;

export function icon(name: IconName, size = 22): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name]}</svg>`;
}
