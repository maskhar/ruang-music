import { expect, test, type Page } from '@playwright/test';

const track = (index: number, status = 'queued') => ({
  id: `layout-${index}`, uri: `spotify:track:layout${index}`, title: `Lagu panjang untuk uji tata letak ${index}`,
  artist: 'Artis pengujian', album: '', image: '', durationMs: 240000,
  url: `https://open.spotify.com/track/layout${index}`, source: 'whatsapp', requester: 'Penguji',
  status, createdAt: index, startedAt: status === 'playing' ? 1 : null, positionMs: 0, error: ''
});

async function mockPlayer(page: Page) {
  const current = track(0, 'playing');
  const snapshot = {
    current, queue: Array.from({ length: 25 }, (_, i) => track(i + 1)),
    history: Array.from({ length: 20 }, (_, i) => track(i + 50, 'completed')),
    playback: { connected: true, paused: false, positionMs: 32000, durationMs: 240000,
      updatedAt: Date.now(), volume: 70, error: '', needsGesture: false },
    spotifyPlayback: { current, queue: [], observedAt: Date.now(), paused: false,
      positionMs: 32000, durationMs: 240000, deviceId: 'mock-device', deviceName: 'Browser uji',
      volume: 70, syncError: '', filteredCount: 0 },
    notificationsFailed: 0, spotifyConnected: true, spotifyConfigured: true, whatsappConfigured: true
  };
  await page.route('**/api/session', route => route.fulfill({ json: {
    authenticated: true, user: { id: 'owner', name: 'Pemilik', email: 'owner@local', admin: true },
    rooms: [{ id: 'default', name: 'Ruang utama', role: 'owner', groupId: '123456789@g.us' }]
  } }));
  await page.route('**/api/state', route => route.fulfill({ json: snapshot }));
  await page.routeWebSocket('**/ws**', socket => {
    socket.send(JSON.stringify({ type: 'hello', connectionId: 'layout-test' }));
    socket.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
  });
  await page.goto('/?room=default');
  await expect(page.locator('.queue-row', { hasText: 'Lagu panjang' })).toHaveCount(25);
}

test.describe('player layout desktop dan tablet', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Layout diuji pada Chromium');

  for (const [width, height] of [[1579, 893], [1366, 768], [1280, 720], [768, 1024], [1024, 768]]) {
    test(`${width}x${height}: player tetap terlihat, antrean dan riwayat scroll sendiri`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'Viewport eksplisit desktop; Android diuji terpisah');
      await page.setViewportSize({ width, height });
      await mockPlayer(page);

      await expect(page.locator('.art-stage')).toBeVisible();
      await expect(page.locator('.current-heading h2')).toContainText('Lagu panjang');
      await expect(page.locator('.playback-bar .transport')).toBeVisible();
      await expect(page.locator('.queue-list .queue-row').first()).toBeVisible();
      const layout = await page.evaluate(() => {
        const queue = document.querySelector('.queue-list')!;
        const main = document.querySelector('.main-content')!;
        const art = document.querySelector('.art-stage .cover-art')!.getBoundingClientRect();
        const title = document.querySelector('.current-heading h2')!.getBoundingClientRect();
        const controls = document.querySelector('.playback-bar .transport')!.getBoundingClientRect();
        return {
          rootScroll: document.documentElement.scrollHeight - window.innerHeight,
          rootHorizontalScroll: document.documentElement.scrollWidth - window.innerWidth,
          mainScroll: main.scrollHeight - main.clientHeight,
          queueScroll: queue.scrollHeight - queue.clientHeight,
          art: { top: art.top, bottom: art.bottom }, title: { top: title.top, bottom: title.bottom },
          controls: { top: controls.top, bottom: controls.bottom }
        };
      });
      expect(layout.rootScroll, JSON.stringify(layout)).toBeLessThanOrEqual(2);
      expect(layout.rootHorizontalScroll, JSON.stringify(layout)).toBeLessThanOrEqual(2);
      expect(layout.mainScroll, JSON.stringify(layout)).toBeLessThanOrEqual(2);
      expect(layout.queueScroll, JSON.stringify(layout)).toBeGreaterThan(40);
      for (const bounds of [layout.art, layout.title, layout.controls]) {
        expect(bounds.top, JSON.stringify(layout)).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom, JSON.stringify(layout)).toBeLessThanOrEqual(height + 1);
      }

      const queue = page.getByRole('region', { name: 'Daftar antrean' });
      await queue.focus();
      await page.keyboard.press('End');
      await expect(queue.locator('.queue-row').last()).toBeInViewport();
      await expect(page.locator('.playback-bar .transport')).toBeInViewport();

      await page.getByRole('button', { name: 'Riwayat', exact: true }).click();
      await expect(page.locator('.history-panel .queue-row')).toHaveCount(20);
      const history = await page.locator('.history-panel').evaluate(node => ({
        scroll: node.scrollHeight - node.clientHeight,
        rootScroll: document.documentElement.scrollHeight - window.innerHeight
      }));
      expect(history.scroll, JSON.stringify(history)).toBeGreaterThan(40);
      expect(history.rootScroll, JSON.stringify(history)).toBeLessThanOrEqual(2);
    });
  }
});
