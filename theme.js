// Runs before first paint so the page never flashes the wrong theme.
(function () {
  var stored = null;
  try { stored = localStorage.getItem('theme'); } catch (e) {}
  var theme = stored === 'light' || stored === 'dark'
    ? stored
    : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
})();
