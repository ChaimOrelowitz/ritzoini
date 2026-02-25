/**
 * Format a raw phone number string to (###) ###-####
 * Works on input (strips non-digits, formats as you type)
 * and on display (formats stored values)
 */
export function formatPhoneDisplay(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0,3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6,10)}`;
}

/**
 * Strip all non-digit characters — store only raw digits (or with extension)
 */
export function stripPhone(formatted) {
  return formatted.replace(/\D/g, '');
}
