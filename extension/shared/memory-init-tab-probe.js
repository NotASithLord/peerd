// @ts-check

export function probeMemoryInitTabInjected() {
  'use strict';
  const headings = [...document.querySelectorAll('h1,h2,h3')]
    .map((heading) => heading.textContent?.trim() ?? '').filter(Boolean).slice(0, 12);
  const text = (document.body?.innerText || '').slice(0, 1500);
  return { title: document.title, headings, textSnippet: text };
}
