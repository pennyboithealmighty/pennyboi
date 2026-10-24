// Explainer video sound toggle. Autoplay is only allowed while muted, so the
// video starts silent; the "Tap for sound" button unmutes it and restarts it
// from the beginning so nothing is missed. The button hides once sound is on
// (whether via the button or the native controls).
(function () {
  "use strict";
  var v = document.getElementById("explainer-video");
  var btn = document.getElementById("explainer-sound");
  if (!v || !btn) return;

  btn.addEventListener("click", function () {
    v.muted = false;
    v.volume = 1;
    try { v.currentTime = 0; } catch (e) {} // restart from 0:00
    var p = v.play();
    if (p && p.catch) p.catch(function () {});
    btn.hidden = true;
  });

  // If they unmute with the native controls instead, drop our button too.
  v.addEventListener("volumechange", function () {
    if (!v.muted && v.volume > 0) btn.hidden = true;
  });
})();
