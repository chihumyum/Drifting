// Run in each page's head, before it paints: the language (a #zh or #en link,
// then the visitor's last choice, then the browser's) and a theme picked in
// this tab. Without a pick the theme follows the system, on every visit.
(function () {
  var root = document.documentElement;
  var lang = location.hash === '#zh' || location.hash === '#en' ? location.hash.slice(1) : null;
  var theme = null;
  if (!lang) try { lang = localStorage.getItem('drifting.landing.lang'); } catch (e) {}
  try { theme = sessionStorage.getItem('drifting.landing.theme'); } catch (e) {}
  // A theme once kept for good (the first days of the site) is let go.
  try { localStorage.removeItem('drifting.landing.theme'); } catch (e) {}
  if (lang !== 'zh' && lang !== 'en') lang = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  root.dataset.lang = lang;
  root.lang = lang === 'zh' ? 'zh-CN' : 'en';
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
})();
