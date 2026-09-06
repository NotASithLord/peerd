declare module 'crx3' {
  import type { Readable } from 'node:stream';

  export default function crx3(
    input: Readable,
    options: { keyPath: string; crxPath: string },
  ): Promise<void>;
}
