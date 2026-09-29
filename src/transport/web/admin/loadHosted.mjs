import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

// The single place admin.mjs reaches hosted code. The open-source export drops
// the hosted directory, so a missing module means "no hosted commands". Existence is
// checked first so an error inside a present hosted module is never swallowed.
export const HOSTED_ADMIN_URL = new URL('../../../hosted/admin/commands.mjs', import.meta.url);

export async function loadHostedAdmin(ctx, url = HOSTED_ADMIN_URL) {
  if (!existsSync(fileURLToPath(url))) return null;
  const mod = await import(url.href);
  return mod.createHostedAdmin(ctx);
}
