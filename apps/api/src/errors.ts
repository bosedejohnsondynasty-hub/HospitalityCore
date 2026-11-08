/** Typed application error with a stable machine-readable code. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

export const moduleNotLicensed = (moduleCode: string) =>
  new AppError(
    402,
    'MODULE_NOT_LICENSED',
    `Module ${moduleCode} is not licensed for this tenant. Activate it in the Licence Centre.`,
    { moduleCode },
  );

export function assertCondition(
  condition: unknown,
  statusCode: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new AppError(statusCode, code, message);
}
