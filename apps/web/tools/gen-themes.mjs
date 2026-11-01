// Generator for apps/web/src/styles/themes.css — emits concrete hex literals for
// all eight themes with contrast-safe tested tokens. Upstream palette values are
// copied in; mixes are precomputed to hex; tested tokens (text, subtext, border,
// focus accents, on-primary/on-secondary/on-destructive) are auto-adjusted to
// meet the spec's exact contrast thresholds, with adjustments recorded.
import { writeFileSync } from 'node:fs';

// ---------- color math ----------
function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mix(a, b, pa) {
  // pa = percent of a (0..100), srgb mixing
  const ra = hexToRgb(a), rb = hexToRgb(b), f = pa / 100;
  return rgbToHex([ra[0] * f + rb[0] * (1 - f), ra[1] * f + rb[1] * (1 - f), ra[2] * f + rb[2] * (1 - f)]);
}
function lum(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// Adjust `color` toward black (dark=true -> darken) or white until it meets
// `target` contrast against each bg in `bgs`. Returns adjusted hex (minimal steps).
function adjustForContrast(color, bgs, target, darken) {
  let c = color;
  const toward = darken ? '#000000' : '#ffffff';
  for (let i = 0; i <= 100; i++) {
    if (bgs.every((bg) => contrast(c, bg) >= target)) return c;
    c = mix(color, toward, 100 - i); // progressively more toward target
  }
  return c;
}
function bestOn(fill) {
  // choose black or white foreground maximizing contrast
  return contrast('#000000', fill) >= contrast('#ffffff', fill) ? '#000000' : '#ffffff';
}

const adjustments = [];

// ---------- palettes ----------
const ctp = {
  'catppuccin-latte': { mode: 'light', base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8', surface0: '#ccd0da', surface1: '#bcc0cc', surface2: '#acb0be', overlay0: '#9ca0b0', overlay1: '#8c8fa1', overlay2: '#7c7f93', subtext0: '#6c6f85', subtext1: '#5c5f77', text: '#4c4f69', accents: { rosewater: '#dc8a78', flamingo: '#dd7878', pink: '#ea76cb', mauve: '#8839ef', red: '#d20f39', maroon: '#e64553', peach: '#fe640b', yellow: '#df8e1d', green: '#40a02b', teal: '#179299', sky: '#04a5e5', sapphire: '#209fb5', blue: '#1e66f5', lavender: '#7287fd' } },
  'catppuccin-frappe': { mode: 'dark', base: '#303446', mantle: '#292c3c', crust: '#232634', surface0: '#414559', surface1: '#51576d', surface2: '#626880', overlay0: '#737994', overlay1: '#838ba7', overlay2: '#949cbb', subtext0: '#a5adce', subtext1: '#b5bfe2', text: '#c6d0f5', accents: { rosewater: '#f2d5cf', flamingo: '#eebebe', pink: '#f4b8e4', mauve: '#ca9ee6', red: '#e78284', maroon: '#ea999c', peach: '#ef9f76', yellow: '#e5c890', green: '#a6d189', teal: '#81c8be', sky: '#99d1db', sapphire: '#85c1dc', blue: '#8caaee', lavender: '#babbf1' } },
  'catppuccin-macchiato': { mode: 'dark', base: '#24273a', mantle: '#1e2030', crust: '#181926', surface0: '#363a4f', surface1: '#494d64', surface2: '#5b6078', overlay0: '#6e738d', overlay1: '#8087a2', overlay2: '#939ab7', subtext0: '#a5adcb', subtext1: '#b8c0e0', text: '#cad3f5', accents: { rosewater: '#f4dbd6', flamingo: '#f0c6c6', pink: '#f5bde6', mauve: '#c6a0f6', red: '#ed8796', maroon: '#ee99a0', peach: '#f5a97f', yellow: '#eed49f', green: '#a6da95', teal: '#8bd5ca', sky: '#91d7e3', sapphire: '#7dc4e4', blue: '#8aadf4', lavender: '#b7bdf8' } },
  'catppuccin-mocha': { mode: 'dark', base: '#1e1e2e', mantle: '#181825', crust: '#11111b', surface0: '#313244', surface1: '#45475a', surface2: '#585b70', overlay0: '#6c7086', overlay1: '#7f849c', overlay2: '#9399b2', subtext0: '#a6adc8', subtext1: '#bac2de', text: '#cdd6f4', accents: { rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7', red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af', green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec', blue: '#89b4fa', lavender: '#b4befe' } }
};

// GitHub Primer Primitives v9.1.2 scale + functional values (copied literals)
const gh = {
  light: { pink: ['#ffeff7','#ffd3eb','#ffadda','#ff80c8','#e85aad','#bf3989','#99286e','#772057','#611347','#4d0336'], coral: ['#fff0eb','#ffd6cc','#ffb4a1','#fd8c73','#ec6547','#c4432b','#9e2f1c','#801f0f','#691105','#510901'], purple: ['#fbefff','#ecd8ff','#d8b9ff','#c297ff','#a475f9','#8250df','#6639ba','#512a97','#3e1f79','#2e1461'], red: ['#ffebe9','#ffcecb','#ffaba8','#ff8182','#fa4549','#cf222e','#a40e26','#82071e','#660018','#4c0014'], orange: ['#fff1e5','#ffd8b5','#ffb77c','#fb8f44','#e16f24','#bc4c00','#953800','#762c00','#5c2200','#471700'], yellow: ['#fff8c5','#fae17d','#eac54f','#d4a72c','#bf8700','#9a6700','#7d4e00','#633c01','#4d2d00','#3b2300'], green: ['#dafbe1','#aceebb','#6fdd8b','#4ac26b','#2da44e','#1a7f37','#116329','#044f1e','#003d16','#002d11'], blue: ['#ddf4ff','#b6e3ff','#80ccff','#54aeff','#218bff','#0969da','#0550ae','#033d8b','#0a3069','#002155'], neutral: ['#ffffff','#f6f8fa','#eff2f5','#e6eaef','#e0e6eb','#dae0e7','#d1d9e0','#c8d1da','#818b98','#59636e'], bg: '#ffffff', inset: '#f6f8fa', muted: '#f6f8fa', fgDefault: '#1f2328', fgMuted: '#59636e', borderDefault: '#d1d9e0' },
  dark: { pink: ['#ffdaec','#ffbedd','#ff9bce','#f778ba','#db61a2','#bf4b8a','#9e3670','#7d2457','#5e103e','#42062a'], coral: ['#ffddd2','#ffc2b2','#ffa28b','#f78166','#ea6045','#cf462d','#ac3220','#872012','#640d04','#460701'], purple: ['#eddeff','#e2c5ff','#d2a8ff','#be8fff','#ab7df8','#8957e5','#6e40c9','#553098','#3c1e70','#271052'], red: ['#ffdcd7','#ffc1ba','#ffa198','#ff7b72','#f85149','#da3633','#b62324','#8e1519','#67060c','#490202'], orange: ['#ffdfb6','#ffc680','#ffa657','#f0883e','#db6d28','#bd561d','#9b4215','#762d0a','#5a1e02','#3d1300'], yellow: ['#f8e3a1','#f2cc60','#e3b341','#d29922','#bb8009','#9e6a03','#845306','#693e00','#4b2900','#341a00'], green: ['#aff5b4','#7ee787','#56d364','#3fb950','#2ea043','#238636','#196c2e','#0f5323','#033a16','#04260f'], blue: ['#cae8ff','#a5d6ff','#79c0ff','#58a6ff','#388bfd','#1f6feb','#1158c7','#0d419d','#0c2d6b','#051d4d'], neutral: ['#0d1117','#0d1117','#151b23','#212830','#262c36','#2a313c','#2f3742','#3d444d','#656c76','#9198a1'], bg: '#0d1117', inset: '#010409', muted: '#151b23', fgDefault: '#f0f6fc', fgMuted: '#9198a1', borderDefault: '#3d444d' }
};
function ghTheme(mode) {
  const g = gh[mode];
  const L = mode === 'light';
  const accents = {
    rosewater: L ? g.pink[2] : g.pink[3],
    flamingo: g.coral[3],
    pink: L ? g.pink[5] : g.pink[4],
    mauve: L ? g.purple[5] : g.purple[4],
    red: L ? g.red[5] : g.red[4],
    maroon: L ? g.red[6] : g.red[5],
    peach: L ? g.orange[5] : g.orange[4],
    yellow: L ? g.yellow[5] : g.yellow[3],
    green: L ? g.green[5] : g.green[4],
    teal: L ? g.green[4] : g.green[3],
    sky: g.blue[3],
    sapphire: L ? g.blue[5] : g.blue[4],
    blue: L ? g.blue[5] : g.blue[4],
    lavender: L ? g.purple[4] : g.purple[3]
  };
  return { mode, base: g.bg, mantle: g.inset, crust: g.muted, surface0: g.neutral[1], surface1: g.neutral[2], surface2: g.neutral[3], overlay0: g.borderDefault, overlay1: g.neutral[7], overlay2: g.neutral[8], subtext0: g.neutral[8], subtext1: g.fgMuted, text: g.fgDefault, accents, statusRed: accents.red, statusGreen: accents.green, statusYellow: accents.yellow };
}

// Solarized (Ethan Schoonover canonical)
const sol = { base03:'#002b36', base02:'#073642', base01:'#586e75', base00:'#657b83', base0:'#839496', base1:'#93a1a1', base2:'#eee8d5', base3:'#fdf6e3', yellow:'#b58900', orange:'#cb4b16', red:'#dc322f', magenta:'#d33682', violet:'#6c71c4', blue:'#268bd2', cyan:'#2aa198', green:'#859900' };
function solTheme() {
  const accents = {
    rosewater: mix(sol.magenta, sol.base3, 70),
    flamingo: mix(sol.orange, sol.magenta, 55),
    pink: sol.magenta,
    mauve: mix(sol.violet, sol.magenta, 70),
    red: sol.red,
    maroon: mix(sol.red, sol.orange, 65),
    peach: sol.orange,
    yellow: sol.yellow,
    green: sol.green,
    teal: sol.cyan,
    sky: mix(sol.cyan, sol.base3, 75),
    sapphire: mix(sol.blue, sol.cyan, 70),
    blue: sol.blue,
    lavender: sol.violet
  };
  return { mode: 'light', base: sol.base3, mantle: sol.base2, crust: mix(sol.base2, sol.base3, 50), surface0: sol.base2, surface1: mix(sol.base1, sol.base2, 50), surface2: sol.base1, overlay0: sol.base1, overlay1: sol.base0, overlay2: sol.base00, subtext0: sol.base1, subtext1: sol.base0, text: sol.base00, accents, statusRed: sol.red, statusGreen: sol.green, statusYellow: sol.yellow };
}

// Dracula (official)
const dra = { bg:'#282a36', currentLine:'#44475a', fg:'#f8f8f2', comment:'#6272a4', cyan:'#8be9fd', green:'#50fa7b', orange:'#ffb86c', pink:'#ff79c6', purple:'#bd93f9', red:'#ff5555', yellow:'#f1fa8c' };
function draTheme() {
  const accents = {
    rosewater: mix(dra.pink, dra.fg, 70),
    flamingo: mix(dra.orange, dra.pink, 55),
    pink: dra.pink,
    mauve: dra.purple,
    red: dra.red,
    maroon: mix(dra.red, dra.orange, 70),
    peach: dra.orange,
    yellow: dra.yellow,
    green: dra.green,
    teal: mix(dra.cyan, dra.green, 60),
    sky: dra.cyan,
    sapphire: mix(dra.cyan, dra.purple, 70),
    blue: mix(dra.cyan, dra.purple, 50),
    lavender: mix(dra.purple, dra.fg, 70)
  };
  return { mode: 'dark', base: dra.bg, mantle: mix(dra.bg, '#000000', 85), crust: mix(dra.bg, '#000000', 70), surface0: dra.currentLine, surface1: mix(dra.currentLine, dra.fg, 80), surface2: dra.comment, overlay0: dra.comment, overlay1: mix(dra.comment, dra.fg, 60), overlay2: dra.fg, subtext0: dra.comment, subtext1: mix(dra.comment, dra.fg, 50), text: dra.fg, accents, statusRed: dra.red, statusGreen: dra.green, statusYellow: dra.yellow };
}

// Assemble all theme token sets
const ACCENT_IDS = ['rosewater','flamingo','pink','mauve','red','maroon','peach','yellow','green','teal','sky','sapphire','blue','lavender'];
const THEME_ORDER = ['catppuccin-latte','github-light','solarized-light','catppuccin-frappe','catppuccin-macchiato','catppuccin-mocha','github-dark','dracula'];
const raw = {
  'catppuccin-latte': { ...ctp['catppuccin-latte'], statusRed: ctp['catppuccin-latte'].accents.red, statusGreen: ctp['catppuccin-latte'].accents.green, statusYellow: ctp['catppuccin-latte'].accents.yellow },
  'catppuccin-frappe': { ...ctp['catppuccin-frappe'], statusRed: ctp['catppuccin-frappe'].accents.red, statusGreen: ctp['catppuccin-frappe'].accents.green, statusYellow: ctp['catppuccin-frappe'].accents.yellow },
  'catppuccin-macchiato': { ...ctp['catppuccin-macchiato'], statusRed: ctp['catppuccin-macchiato'].accents.red, statusGreen: ctp['catppuccin-macchiato'].accents.green, statusYellow: ctp['catppuccin-macchiato'].accents.yellow },
  'catppuccin-mocha': { ...ctp['catppuccin-mocha'], statusRed: ctp['catppuccin-mocha'].accents.red, statusGreen: ctp['catppuccin-mocha'].accents.green, statusYellow: ctp['catppuccin-mocha'].accents.yellow },
  'github-light': ghTheme('light'),
  'github-dark': ghTheme('dark'),
  'solarized-light': solTheme(),
  'dracula': draTheme()
};

// ---------- build final tokens with contrast adjustments ----------
const audit = [];
const themes = {};
for (const id of THEME_ORDER) {
  const t = raw[id];
  const darken = t.mode === 'light';
  const bgs = [t.base, t.mantle];
  // text >= 4.5 on bg and mantle
  let text = t.text;
  if (!bgs.every((b) => contrast(text, b) >= 4.5)) { const nt = adjustForContrast(t.text, bgs, 4.5, darken); adjustments.push(`${id}: --color-text ${t.text} -> ${nt} (body text 4.5:1)`); text = nt; }
  // subtext (secondary) >= 4.5 on bg
  let subtext = t.subtext1; // secondary = darker/more-contrasting of the two
  if (contrast(subtext, t.base) < 4.5) { const ns = adjustForContrast(t.subtext1, [t.base], 4.5, darken); adjustments.push(`${id}: --color-subtext ${t.subtext1} -> ${ns} (secondary text 4.5:1)`); subtext = ns; }
  const subtext1 = t.subtext0; // tertiary (not required to meet 4.5)
  // border >= 3 on bg and mantle: pick lightest candidate meeting it, else adjust overlay2
  const borderCandidates = [t.overlay0, t.overlay1, t.overlay2, t.subtext0, t.subtext1 ?? subtext];
  let border = borderCandidates.find((c) => bgs.every((b) => contrast(c, b) >= 3));
  if (!border) { border = adjustForContrast(t.overlay2, bgs, 3, darken); adjustments.push(`${id}: --color-border -> ${border} (component boundary 3:1)`); }
  // accents: focus(=accent) must be >=3 on bg and mantle for every accent
  const accents = {};
  for (const a of ACCENT_IDS) {
    let c = t.accents[a];
    if (!bgs.every((b) => contrast(c, b) >= 3)) { const nc = adjustForContrast(t.accents[a], bgs, 3, darken); adjustments.push(`${id}: --accent-${a} ${t.accents[a]} -> ${nc} (focus/primary 3:1)`); c = nc; }
    accents[a] = c;
  }
  // on-destructive: >= 4.5 on status red (adjust red if neither bw works)
  let red = t.statusRed;
  let onDestructive = bestOn(red);
  if (contrast(onDestructive, red) < 4.5) { const nr = adjustForContrast(red, [bestOn(red) === '#000000' ? '#ffffff' : '#000000'], 4.5, bestOn(red) === '#000000'); red = nr; onDestructive = bestOn(red); adjustments.push(`${id}: --color-red ${t.statusRed} -> ${red} (on-destructive 4.5:1)`); }
  themes[id] = { mode: t.mode, background: t.base, mantle: t.mantle, crust: t.crust, surface: t.surface0, surface1: t.surface1, surface2: t.surface2, overlay: t.overlay0, overlay1: t.overlay1, overlay2: t.overlay2, text, subtext, subtext1, border, accents, red, green: t.statusGreen, yellow: t.statusYellow, onDestructive };
}

// per-theme per-accent on-primary / on-secondary, with accent adjusted so on-* reaches 4.5
function ensureOn(themeId, accentHex) {
  let fill = accentHex, on = bestOn(fill);
  if (contrast(on, fill) < 4.5) {
    const darken = bestOn(fill) === '#ffffff'; // if we want white text, darken the fill
    fill = adjustForContrast(accentHex, [bestOn(accentHex) === '#000000' ? '#ffffff' : '#000000'], 4.5, bestOn(accentHex) === '#000000');
    on = bestOn(fill);
  }
  return { fill, on };
}

// After adjusting accents for focus (3:1), some are mid-tone and need on-primary 4.5.
// We finalize each accent fill so BOTH focus(3:1 vs bg/mantle) AND on-primary(4.5) hold.
for (const id of THEME_ORDER) {
  const t = themes[id];
  const bgs = [t.background, t.mantle];
  const darken = t.mode === 'light';
  for (const a of ACCENT_IDS) {
    let fill = t.accents[a];
    // ensure a readable b/w foreground exists at 4.5
    let on = bestOn(fill);
    let guard = 0;
    while (contrast(on, fill) < 4.5 && guard++ < 200) {
      // push fill further toward black/white (whichever the foreground is NOT)
      fill = mix(fill, darken ? '#000000' : '#ffffff', 97);
      on = bestOn(fill);
      if (!bgs.every((b) => contrast(fill, b) >= 3)) { /* keep going, focus handled by direction */ }
    }
    if (fill !== t.accents[a]) { adjustments.push(`${id}: --accent-${a} ${t.accents[a]} -> ${fill} (on-primary 4.5:1)`); t.accents[a] = fill; }
    t.on = t.on || {};
    t.on[a] = on;
  }
}

// ---------- audit ----------
let failures = 0;
function chk(cond, msg) { if (!cond) { failures++; console.log('FAIL', msg); } }
for (const id of THEME_ORDER) {
  const t = themes[id];
  chk(contrast(t.text, t.background) >= 4.5, `${id} text/bg ${contrast(t.text,t.background).toFixed(2)}`);
  chk(contrast(t.text, t.mantle) >= 4.5, `${id} text/mantle ${contrast(t.text,t.mantle).toFixed(2)}`);
  chk(contrast(t.subtext, t.background) >= 4.5, `${id} subtext/bg ${contrast(t.subtext,t.background).toFixed(2)}`);
  chk(contrast(t.border, t.background) >= 3, `${id} border/bg ${contrast(t.border,t.background).toFixed(2)}`);
  chk(contrast(t.border, t.mantle) >= 3, `${id} border/mantle ${contrast(t.border,t.mantle).toFixed(2)}`);
  chk(contrast(t.onDestructive, t.red) >= 4.5, `${id} onDestructive/red ${contrast(t.onDestructive,t.red).toFixed(2)}`);
  for (const a of ACCENT_IDS) {
    chk(contrast(t.accents[a], t.background) >= 3, `${id} focus ${a}/bg ${contrast(t.accents[a],t.background).toFixed(2)}`);
    chk(contrast(t.accents[a], t.mantle) >= 3, `${id} focus ${a}/mantle ${contrast(t.accents[a],t.mantle).toFixed(2)}`);
    chk(contrast(t.on[a], t.accents[a]) >= 4.5, `${id} onPrimary ${a} ${contrast(t.on[a],t.accents[a]).toFixed(2)}`);
  }
}
console.log(failures === 0 ? 'ALL CONTRAST CHECKS PASS' : `${failures} FAILURES`);
console.log(`adjustments: ${adjustments.length}`);

// ---------- emit CSS ----------
function themeBlock(id) {
  const t = themes[id];
  const lines = [];
  lines.push(`[data-theme='${id}'] {`);
  lines.push(`  --color-background: ${t.background};`);
  lines.push(`  --color-mantle: ${t.mantle};`);
  lines.push(`  --color-crust: ${t.crust};`);
  lines.push(`  --color-surface: ${t.surface};`);
  lines.push(`  --color-surface-1: ${t.surface1};`);
  lines.push(`  --color-surface-2: ${t.surface2};`);
  lines.push(`  --color-overlay: ${t.overlay};`);
  lines.push(`  --color-overlay-1: ${t.overlay1};`);
  lines.push(`  --color-overlay-2: ${t.overlay2};`);
  lines.push(`  --color-text: ${t.text};`);
  lines.push(`  --color-subtext: ${t.subtext};`);
  lines.push(`  --color-subtext-1: ${t.subtext1};`);
  lines.push(`  --color-border: ${t.border};`);
  lines.push(`  --color-green: ${t.green};`);
  lines.push(`  --color-red: ${t.red};`);
  lines.push(`  --color-yellow: ${t.yellow};`);
  lines.push(`  --color-on-destructive: ${t.onDestructive};`);
  for (const a of ACCENT_IDS) lines.push(`  --accent-${a}: ${t.accents[a]};`);
  lines.push('}');
  return lines.join('\n');
}
function accentSelectors() {
  const lines = [];
  for (const a of ACCENT_IDS) lines.push(`[data-primary-accent='${a}'] { --primary-accent: var(--accent-${a}); }`);
  for (const a of ACCENT_IDS) lines.push(`[data-secondary-accent='${a}'] { --secondary-accent: var(--accent-${a}); }`);
  return lines.join('\n');
}
function onPrimarySelectors() {
  const lines = [];
  for (const id of THEME_ORDER) {
    const t = themes[id];
    for (const a of ACCENT_IDS) {
      lines.push(`[data-theme='${id}'][data-primary-accent='${a}'] { --color-on-primary: ${t.on[a]}; }`);
    }
    for (const a of ACCENT_IDS) {
      lines.push(`[data-theme='${id}'][data-secondary-accent='${a}'] { --color-on-secondary: ${t.on[a]}; }`);
    }
  }
  return lines.join('\n');
}

const header = `/*
 * GENERATED by tools gen (see apps/web/README.md palette provenance). Do not edit by hand.
 * Palette sources: Catppuccin v1.7.1; GitHub Primer Primitives v9.1.2 (closest
 * published release to the spec-named v9.3.0); Solarized (Ethan Schoonover
 * canonical); Dracula (official). Mixes are precomputed to hex. Tested tokens are
 * adjusted toward contrast thresholds where upstream values fail; see README.
 * Total contrast-driven adjustments: ${adjustments.length}.
 */`;

const css = [
  header,
  '',
  themeBlock('catppuccin-latte'),
  themeBlock('github-light'),
  themeBlock('solarized-light'),
  themeBlock('catppuccin-frappe'),
  themeBlock('catppuccin-macchiato'),
  themeBlock('catppuccin-mocha'),
  themeBlock('github-dark'),
  themeBlock('dracula'),
  '',
  '/* Accent selection: --primary-accent / --secondary-accent point at an accent id. */',
  accentSelectors(),
  '',
  '/* Computed primary/secondary foregrounds per theme and accent (on-primary >= 4.5:1). */',
  onPrimarySelectors(),
  ''
].join('\n');

const out = process.argv[2];
if (out) { writeFileSync(out, css); console.log('wrote', out, css.length, 'bytes'); }

// also dump adjustments for README
if (process.argv[3]) writeFileSync(process.argv[3], adjustments.join('\n') + '\n');
