// Pure source injectors for throwaway Firefox diagnostic XPIs.
//
// Release staging compacts whitespace, so these test-only seams must match
// JavaScript syntax rather than source formatting. Every injector requires one
// exact semantic anchor. Zero or multiple matches fail instead of producing a
// diagnostic artifact that exercises the wrong code.

const replaceUnique = (source, pattern, replacement, label) => {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`);
  const matches = [...source.matchAll(matcher)];
  if (matches.length !== 1) {
    throw new Error(`${label} seam matched ${matches.length} locations; expected exactly one`);
  }
  const match = matches[0];
  const at = match.index;
  const inserted = replacement(match[0]);
  return source.slice(0, at) + inserted + source.slice(at + match[0].length);
};

export const injectFirefoxLifetimeProbe = (source) => replaceUnique(
  source,
  /(?:const|let|var)\s+([$\w]+)\s*=\s*[$\w]+\s*\?\.\s*[$\w]+\s*\?\.\s*\(\s*['"]storage\.session\.onChanged['"][\s\S]{0,800}?\1\s*\.\s*addListener\(\s*\(\s*(?:\/\*\*[\s\S]*?\*\/\s*)?[$\w]+\s*\)\s*=>\s*\{\s*[$\w]+\s*\?\.\s*onChanged\s*\(\s*[$\w]+\s*\)\s*;?\s*\}\s*\)\s*;?/g,
  (statement) => {
    const parameter = statement.match(
      /\.addListener\(\s*\(\s*(?:\/\*\*[\s\S]*?\*\/\s*)?([$\w]+)\s*\)/,
    )?.[1];
    if (!parameter) throw new Error('Firefox lifetime probe parameter is missing');
    return statement.replace(
      /([$\w]+\s*\?\.\s*onChanged\s*\(\s*[$\w]+\s*\)\s*;?)/,
      `globalThis.peerdFirefoxLifetimeProbe?.record(${parameter});$1`,
    );
  },
  'Firefox lifetime probe',
);

export const injectFirefoxKeepaliveLossFault = (source) => replaceUnique(
  source,
  /const\s+write\s*=\s*storage\s*\.\s*set\s*\(\s*\{\s*\[\s*key\s*\]\s*:\s*value\s*\}\s*\)\s*;/g,
  () => `const write = globalThis.peerdFirefoxKeepaliveLossFault?.consume()
      ? Promise.reject(new Error('Firefox runtime test fault: keepalive heartbeat failed'))
      : storage.set({ [key]: value });`,
  'Firefox keepalive fault',
);
