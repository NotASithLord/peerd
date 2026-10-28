import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { COMMONS_SEED, loadSeedApp } from '../../extension/peerd-distributed/apps/seed.js';

test('the Chat rooms seed keeps its durable key, and the Library and its own page show one plain name', async () => {
  const app = await loadSeedApp({ fetchText: (path) => readFile(`extension${path}`, 'utf8') });
  expect([COMMONS_SEED.key, app.name, app.dweb.seed]).toEqual(['commons', 'Chat rooms', 'commons']);
  const page = app.files['index.html'];
  expect(page).toContain('<title>Chat rooms</title>');
  expect(page).toContain('<h1>Chat rooms<span');
  expect(page.includes('Peerd-to-Peerd')).toBe(false);
});
