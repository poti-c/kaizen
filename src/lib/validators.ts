// Shared form validators — import these instead of writing inline validation per page
// so the same rule (e.g. password min length) is enforced consistently everywhere.
// Each function returns null on success or a user-facing error string on failure.

export function validatePassword(pwd: string): string | null {
  if (pwd.length < 8) return 'Password must be at least 8 characters.'
  return null
}

export function validatePasswordsMatch(pwd: string, confirm: string): string | null {
  if (pwd !== confirm) return 'Passwords do not match.'
  return null
}

export function validateRequired(value: string | null | undefined, fieldName: string): string | null {
  if (!value?.trim()) return `${fieldName} is required.`
  return null
}

export function validatePositiveAmount(value: number | null | undefined, fieldName = 'Amount'): string | null {
  if (value == null || !isFinite(value) || value <= 0) return `${fieldName} must be greater than zero.`
  return null
}

export function validatePercentDiscount(value: number | null | undefined): string | null {
  if (value == null || !isFinite(value) || value <= 0 || value > 100) return 'Discount must be between 1 and 100.'
  return null
}
