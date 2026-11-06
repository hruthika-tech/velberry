/**
 * Image storage — Supabase Storage in production, local disk as a development fallback.
 *
 * Buckets (public-read, server-write):
 *   product-images   cover & gallery photos      product-images/<productId>/<random>.<ext>
 *   product-360      360° turntable frames        product-360/<productId>/<random>.<ext>
 *   category-images  optional category photos     category-images/<categoryId>/<random>.<ext>
 *
 * Uploads/deletes use the SECRET (service-role) key, which never leaves the server.
 * Public buckets serve files over Supabase's CDN at /storage/v1/object/public/<bucket>/<path>.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ROOT } from '../config.js';
import { HttpError } from '../lib/errors.js';

const S = config.supabase;
export const isRemote = () => S.storageEnabled;

export const BUCKETS = {
  [S.buckets.products]: { mime: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml'], limit: 10 * 1024 * 1024 },
  [S.buckets.angles]: { mime: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'], limit: 10 * 1024 * 1024 },
  [S.buckets.categories]: { mime: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml'], limit: 5 * 1024 * 1024 },
};

function headers(extra = {}) {
  // New "sb_secret_…" keys go in the apikey header; legacy service_role JWTs also as a Bearer token.
  const h = { apikey: S.serviceKey, ...extra };
  if (S.serviceKey.startsWith('eyJ')) h.Authorization = `Bearer ${S.serviceKey}`;
  return h;
}

async function call(method, urlPath, { body, headers: extra, raw = false } = {}) {
  const res = await fetch(`${S.url}/storage/v1${urlPath}`, {
    method,
    headers: headers(extra),
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok && !raw) throw new HttpError(502, `Supabase Storage ${method} ${urlPath}: ${data?.message || data?.error || res.status}`);
  return { status: res.status, data };
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
export const publicUrl = (bucket, objectPath) => `${S.url}/storage/v1/object/public/${bucket}/${encodePath(objectPath)}`;

/** Create the buckets if missing and enforce their settings (public read, size limit, allowed types). */
export async function ensureBuckets(log = () => {}) {
  if (!isRemote()) throw new Error('Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  for (const [id, b] of Object.entries(BUCKETS)) {
    const body = JSON.stringify({ id, name: id, public: true, file_size_limit: b.limit, allowed_mime_types: b.mime });
    const existing = await call('GET', `/bucket/${id}`, { raw: true });
    if (existing.status === 200) {
      await call('PUT', `/bucket/${id}`, { body, headers: { 'Content-Type': 'application/json' } });
      log(`✿ bucket ${id} ok`);
    } else {
      await call('POST', '/bucket', { body, headers: { 'Content-Type': 'application/json' } });
      log(`✿ bucket ${id} created`);
    }
  }
}

/**
 * Store an image and return its public URL.
 * @param {{bucket:string, folder:string|number, buffer:Buffer, ext:string, contentType:string, name?:string}} o
 */
export async function putImage({ bucket, folder, buffer, ext, contentType, name }) {
  const file = name || `${crypto.randomBytes(9).toString('hex')}.${ext}`;
  if (isRemote()) {
    const objectPath = `${folder}/${file}`;
    await call('POST', `/object/${bucket}/${encodePath(objectPath)}`, {
      body: buffer,
      headers: { 'Content-Type': contentType, 'x-upsert': 'true', 'cache-control': 'max-age=31536000' },
    });
    return publicUrl(bucket, objectPath);
  }
  // development fallback
  const dir = path.join(config.uploadDir, String(folder));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buffer);
  const rel = path.relative(path.join(ROOT, 'public'), path.join(dir, file)).split(path.sep).join('/');
  return rel.startsWith('..') ? `/uploads/products/${folder}/${file}` : `/${rel}`;
}

/**
 * Upload to an exact object path WITHOUT overwriting anything already there (used by the SQLite migration).
 * Returns 'created', or 'exists' when an object is already stored at that path (its content is not touched).
 */
export async function putObjectIfAbsent({ bucket, objectPath, buffer, contentType }) {
  if (!isRemote()) throw new Error('Supabase Storage is not configured');
  const r = await call('POST', `/object/${bucket}/${encodePath(objectPath)}`, {
    body: buffer,
    headers: { 'Content-Type': contentType, 'x-upsert': 'false', 'cache-control': 'max-age=31536000' },
    raw: true,
  });
  if (r.status >= 200 && r.status < 300) return 'created';
  // Supabase answers "already exists" with 409, or with 400 + statusCode "409" in older versions.
  if (r.status === 409 || String(r.data?.statusCode) === '409' || /already exists|duplicate/i.test(String(r.data?.message || r.data?.error || ''))) return 'exists';
  throw new HttpError(502, `Supabase Storage upload ${bucket}/${objectPath}: ${r.data?.message || r.data?.error || r.status}`);
}

/** Download an object with the server key (works for public and private buckets). Returns a Buffer, or null if missing. */
export async function getObject(bucket, objectPath) {
  if (!isRemote()) throw new Error('Supabase Storage is not configured');
  const res = await fetch(`${S.url}/storage/v1/object/${bucket}/${encodePath(objectPath)}`, { headers: headers(), signal: AbortSignal.timeout(60_000) });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new HttpError(502, `Supabase Storage download ${bucket}/${objectPath}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** All buckets in the project. */
export async function listBuckets() {
  return (await call('GET', '/bucket')).data || [];
}

/** Bucket settings as Supabase reports them (or null if the bucket doesn't exist). */
export async function getBucket(id) {
  const r = await call('GET', `/bucket/${id}`, { raw: true });
  return r.status === 200 ? r.data : null;
}

/** Delete an image previously returned by putImage (no-op for files we don't own, e.g. bundled seed art). */
export async function removeImage(url) {
  if (!url) return;
  const prefix = `${S.url}/storage/v1/object/public/`;
  if (isRemote() && url.startsWith(prefix)) {
    const [bucket, ...rest] = url.slice(prefix.length).split('/');
    const objectPath = rest.map(decodeURIComponent).join('/');
    await call('DELETE', `/object/${bucket}`, { body: JSON.stringify({ prefixes: [objectPath] }), headers: { 'Content-Type': 'application/json' }, raw: true });
    return;
  }
  if (url.startsWith('/uploads/products/')) fs.rm(path.join(ROOT, 'public', url), { force: true }, () => {});
}

/* ───────── direct browser → Supabase Storage uploads ─────────
 * Vercel functions accept at most 4.5 MB per request, so photos go straight from the admin's browser to Supabase:
 *  1. the server (admin only) checks the declared type and size and asks Supabase for a one-time signed upload URL
 *     for a random path inside the right bucket/folder, plus an HMAC-signed "ticket" naming exactly that object;
 *  2. the browser uploads the file to that URL (Supabase enforces the bucket's size limit and allowed types);
 *  3. the browser hands the ticket back; the server downloads the object, checks its real type by magic bytes
 *     and its size, and only then attaches it to the product. Anything that fails the check is deleted.
 * The service key never leaves the server; the browser only ever holds a URL that can write one new object.
 */
export const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };
const TICKET_TTL_MS = 2 * 60 * 60e3; // Supabase signed upload URLs are valid for 2 hours
const sign = (payload) => crypto.createHmac('sha256', config.sessionSecret).update(`upload-ticket\n${payload}`).digest('base64url');

export async function createSignedUpload({ bucket, folder, contentType, size, maxBytes }) {
  if (!isRemote()) throw new Error('Supabase Storage is not configured');
  const ext = UPLOAD_TYPES[contentType];
  if (!ext) throw new HttpError(400, 'is not a JPG, PNG, WebP or AVIF image');
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'has no size');
  if (size > maxBytes) throw new HttpError(400, `is larger than ${Math.round(maxBytes / 1048576)} MB`);
  const objectPath = `${folder}/${crypto.randomBytes(9).toString('hex')}.${ext}`;
  const r = await call('POST', `/object/upload/sign/${bucket}/${encodePath(objectPath)}`, { body: '{}', headers: { 'Content-Type': 'application/json' } });
  const rel = typeof r.data?.url === 'string' ? r.data.url : '';
  if (!rel.startsWith('/object/upload/sign/') || !/[?&]token=/.test(rel)) throw new HttpError(502, 'Supabase Storage did not return an upload URL');
  const payload = [bucket, objectPath, contentType, size, Date.now() + TICKET_TTL_MS].join('|');
  return { uploadUrl: `${S.url}/storage/v1${rel}`, ticket: `${Buffer.from(payload).toString('base64url')}.${sign(payload)}` };
}

/** Check a ticket issued by createSignedUpload for this bucket + folder → { bucket, objectPath, contentType, size }. */
export function readUploadTicket(ticket, { bucket, folder }) {
  const [b64, mac] = String(ticket || '').split('.');
  const payload = b64 ? Buffer.from(b64, 'base64url').toString('utf8') : '';
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(String(mac || ''));
  if (!payload || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HttpError(400, 'Invalid upload — please upload the image again');
  const [b, objectPath, contentType, size, exp] = payload.split('|');
  if (b !== bucket || !objectPath.startsWith(`${folder}/`)) throw new HttpError(400, 'That upload belongs to a different item');
  if (Date.now() > Number(exp)) throw new HttpError(400, 'That upload has expired — please upload the image again');
  return { bucket: b, objectPath, contentType, size: Number(size) };
}

/** Delete one object by bucket + path (ignores "not found"). */
export async function removeObject(bucket, objectPath) {
  if (!isRemote()) return;
  await call('DELETE', `/object/${bucket}`, { body: JSON.stringify({ prefixes: [objectPath] }), headers: { 'Content-Type': 'application/json' }, raw: true });
}
