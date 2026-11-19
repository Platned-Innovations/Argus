// Applies the saved theme before first paint (external file: the CSP forbids inline scripts).
(function () {
  try {
    var m = localStorage.getItem('argus-theme');
    var dark = m === 'dark' || ((m !== 'light') && matchMedia('(prefers-color-scheme: dark)').matches);
    var r = document.documentElement;
    r.classList.toggle('dark', dark);
    r.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {}
})();
