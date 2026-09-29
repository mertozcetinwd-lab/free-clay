/**
 * Line icons drawn for this app on a 24px grid, 1.75px stroke. Each entry is a list of shapes:
 * a string is a path, {c:[cx,cy,r]} a circle (f: filled), {r:[x,y,w,h,rx]} a rectangle.
 */

const I = {
  play: ['M8 5.5v13l10.5-6.5z'],
  stop: [{ r: [6.5, 6.5, 11, 11, 2] }],
  layers: ['M12 4 3.5 8.5 12 13l8.5-4.5z', 'M3.5 12.5 12 17l8.5-4.5', 'M3.5 16.5 12 21l8.5-4.5'],
  zap: ['M13 3 5 13.5h6L10 21l8-10.5h-6z'],
  code: ['M9 8l-4 4 4 4M15 8l4 4-4 4'],
  braces: ['M9 4.5H8a2 2 0 0 0-2 2v3.2a2.3 2.3 0 0 1-2 2.3 2.3 2.3 0 0 1 2 2.3v3.2a2 2 0 0 0 2 2h1', 'M15 4.5h1a2 2 0 0 1 2 2v3.2a2.3 2.3 0 0 0 2 2.3 2.3 2.3 0 0 0-2 2.3v3.2a2 2 0 0 1-2 2h-1'],
  key: [{ c: [8, 15, 3.8] }, 'M10.7 12.3 19 4M16 7l2.5 2.5M14 9l2 2'],
  refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4.2h-4.2'],
  fx: ['M10 5.5c-1.8 0-2.5 1-2.8 2.8L5.8 18.5M4.5 10h5.5', 'M13 11l6 7M19 11l-6 7'],
  home: ['M4 10.2 12 4l8 6.2V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M10 20v-5h4v5'],
  user: [{ c: [12, 8, 3.8] }, 'M4.6 20c.9-3.6 3.8-5.8 7.4-5.8s6.5 2.2 7.4 5.8'],
  users: [{ c: [9, 8, 3.3] }, 'M3 19.5c.7-3.2 3-5.1 6-5.1s5.3 1.9 6 5.1', 'M15.5 4.8a3.3 3.3 0 0 1 0 6.4M17.5 14.6c2 .6 3.2 2.3 3.6 4.9'],
  building: [{ r: [5, 3.5, 14, 17, 1.5] }, 'M9 7.5h2M13 7.5h2M9 11.5h2M13 11.5h2M9 15.5h2M13 15.5h2'],
  target: [{ c: [12, 12, 8.5] }, { c: [12, 12, 4.8] }, { c: [12, 12, 1.2, 1] }],
  'check-square': [{ r: [4, 4, 16, 16, 3.5] }, 'M8.5 12.2l2.4 2.4 4.8-5.1'],
  folder: ['M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
  'folder-plus': ['M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z', 'M12 11v5M9.5 13.5h5'],
  maximize: ['M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5 13.5 10.5M4.5 19.5l6-6'],
  rows: [{ r: [3.5, 4.5, 17, 15, 2] }, 'M3.5 9.5h17M3.5 14.5h17'],
  eye: ['M3 12c.8-2.2 4-6.5 9-6.5s8.2 4.3 9 6.5c-.8 2.2-4 6.5-9 6.5S3.8 14.2 3 12z', { c: [12, 12, 2.8] }],
  restore: ['M4.5 12a7.5 7.5 0 1 0 2.2-5.3', 'M4.5 4.5v4.2h4.2'],
  'file-text': ['M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z', 'M14 3.5V8h4.5M9 13h6M9 16.5h4'],
  search: [{ c: [11, 11, 6.5] }, 'M20 20l-4.2-4.2'],
  plus: ['M12 5v14M5 12h14'],
  x: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
  'chevron-down': ['M7 10l5 5 5-5'],
  'chevron-up': ['M7 14l5-5 5 5'],
  'chevron-right': ['M10 7l5 5-5 5'],
  'chevron-left': ['M14 7l-5 5 5 5'],
  more: [{ c: [5.5, 12, 1.3, 1] }, { c: [12, 12, 1.3, 1] }, { c: [18.5, 12, 1.3, 1] }],
  filter: ['M4 6.5h16M7 12h10M10 17.5h4'],
  sort: ['M7.5 4.5v15M4.5 16.5l3 3 3-3M16.5 19.5v-15M13.5 7.5l3-3 3 3'],
  sliders: ['M4 7h9.5M17.5 7H20M4 17h3M11 17h9', { c: [15.5, 7, 2] }, { c: [9, 17, 2] }],
  board: [{ r: [3.5, 4, 4.8, 16, 1.5] }, { r: [9.6, 4, 4.8, 11, 1.5] }, { r: [15.7, 4, 4.8, 7, 1.5] }],
  table: [{ r: [3.5, 4.5, 17, 15, 2] }, 'M3.5 10h17M3.5 14.8h17M9.5 10v9.5'],
  calendar: [{ r: [4, 5.5, 16, 14.5, 2] }, 'M4 10h16M8.5 3.5v4M15.5 3.5v4'],
  mail: [{ r: [3.5, 5.5, 17, 13, 2] }, 'M4 7l8 6 8-6'],
  phone: ['M6.2 4.5h2.7l1.4 3.6-1.8 1.2a10.5 10.5 0 0 0 5.2 5.2l1.2-1.8 3.6 1.4v2.7a1.7 1.7 0 0 1-1.8 1.7C10.7 18 6 13.3 4.5 6.3a1.7 1.7 0 0 1 1.7-1.8z'],
  link: ['M10.5 13.5a3.8 3.8 0 0 0 5.4 0l2.7-2.7a3.8 3.8 0 0 0-5.4-5.4l-.9.9', 'M13.5 10.5a3.8 3.8 0 0 0-5.4 0l-2.7 2.7a3.8 3.8 0 0 0 5.4 5.4l.9-.9'],
  trash: ['M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7M10.2 11v5.5M13.8 11v5.5'],
  star: ['M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3l-4.8 2.6 1-5.4-4-3.8 5.4-.7z'],
  clock: [{ c: [12, 12, 8.3] }, 'M12 7.5V12l3 1.8'],
  flag: ['M5.5 20.5v-16M5.5 4.5h11l-2.2 4 2.2 4h-11'],
  sun: [{ c: [12, 12, 3.8] }, 'M12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3'],
  moon: ['M19.5 14.2A7.5 7.5 0 1 1 9.8 4.5a6 6 0 0 0 9.7 9.7z'],
  monitor: [{ r: [3.5, 4.5, 17, 11.5, 2] }, 'M8.5 19.5h7M12 16v3.5'],
  grip: [{ c: [9, 6.5, 1.2, 1] }, { c: [15, 6.5, 1.2, 1] }, { c: [9, 12, 1.2, 1] }, { c: [15, 12, 1.2, 1] }, { c: [9, 17.5, 1.2, 1] }, { c: [15, 17.5, 1.2, 1] }],
  upload: ['M12 15.5V4.5M7.5 9l4.5-4.5L16.5 9', 'M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3'],
  download: ['M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5', 'M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3'],
  expand: ['M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5l-6.5 6.5M4.5 19.5l6.5-6.5'],
  sidebar: [{ r: [3.5, 4.5, 17, 15, 2] }, 'M9.5 4.5v15'],
  tag: ['M4 12.4V5a1 1 0 0 1 1-1h7.4l7.6 7.6a1 1 0 0 1 0 1.4l-6.6 6.6a1 1 0 0 1-1.4 0z', { c: [8.5, 8.5, 1.3, 1] }],
  hash: ['M5 9h14.5M4.5 15H19M10 4.5 8.5 19.5M15.5 4.5 14 19.5'],
  text: ['M5.5 7V5h13v2M12 5v14M9.5 19h5'],
  check: ['M5.5 12.5l4.2 4.2 8.8-9.2'],
  alert: [{ c: [12, 12, 8.5] }, 'M12 7.8v5M12 16.2v.2'],
  logout: ['M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4', 'M9.5 8l-4 4 4 4M5.5 12h10'],
  dollar: ['M12 3.5v17', 'M16 7.5c-.5-1.5-2-2.3-4-2.3-2.3 0-4 1.1-4 3 0 4.3 8.3 2.4 8.3 6.7 0 2-1.9 3.3-4.3 3.3-2.1 0-3.8-.9-4.3-2.6'],
  globe: [{ c: [12, 12, 8.5] }, 'M3.5 12h17', 'M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z'],
  pin: ['M12 20.5s-6.5-5.7-6.5-10.8a6.5 6.5 0 0 1 13 0c0 5.1-6.5 10.8-6.5 10.8z', { c: [12, 9.7, 2.3] }],
  briefcase: [{ r: [3.5, 7.5, 17, 12, 2] }, 'M9 7.5V5.8A1.3 1.3 0 0 1 10.3 4.5h3.4A1.3 1.3 0 0 1 15 5.8v1.7M3.5 12.5h17'],
  list: ['M9.5 6.5h10M9.5 12h10M9.5 17.5h10', { c: [5, 6.5, 1.1, 1] }, { c: [5, 12, 1.1, 1] }, { c: [5, 17.5, 1.1, 1] }],
  circle: [{ c: [12, 12, 8] }],
  'check-circle': [{ c: [12, 12, 8.5] }, 'M8.5 12.3l2.4 2.4 4.6-4.9'],
  'x-circle': [{ c: [12, 12, 8.5] }, 'M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6'],
  'arrow-up': ['M12 19V5.5M6.5 11 12 5.5 17.5 11'],
  'arrow-down': ['M12 5v13.5M6.5 13 12 18.5 17.5 13'],
  'arrow-left': ['M19 12H5.5M11 6.5 5.5 12l5.5 5.5'],
  'arrow-right': ['M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5'],
  'eye-off': ['M4 4l16 16', 'M10.6 5.6c.5-.1.9-.1 1.4-.1 5 0 8.2 4.3 9 6.5a11.7 11.7 0 0 1-2.4 3.5M6.6 6.7C4.8 8 3.6 10 3 12c.8 2.2 4 6.5 9 6.5a9 9 0 0 0 4.3-1', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  activity: ['M3.5 12h3.8l2.8-7 3.8 14 2.8-7h3.8'],
  pencil: ['M5 19l.8-3.6L15.6 5.6a1.8 1.8 0 0 1 2.6 0l.2.2a1.8 1.8 0 0 1 0 2.6L8.6 18.2z', 'M13.8 7.4l2.8 2.8'],
  copy: [{ r: [8.5, 8.5, 11.5, 11.5, 2] }, 'M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5'],
  keyboard: [{ r: [3, 6, 18, 12, 2] }, 'M7 10h.5M11 10h.5M15 10h.5M7.5 14h9'],
  command: ['M9 7.5A2.5 2.5 0 1 0 6.5 10H17.5A2.5 2.5 0 1 0 15 7.5v9a2.5 2.5 0 1 0 2.5-2.5h-11A2.5 2.5 0 1 0 9 16.5z'],
  sparkle: ['M12 4l1.6 4.8L18.5 10l-4.9 1.4L12 16l-1.6-4.6L5.5 10l4.9-1.2z', 'M18.5 16.5l.6 1.8 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z'],
  inbox: ['M4 13.5 6.4 6a1.5 1.5 0 0 1 1.4-1h8.4a1.5 1.5 0 0 1 1.4 1l2.4 7.5V18a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18z', 'M4 13.5h4.5l1 2h5l1-2H20'],
  palette: [{ c: [12, 12, 8.5] }, { c: [8.5, 10, 1.2, 1] }, { c: [12, 7.5, 1.2, 1] }, { c: [15.5, 10, 1.2, 1] }, 'M12 20.5a2 2 0 0 1 0-4h1.5a2 2 0 0 0 2-2'],
  database: ['M5 6.5c0-1.6 3.1-3 7-3s7 1.4 7 3-3.1 3-7 3-7-1.4-7-3z', 'M5 6.5v11c0 1.6 3.1 3 7 3s7-1.4 7-3v-11M5 12c0 1.6 3.1 3 7 3s7-1.4 7-3'],
  columns: [{ r: [3.5, 4.5, 17, 15, 2] }, 'M9.2 4.5v15M14.8 4.5v15'],
  toggle: [{ r: [3, 7, 18, 10, 5] }, { c: [16, 12, 2.6] }],
  number: ['M9.5 4.5 7.5 19.5M16.5 4.5l-2 15M4.5 9h15M4 15h15'],
};

const NS = 'http://www.w3.org/2000/svg';

export function icon(name, size = 16, sw = 1.75) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', sw); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const s of I[name] || I.circle) {
    let el;
    if (typeof s === 'string') { el = document.createElementNS(NS, 'path'); el.setAttribute('d', s); }
    else if (s.c) {
      el = document.createElementNS(NS, 'circle');
      el.setAttribute('cx', s.c[0]); el.setAttribute('cy', s.c[1]); el.setAttribute('r', s.c[2]);
      if (s.c[3]) { el.setAttribute('fill', 'currentColor'); el.setAttribute('stroke', 'none'); }
    } else if (s.r) {
      el = document.createElementNS(NS, 'rect');
      const [x, y, w, hh, rx] = s.r;
      el.setAttribute('x', x); el.setAttribute('y', y); el.setAttribute('width', w); el.setAttribute('height', hh); el.setAttribute('rx', rx || 0);
    }
    svg.append(el);
  }
  return svg;
}

/** The icon in a column header: the kind for computed columns, else the type. */
export function typeIcon(type, kind) {
  const byKind = { enrich: 'zap', waterfall: 'layers', formula: 'fx', ai: 'sparkle', http: 'code' };
  if (kind && byKind[kind]) return byKind[kind];
  return {
    text: 'text', email: 'mail', url: 'link', number: 'number', currency: 'dollar', date: 'calendar',
    select: 'circle', multi_select: 'tag', checkbox: 'check-square', json: 'braces',
  }[type] || 'text';
}
