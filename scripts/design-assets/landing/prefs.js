// Run in each page's head, before it paints: the language (a #zh or #en link,
// then the visitor's last choice, then the browser's) and a theme picked in
// this tab. Without a pick the theme follows the system, on every visit.
// The home page is written once in each language, / and /zh, and names both
// in its hreflang links: a #zh or #en link opens that one, / opens /zh for a
// visitor who reads Chinese, and /zh stays as it is. The information pages
// hold both languages and show the one picked.
(function () {
  var root = document.documentElement;
  var hash = location.hash === '#zh' || location.hash === '#en' ? location.hash.slice(1) : null;
  var lang = hash;
  var theme = null;
  if (!lang) try { lang = localStorage.getItem('drifting.landing.lang'); } catch (e) {}
  try { theme = sessionStorage.getItem('drifting.landing.theme'); } catch (e) {}
  // A theme once kept for good (the first days of the site) is let go.
  try { localStorage.removeItem('drifting.landing.theme'); } catch (e) {}
  if (lang !== 'zh' && lang !== 'en') lang = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  var written = root.getAttribute('data-lang');
  if (written) {
    var page = document.querySelector('link[rel="alternate"][hreflang="' + lang + '"]');
    var home = document.querySelector('link[rel="alternate"][hreflang="x-default"]');
    var atHome = home && location.pathname === new URL(home.href).pathname;
    // The link's hash goes along, so the page it opens keeps what it asked for.
    if (lang !== written && page && (hash || atHome)) location.replace(new URL(page.href).pathname + location.hash);
    return;
  }
  root.dataset.lang = lang;
  root.lang = lang === 'zh' ? 'zh-CN' : 'en';
})();
