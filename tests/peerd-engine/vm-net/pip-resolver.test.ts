import { describe, test, expect } from 'bun:test';
import {
  normalizeName, parseSpec, selectWheel, parseRequiresDist, resolveTree,
} from '../../../extension/peerd-engine/vm-net/pip-resolver.js';

describe('normalizeName / parseSpec', () => {
  test('PEP503 normalization', () => {
    expect(normalizeName('Foo_Bar.Baz')).toBe('foo-bar-baz');
  });
  test('parseSpec handles pins and specifiers', () => {
    expect(parseSpec('requests')).toEqual({ name: 'requests', version: null });
    expect(parseSpec('PyYAML==6.0.1')).toEqual({ name: 'pyyaml', version: '6.0.1' });
    expect(parseSpec('flask>=2.0')).toEqual({ name: 'flask', version: null });
  });
});

describe('selectWheel', () => {
  test('prefers a pure-python wheel', () => {
    const files = [
      { filename: 'pkg-1.0.tar.gz', url: 'u1', packagetype: 'sdist' },
      { filename: 'pkg-1.0-cp311-cp311-manylinux_x86_64.whl', url: 'u2', packagetype: 'bdist_wheel' },
      { filename: 'pkg-1.0-py3-none-any.whl', url: 'u3', packagetype: 'bdist_wheel' },
    ];
    expect(selectWheel(files)).toEqual({ url: 'u3', filename: 'pkg-1.0-py3-none-any.whl' });
  });
  test('falls back to a matching platform tag', () => {
    const files = [{ filename: 'pkg-1.0-cp311-cp311-manylinux2014_i686.whl', url: 'u', packagetype: 'bdist_wheel' }];
    expect(selectWheel(files, { pyTags: ['i686'] })).toEqual({ url: 'u', filename: 'pkg-1.0-cp311-cp311-manylinux2014_i686.whl' });
  });
  test('returns null for sdist-only / no compatible wheel', () => {
    expect(selectWheel([{ filename: 'pkg-1.0.tar.gz', url: 'u', packagetype: 'sdist' }])).toBeNull();
    expect(selectWheel([{ filename: 'pkg-1.0-cp311-cp311-manylinux_x86_64.whl', url: 'u', packagetype: 'bdist_wheel' }], { pyTags: ['i686'] })).toBeNull();
  });
  test('skips yanked files', () => {
    expect(selectWheel([{ filename: 'pkg-1.0-py3-none-any.whl', url: 'u', packagetype: 'bdist_wheel', yanked: true }])).toBeNull();
  });
});

describe('parseRequiresDist', () => {
  test('keeps mandatory deps, drops extras, strips specifiers/markers', () => {
    const rd = [
      'charset-normalizer (<4,>=2)',
      'idna (<4,>=2.5)',
      'urllib3 (>=1.21.1,<3)',
      'certifi (>=2017.4.17)',
      'PySocks (>=1.5.6) ; extra == "socks"',
      'chardet ; python_version < "3"',
    ];
    expect(parseRequiresDist(rd)).toEqual(['charset-normalizer', 'idna', 'urllib3', 'certifi', 'chardet']);
  });
});

describe('resolveTree', () => {
  const pypi: Record<string, any> = {
    requests: { info: { version: '2.31.0', requires_dist: ['urllib3 (>=1.21.1)', 'certifi', 'extra-thing ; extra == "x"'] },
      urls: [{ filename: 'requests-2.31.0-py3-none-any.whl', url: 'http/req.whl', packagetype: 'bdist_wheel' }] },
    urllib3: { info: { version: '2.0.0', requires_dist: [] },
      urls: [{ filename: 'urllib3-2.0.0-py3-none-any.whl', url: 'http/url.whl', packagetype: 'bdist_wheel' }] },
    certifi: { info: { version: '2024.1.1', requires_dist: null },
      urls: [{ filename: 'certifi-2024.1.1-py3-none-any.whl', url: 'http/cert.whl', packagetype: 'bdist_wheel' }] },
    numpy: { info: { version: '1.26.0', requires_dist: [] },
      urls: [{ filename: 'numpy-1.26.0-cp311-cp311-manylinux_x86_64.whl', url: 'http/np.whl', packagetype: 'bdist_wheel' }] },
  };
  const getJson = async (n: string) => pypi[n];

  test('resolves a pure-python transitive tree', async () => {
    const plan = await resolveTree(['requests'], getJson);
    expect(plan.map((p) => p.name).sort()).toEqual(['certifi', 'requests', 'urllib3']);
    expect(plan.find((p) => p.name === 'requests')?.url).toBe('http/req.whl');
  });

  test('fails loudly when a node needs a native wheel', async () => {
    await expect(resolveTree(['numpy'], getJson)).rejects.toThrow(/no pure-python\/compatible wheel for numpy/);
  });

  test('throws on a missing package', async () => {
    await expect(resolveTree(['ghost'], getJson)).rejects.toThrow(/not found/);
  });
});
