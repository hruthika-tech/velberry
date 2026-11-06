/**
 * A tiny in-memory stand-in for the Supabase Storage REST API (only the calls Velberry uses),
 * so the storage setup and image migration can be tested without a real Supabase project.
 * Behaves like Supabase where it matters: the service key is required for writes and private reads,
 * an existing object is NOT overwritten unless x-upsert is true, and public buckets serve /object/public/….
 */
import http from 'node:http';

export async function startFakeStorage({ serviceKey }) {
  const buckets = new Map(); // id → settings
  const objects = new Map(); // `${bucket}/${path}` → { body, type }
  const signed = new Map();  // upload token → { key, exp }
  const send = (res, status, data, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname).replace(/^\/storage\/v1/, '');
    const isService = req.headers.apikey === serviceKey;
    let m;

    if ((m = /^\/object\/public\/([^/]+)\/(.+)$/.exec(p)) && req.method === 'GET') {
      const o = objects.get(`${m[1]}/${m[2]}`);
      if (!buckets.get(m[1])?.public || !o) return send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return send(res, 200, o.body, o.type);
    }
    // Signed upload (browser): PUT /object/upload/sign/<bucket>/<path>?token=… — no key, the token is the permission.
    // Like Supabase: the token is bound to that exact object, the bucket's size limit and allowed types apply,
    // and an existing object is not overwritten (x-upsert defaults to false).
    if ((m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(p)) && req.method === 'PUT') {
      const grant = signed.get(url.searchParams.get('token') || '');
      if (!grant || grant.key !== `${m[1]}/${m[2]}` || grant.exp < Date.now()) return send(res, 400, { statusCode: '403', error: 'InvalidSignature', message: 'invalid signature' });
      const b = buckets.get(m[1]);
      let file = body;
      let type = req.headers['content-type'];
      if (/^multipart\/form-data/.test(type || '')) {
        const form = await new Request('http://x', { method: 'PUT', headers: { 'content-type': type }, body }).formData();
        const part = [...form.values()].find((v) => typeof v === 'object');
        file = Buffer.from(await part.arrayBuffer());
        type = part.type;
      }
      if (b.allowed_mime_types && !b.allowed_mime_types.includes(type)) return send(res, 400, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` });
      if (b.file_size_limit && file.length > b.file_size_limit) return send(res, 400, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
      if (objects.has(grant.key) && req.headers['x-upsert'] !== 'true') return send(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      objects.set(grant.key, { body: file, type });
      return send(res, 200, { Key: grant.key });
    }
    if (!isService) return send(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });

    if ((m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(p)) && req.method === 'POST') {
      if (!buckets.has(m[1])) return send(res, 400, { statusCode: '404', error: 'Bucket not found' });
      const token = `tok.${Math.random().toString(36).slice(2)}${Date.now()}`;
      signed.set(token, { key: `${m[1]}/${m[2]}`, exp: Date.now() + 2 * 3600e3 });
      return send(res, 200, { url: `/object/upload/sign/${m[1]}/${m[2].split('/').map(encodeURIComponent).join('/')}?token=${token}` });
    }

    if (p === '/bucket' && req.method === 'GET') return send(res, 200, [...buckets.values()]);
    if (p === '/bucket' && req.method === 'POST') {
      const b = JSON.parse(body);
      buckets.set(b.id, b);
      return send(res, 200, { name: b.id });
    }
    if ((m = /^\/bucket\/([^/]+)$/.exec(p))) {
      if (req.method === 'GET') return buckets.has(m[1]) ? send(res, 200, buckets.get(m[1])) : send(res, 400, { statusCode: '404', error: 'Bucket not found' });
      if (req.method === 'PUT') { buckets.set(m[1], { ...buckets.get(m[1]), ...JSON.parse(body) }); return send(res, 200, { message: 'Successfully updated' }); }
    }
    if ((m = /^\/object\/([^/]+)\/(.+)$/.exec(p))) {
      const key = `${m[1]}/${m[2]}`;
      if (req.method === 'POST') {
        const b = buckets.get(m[1]);
        if (!b) return send(res, 400, { statusCode: '404', error: 'Bucket not found' });
        if (b.allowed_mime_types && !b.allowed_mime_types.includes(req.headers['content-type'])) return send(res, 400, { statusCode: '415', error: 'invalid_mime_type' });
        if (objects.has(key) && req.headers['x-upsert'] !== 'true') return send(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        objects.set(key, { body, type: req.headers['content-type'] });
        return send(res, 200, { Key: key });
      }
      if (req.method === 'GET') {
        const o = objects.get(key);
        return o ? send(res, 200, o.body, o.type) : send(res, 400, { statusCode: '404', error: 'not_found' });
      }
    }
    if ((m = /^\/object\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
      for (const pre of JSON.parse(body).prefixes || []) objects.delete(`${m[1]}/${pre}`);
      return send(res, 200, []);
    }
    send(res, 404, { error: `fake storage: no route for ${req.method} ${p}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    buckets,
    objects,
    close: () => new Promise((r) => server.close(r)),
  };
}
