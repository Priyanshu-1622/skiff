// Set the theme before React mounts so the page never flashes the wrong one.
// A separate file (not an inline <script>) so the Content-Security-Policy can
// forbid inline scripts entirely.
(function () {
  try {
    var saved = localStorage.getItem("skiff:theme");
    document.documentElement.setAttribute("data-theme", saved || "dark");
  } catch (_) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
