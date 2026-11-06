/**
 * Security headers for every response. On Vercel, static pages are served by the CDN (not Express), so vercel.json
 * repeats these exact headers — test/vercel.test.js fails if the two ever drift apart.
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://checkout.razorpay.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    // *.supabase.co: the admin uploads product photos straight to Supabase Storage (one-time signed URLs)
    "connect-src 'self' https://*.razorpay.com https://*.supabase.co",
    "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
    "frame-ancestors 'self'",
  ].join('; '),
};
