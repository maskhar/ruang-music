import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
const config = loadConfig();
const instance = createApp(config);
instance.server.listen(config.port, '0.0.0.0', () => console.log(`Ruang Musik listening on port ${config.port}. Public origin: ${config.origin}`));
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => { instance.close(); process.exit(0); });
