// Mobile nav: the hamburger toggles a full-width dropdown of the nav links below
// ~900px. Accessible: aria-expanded tracks state, focus moves into the menu on
// open, and it closes on link tap, Escape (focus returns to the button), or an
// outside tap.
(function () {
  "use strict";
  var toggle = document.getElementById("nav-toggle");
  var menu = document.getElementById("nav-links");
  if (!toggle || !menu) return;

  function isOpen() {
    return menu.classList.contains("open");
  }

  function onKey(e) {
    if (e.key === "Escape" || e.key === "Esc") {
      close();
      toggle.focus();
    }
  }

  function onOutside(e) {
    if (!menu.contains(e.target) && !toggle.contains(e.target)) close();
  }

  function open() {
    menu.classList.add("open");
    toggle.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onOutside, true);
    var first = menu.querySelector("a");
    if (first) first.focus();
  }

  function close() {
    menu.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("click", onOutside, true);
  }

  toggle.addEventListener("click", function (e) {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  });

  // Tapping any link closes the sheet (navigation or in-page anchor).
  menu.addEventListener("click", function (e) {
    if (e.target.closest("a")) close();
  });
})();
