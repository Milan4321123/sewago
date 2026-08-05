// Shared by every suite: ask the OS for a free port instead of pinning one.
//
// Suites used to hardcode ports (4979-4997). That worked until two checkouts
// ran the tests at the same time — parallel agent worktrees, or a stray
// `npm test` in another clone — and both grabbed the same ports: servers
// failed to bind, clients hit the *other* checkout's server, and unrelated
// suites died with ECONNRESET. An OS-assigned ephemeral port cannot collide.
const net = require('node:net');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

module.exports = { freePort };
