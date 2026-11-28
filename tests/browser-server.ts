import { createApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { Store } from '../server/database.ts';
const port=process.env.SPOTIFY_BROWSER_TEST_PORT || '3231';
const config=loadConfig({...process.env,PORT:port,APP_ORIGIN:'http://127.0.0.1:'+port,ADMIN_PASSWORD:'browser-test-password',SPOTIFY_CLIENT_ID:'',WAHA_API_KEY:'',ENCRYPTION_KEY:'a'.repeat(64)});
createApp(config,new Store(':memory:')).server.listen(config.port,'127.0.0.1');
