import { defineConfig, devices } from '@playwright/test';
const origin = 'http://127.0.0.1:' + (process.env.SPOTIFY_BROWSER_TEST_PORT || '3231');
export default defineConfig({ testDir:'./tests/browser',fullyParallel:false,use:{baseURL:origin,trace:'retain-on-failure'},projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'android',use:{...devices['Pixel 7']}}],webServer:{command:'node --import tsx tests/browser-server.ts',url:origin+'/healthz',reuseExistingServer:false},reporter:'list'});
