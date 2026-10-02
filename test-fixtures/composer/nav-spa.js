// /nav/spa: once loaded, wait data-ms and move to /nav/spa-final with
// history.pushState, the way a client-side router changes the url of a page
// that has already finished loading.
(function () {
  var me = document.currentScript;
  var ms = Number((me && me.getAttribute("data-ms")) || 400);
  var where = document.getElementById("where");
  where.textContent = location.pathname;
  if (location.pathname === "/nav/spa") {
    setTimeout(function () {
      history.pushState({}, "", "/nav/spa-final");
      where.textContent = location.pathname;
    }, ms);
  }
})();
