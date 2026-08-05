// Not a test file — shared by every *.test.js in this directory.
//
// Each test file boots its own real server, and for a long time each one
// hardcoded a port. That breaks the moment two checkouts run the suite at
// once (a worktree session, a dev server, a stray CI run): the second spawn
// loses the bind race, the health probe happily answers from the OTHER
// checkout's server, and every test runs against a stranger's state — mass
// 429s and phantom failures with nothing actually broken.
//
// Asking the OS for a port it just guaranteed free makes collisions
// impossible in practice, no matter how many suites run side by side.
const net = require('node:net');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

module.exports = { freePort };
