// audit-template.js
// Client-side behaviour for the audit report:
//   - dark/light theme toggle, persisted in localStorage
//   - free-text filter on the icon path
//   - "warnings only" filter
//   - sort selector (path, icon size, file size, warnings first)
//
// The theme changes chrome colors only. Icon rendering is never affected.

(function () {
  // ----- theme -----
  var root = document.documentElement;
  var toggle = document.getElementById('themeToggle');

  // Resolve the theme deterministically on load: localStorage wins, then
  // the OS preference. We always write the result back to data-theme so the
  // CSS never has to fall back on @media (prefers-color-scheme).
  function resolveInitialTheme() {
    var stored = null;
    try { stored = localStorage.getItem('audit-theme'); } catch (e) {}
    if (stored === 'dark' || stored === 'light') return stored;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  }
  function currentTheme() {
    return root.getAttribute('data-theme') || 'light';
  }
  function refreshToggle() {
    var t = currentTheme();
    toggle.textContent = t === 'dark' ? '☀️ Light' : '🌙 Dark';
    toggle.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  root.setAttribute('data-theme', resolveInitialTheme());
  refreshToggle();

  toggle.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('audit-theme', next); } catch (e) {}
    refreshToggle();
  });

  // ----- filtering and sorting -----
  var grid = document.getElementById('grid');
  var cards = Array.prototype.slice.call(grid.children).filter(function (el) {
    return el.classList.contains('card');
  });
  var q = document.getElementById('q');
  var onlyWarn = document.getElementById('onlyWarn');
  var sortSel = document.getElementById('sort');
  var count = document.getElementById('count');

  function apply() {
    var term = q.value.trim().toLowerCase();
    var w = onlyWarn.checked;
    var visible = 0;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var path = card.dataset.path.toLowerCase();
      var isWarn = card.dataset.warn === '1';
      var ok = (term === '' || path.indexOf(term) !== -1) && (!w || isWarn);
      card.hidden = !ok;
      if (ok) visible++;
    }
    count.textContent = visible + ' / ' + cards.length;
  }

  function sortCards() {
    var mode = sortSel.value;
    var sorted = cards.slice().sort(function (a, b) {
      var pa = a.dataset.path, pb = b.dataset.path;
      var ma = Number(a.dataset.min), mb = Number(b.dataset.min);
      var fa = Number(a.dataset.size), fb = Number(b.dataset.size);
      if (mode === 'path-desc') return pb.localeCompare(pa, 'en');
      if (mode === 'size-asc')  return (ma - mb) || pa.localeCompare(pb, 'en');
      if (mode === 'size-desc') return (mb - ma) || pa.localeCompare(pb, 'en');
      if (mode === 'filesize-asc')  return (fa - fb) || pa.localeCompare(pb, 'en');
      if (mode === 'filesize-desc') return (fb - fa) || pa.localeCompare(pb, 'en');
      if (mode === 'warn-first')
        return (Number(b.dataset.warn) - Number(a.dataset.warn)) || pa.localeCompare(pb, 'en');
      return pa.localeCompare(pb, 'en');
    });
    for (var i = 0; i < sorted.length; i++) grid.appendChild(sorted[i]);
  }

  q.addEventListener('input', apply);
  onlyWarn.addEventListener('change', apply);
  sortSel.addEventListener('change', function () { sortCards(); apply(); });

  apply();
})();