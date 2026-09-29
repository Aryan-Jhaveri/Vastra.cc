import { apiFetch } from './client'

/** Records one-time Terms of Service / Privacy Policy acceptance for the
 * current user (used by the billing flow for accounts that predate consent). */
export async function acceptTerms(): Promise<void> {
  const res = await apiFetch('/api/account/accept-terms', { method: 'POST' })
  if (!res.ok) throw new Error('Failed to record acceptance')
}

/** Permanently deletes the current user's account, including all items,
 * outfits, and images. This action cannot be undone. */
export async function deleteAccount(): Promise<void> {
  const res = await apiFetch('/api/account', { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete account')
}
