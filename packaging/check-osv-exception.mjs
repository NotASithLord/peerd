import { checkDeepmergeException } from './check-deepmerge-exception.mjs';
import { fileURLToPath } from 'node:url';

export function checkExceptionScope(root, now = Date.now()) {
  checkDeepmergeException(root, now);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkExceptionScope(fileURLToPath(new URL('../', import.meta.url)));
  console.log('OSV exception scope OK');
}
