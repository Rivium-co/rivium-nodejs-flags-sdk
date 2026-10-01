import { createHash } from 'crypto';

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
