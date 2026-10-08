import { createServer } from 'node:net';
import { createBenfordServer } from './api/server.js';

const portArgument = process.argv.indexOf('--port');
const requestedPort = portArgument === -1 ? process.env.PORT : process.argv[portArgument + 1];
const dataDir = process.env.BENFORD_DATA_DIR ?? 'data';
const { server, store } = createBenfordServer(dataDir);

if (requestedPort) {
  const port = Number(requestedPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('端口必须是 1-65535 的整数。');
    process.exit(2);
  }
  server.listen(port, () => console.log(`Benford API 已启动：http://localhost:${port}`));
} else {
  const probe = createServer();
  probe.listen(0, () => {
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    probe.close(() => server.listen(port, () => console.log(`Benford API 已启动：http://localhost:${port}`)));
  });
}

function shutdown(): void {
  server.close(() => { store.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
