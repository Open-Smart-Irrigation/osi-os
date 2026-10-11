export class DemoError extends Error {
  constructor(
    public status: number,
    public code: string,
    public data?: unknown,
    public headers: Record<string, string> = {'content-type': 'application/json'},
  ) {
    super(code);
    this.name = 'DemoError';
  }
}
