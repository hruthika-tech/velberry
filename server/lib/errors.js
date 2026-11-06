export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const bad = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg);
export const unauthorized = (msg = 'Please log in') => new HttpError(401, msg);
export const unavailable = (msg) => new HttpError(503, msg);
