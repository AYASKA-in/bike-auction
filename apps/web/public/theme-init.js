// Applies a saved Light/Dark choice before first paint (no flash). "System" (the default) sets no
// attribute and lets CSS follow prefers-color-scheme. A classic, render-blocking script on purpose;
// it is an external file because the CSP forbids inline scripts.
/* global localStorage, document */
(function () {
  try {
    var t = localStorage.getItem("theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch {
    /* storage blocked: follow the system setting */
  }
})();
