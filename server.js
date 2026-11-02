import { mkdirSync } from 'node:fs';
import { createApp } from './src/app.js';
import { openDb } from './src/db.js';

try { process.loadEnvFile(); } catch { /* .env is optional */ }

const url = process.env.DATABASE_URL || undefined;
const dataDir = process.env.DATA_DIR ?? './data';
const inMemory = dataDir === 'memory';
if (!url && !inMemory) mkdirSync(dataDir, { recursive: true });

if (!url && process.env.RENDER) console.warn('DATABASE_URL is not set: data will be lost on the next deploy or restart.');

const db = await openDb({ url, dataDir: inMemory ? undefined : dataDir });
const port = Number(process.env.PORT ?? 3000);
createApp(db).listen(port, () => {
  const store = url ? 'Postgres' : inMemory ? 'memory' : dataDir;
  console.log(`Anything is running at http://localhost:${port} (data: ${store})`);
});
