import { bad } from './errors.js';

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

/**
 * Tiny schema validator. rules: { field: { required, max, min, pattern, type: 'int'|'email'|'phone'|'pincode'|'bool', message } }
 */
export function validate(input, rules) {
  const out = {};
  const errors = {};
  for (const [key, r] of Object.entries(rules)) {
    let v = input?.[key];
    if (r.type === 'bool') { out[key] = v === true || v === 'true' || v === 1 || v === '1'; continue; }
    if (r.type === 'int') {
      if (v === '' || v == null) { if (r.required) errors[key] = r.message || 'Required'; else out[key] = r.default ?? null; continue; }
      const n = Number(v);
      if (!Number.isInteger(n)) { errors[key] = 'Must be a whole number'; continue; }
      if (r.min != null && n < r.min) { errors[key] = `Must be at least ${r.min}`; continue; }
      if (r.max != null && n > r.max) { errors[key] = `Must be at most ${r.max}`; continue; }
      out[key] = n; continue;
    }
    v = str(v);
    if (!v) { if (r.required) errors[key] = r.message || 'Required'; else out[key] = r.default ?? null; continue; }
    if (r.max && v.length > r.max) { errors[key] = `Keep it under ${r.max} characters`; continue; }
    if (r.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { errors[key] = 'Enter a valid email'; continue; }
    if (r.type === 'phone') {
      v = v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '');
      if (!/^[6-9]\d{9}$/.test(v)) { errors[key] = 'Enter a valid 10-digit Indian mobile number'; continue; }
    }
    if (r.type === 'pincode' && !/^[1-9]\d{5}$/.test(v)) { errors[key] = 'Enter a valid 6-digit PIN code'; continue; }
    if (r.pattern && !r.pattern.test(v)) { errors[key] = r.message || 'Invalid value'; continue; }
    if (r.min && v.length < r.min) { errors[key] = `At least ${r.min} characters`; continue; }
    out[key] = v;
  }
  if (Object.keys(errors).length) throw bad('Please check the highlighted fields', errors);
  return out;
}

export const addressRules = {
  name: { required: true, max: 80, message: 'Who is receiving the parcel?' },
  phone: { required: true, type: 'phone' },
  line1: { required: true, max: 160, message: 'House / street is required' },
  line2: { max: 160 },
  city: { required: true, max: 60 },
  state: { required: true, max: 60 },
  pincode: { required: true, type: 'pincode' },
};

export const INDIAN_STATES = [
  'Andaman and Nicobar Islands','Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chandigarh','Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu','Delhi','Goa','Gujarat','Haryana','Himachal Pradesh','Jammu and Kashmir',
  'Jharkhand','Karnataka','Kerala','Ladakh','Lakshadweep','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram',
  'Nagaland','Odisha','Puducherry','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh',
  'Uttarakhand','West Bengal',
];

export const slugify = (s) => str(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-|-$/g, '');
export const rupeesToPaise = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad('Invalid price');
  return Math.round(n * 100);
};
