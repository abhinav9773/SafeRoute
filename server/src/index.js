import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || '127.0.0.1';
const dist = path.resolve(here, '../../frontend/dist/index.html');
const { app, manager } = createApp();

const server = app.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`SafeRoute running. Dashboard: ${url}   (Ctrl+C to stop)`);
  if (!existsSync(dist)) {
    console.log('Note: frontend/dist not found. The API works, but the dashboard needs a build: npm run setup');
  } else if (!process.env.NO_BROWSER) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try: PORT=9000 npm start` : error.message);
  process.exit(1);
});
process.on('SIGINT', () => { manager.shutdown(); process.exit(0); });
