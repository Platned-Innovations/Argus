/** Raised when a write violates a uniqueness constraint (e.g. duplicate username). */
export class DuplicateKeyError extends Error {
  constructor(public readonly field: string) {
    super(`Duplicate value for ${field}`);
    this.name = 'DuplicateKeyError';
  }
}
