import { createApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { Store } from '../server/database.ts';
const config=loadConfig({...process.env,PORT:'3211',APP_ORIGIN:'http://127.0.0.1:3211',ADMIN_PASSWORD:'browser-test-password',SPOTIFY_CLIENT_ID:'',WAHA_API_KEY:'',ENCRYPTION_KEY:'a'.repeat(64)});
createApp(config,new Store(':memory:')).server.listen(3211,'127.0.0.1');
