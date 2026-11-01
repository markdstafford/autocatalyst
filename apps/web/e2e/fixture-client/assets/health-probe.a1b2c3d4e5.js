// Fixture client script. Its file name carries a content hash so it is served
// from `/assets/` with an immutable cache-control, exactly like a real built
// asset. The script fetches `/health` from its own origin (no token: the health
// route is public) and prints the returned status, proving a browser loads
// static files and reads the API from one origin with no proxy and no CORS.
(function () {
  var target = document.getElementById('health');
  fetch('/health')
    .then(function (response) {
      return response.json();
    })
    .then(function (body) {
      target.textContent = 'health: ' + body.status;
    })
    .catch(function () {
      target.textContent = 'health: error';
    });
})();
