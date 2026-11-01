/**
 * The inline first-paint theme script.
 *
 * This is the canonical source for the `<script>` embedded in `index.html`'s
 * `<head>` before the Vite module script. It must stay small, self-contained, and
 * independent of app code: it imports nothing and references no bundle globals, so
 * it can run before any application JavaScript loads and set the theme attributes
 * that avoid a light/dark flash on first paint.
 *
 * It intentionally duplicates the minimal subset of `preferences.ts` (valid id
 * lists, defaults, and the resolve rule). The build-order test asserts this exact
 * source appears inline in the built HTML, and a unit test executes it directly.
 */
export const FIRST_PAINT_SCRIPT = `(function () {
  try {
    var d = document.documentElement;
    var LIGHT = ['catppuccin-latte', 'github-light', 'solarized-light'];
    var DARK = ['catppuccin-frappe', 'catppuccin-macchiato', 'catppuccin-mocha', 'github-dark', 'dracula'];
    var ACC = ['rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach', 'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender'];
    var p = {};
    try {
      var raw = window.localStorage.getItem('autocatalyst.preferences');
      if (raw) { p = JSON.parse(raw) || {}; }
    } catch (e) { p = {}; }
    function pick(list, v, fb) { return list.indexOf(v) >= 0 ? v : fb; }
    var mode = pick(['system', 'light', 'dark'], p.themeMode, 'system');
    var light = pick(LIGHT, p.lightTheme, 'catppuccin-latte');
    var dark = pick(DARK, p.darkTheme, 'catppuccin-mocha');
    var pa = pick(ACC, p.primaryAccent, 'sapphire');
    var sa = pick(ACC, p.secondaryAccent, 'teal');
    var prefersDark = false;
    try { prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) {}
    var useDark = mode === 'dark' || (mode === 'system' && prefersDark);
    d.setAttribute('data-theme', useDark ? dark : light);
    d.setAttribute('data-theme-mode', useDark ? 'dark' : 'light');
    d.setAttribute('data-primary-accent', pa);
    d.setAttribute('data-secondary-accent', sa);
  } catch (e) {}
})();`;
