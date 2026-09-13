export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly hint?: string;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

export function badRequest(code: string, message: string, hint?: string): AppError {
  return new AppError(400, code, message, hint);
}

export function newNotFound(message: string, hint?: string): AppError {
  return new AppError(404, 'not_found', message, hint);
}
