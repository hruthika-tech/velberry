#!/usr/bin/env node
/**
 * Create / update Velberry's Supabase Storage buckets and check that nothing private is exposed.
 *
 *   npm run setup-storage
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server-only secret). Safe to re-run.
 *
 * Buckets (all hold ONLY public catalogue artwork — never customer data, invoices or shipping labels):
 *   product-images    cover & gallery photos      public read · 10 MB · jpg/png/webp/avif/svg
 *   product-360       360° turntable frames        public read · 10 MB · jpg/png/webp/avif
 *   category-images   optional category photos     public read ·  5 MB · jpg/png/webp/avif/svg
 *
 * "Public read" means a file can be downloaded by its exact URL (that's how the shop shows it). Uploading,
 * replacing, deleting and LISTING files is only possible with the service-role key, which stays on the server:
 * Storage denies those to the public (anon) key unless a storage.objects policy allows it, and this script
 * warns if any such policy exists.
 */
import crypto from 'node:crypto';

const { config } = await import('../server/config.js');
const storage = await import('../server/services/storage.js');
const S = config.supabase;

if (!storage.isRemote()) {
  console.error('\n✗ Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (see README → Supabase).\n');
  process.exit(1);
}

const problems = [];
const notes = [];
console.log(`\n🍓 Velberry Storage setup @ ${new URL(S.url).hostname}\n`);

/* 1. buckets */
await storage.ensureBuckets((m) => console.log(`   ${m}`));

/* 2. verify what Supabase now reports */
const ours = new Set(Object.keys(storage.BUCKETS));
console.log('');
for (const [id, want] of Object.entries(storage.BUCKETS)) {
  const b = await storage.getBucket(id);
  if (!b) { problems.push(`bucket ${id} is missing after setup`); continue; }
  const mimes = [...(b.allowed_mime_types || [])].sort().join(',');
  const okMime = mimes === [...want.mime].sort().join(',');
  const okSize = Number(b.file_size_limit) === want.limit;
  console.log(`   ${b.public && okMime && okSize ? '✓' : '✗'} ${id.padEnd(16)} public read: ${b.public ? 'yes' : 'no'} · max ${Math.round(want.limit / 1048576)} MB · ${want.mime.map((m) => m.split('/')[1]).join('/')}`);
  if (!b.public) problems.push(`${id} is not public — product images would not display`);
  if (!okMime) problems.push(`${id} allowed types are ${mimes || 'unrestricted'}`);
  if (!okSize) problems.push(`${id} size limit is ${b.file_size_limit ?? 'unlimited'}`);
}

/* 3. other public buckets in the project (could expose files that aren't ours) */
for (const b of await storage.listBuckets()) {
  if (!ours.has(b.id) && b.public) notes.push(`bucket "${b.id}" (not used by Velberry) is PUBLIC — make sure it holds nothing private`);
}

/* 4. storage.objects policies that would let the public key write or list (needs DATABASE_URL) */
if (config.db.url) {
  try {
    const { all, closeDb } = await import('../server/db/index.js');
    try {
      const hasStorage = await all("SELECT 1 FROM pg_namespace WHERE nspname = 'storage'");
      if (hasStorage.length) {
        const pol = await all(`SELECT policyname, cmd, roles::text AS roles, COALESCE(qual, '') || ' ' || COALESCE(with_check, '') AS expr
                               FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'`);
        for (const p of pol) {
          const publicRole = /public|anon|authenticated/.test(p.roles);
          const touchesOurs = [...ours].some((id) => p.expr.includes(`'${id}'`)) || !/bucket_id/.test(p.expr);
          if (publicRole && touchesOurs) {
            const what = p.cmd === 'SELECT' ? 'list/read via the API' : p.cmd === 'ALL' ? 'upload, change, delete and list' : p.cmd.toLowerCase();
            problems.push(`storage policy "${p.policyname}" lets ${p.roles} ${what} files in Velberry buckets — remove it unless intended`);
          }
        }
        console.log(`\n   ✓ checked ${pol.length} storage.objects polic${pol.length === 1 ? 'y' : 'ies'}`);
      }
    } finally { await closeDb(); }
  } catch (e) {
    notes.push(`could not inspect storage policies through DATABASE_URL (${e.message.split('\n')[0]})`);
  }
} else {
  notes.push('DATABASE_URL not set — skipped the storage policy check');
}

/* 5. live check: the public (anon) key must NOT be able to upload */
if (S.anonKey) {
  const id = S.buckets.products;
  const probe = `_velberry-security-check/${crypto.randomBytes(6).toString('hex')}.png`;
  const h = { apikey: S.anonKey, 'Content-Type': 'image/png', 'x-upsert': 'false' };
  if (S.anonKey.startsWith('eyJ')) h.Authorization = `Bearer ${S.anonKey}`;
  const res = await fetch(`${S.url}/storage/v1/object/${id}/${probe}`, { method: 'POST', headers: h, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  if (res.ok) {
    problems.push(`the PUBLIC anon key could upload to ${id} — a storage policy is too permissive (test file removed)`);
    await storage.removeImage(storage.publicUrl(id, probe)).catch(() => {});
  } else {
    console.log(`   ✓ anonymous upload to ${id} is refused (${res.status})`);
  }
} else {
  notes.push('SUPABASE_ANON_KEY not set — skipped the live "anonymous upload is refused" check');
}

for (const n of notes) console.log(`   • ${n}`);
if (problems.length) {
  console.log(`\n✗ ${problems.length} problem(s):`);
  for (const p of problems) console.log(`   • ${p}`);
  console.log('');
  process.exit(1);
}
console.log('\n✓ Storage is ready. Only catalogue images live here; uploads need the server-only secret key.\n');
