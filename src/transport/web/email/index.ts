import { Resend } from 'resend'

let _client: Resend | null = null

export function getClient(): Resend {
  if (!_client) {
    const key = process.env.RESEND_API_KEY
    if (!key) throw new Error('RESEND_API_KEY not set')
    _client = new Resend(key)
  }
  return _client
}

export const FROM_NOREPLY = process.env.RESEND_FROM_NOREPLY ?? 'no-reply@vastra.cc'
const FROM_SUPPORT = process.env.RESEND_FROM_SUPPORT ?? 'support@vastra.cc'

export async function sendWelcomeEmail(to: string, name?: string): Promise<void> {
  if (!process.env.RESEND_API_KEY) return
  const displayName = name ?? to.split('@')[0]
  await getClient().emails.send({
    from: FROM_NOREPLY,
    to,
    subject: 'Welcome to Vastra',
    html: welcomeHtml(displayName),
  })
}

export async function sendSignInLinkEmail(to: string, link: string, expiryMinutes = 15): Promise<void> {
  if (!process.env.RESEND_API_KEY) return
  await getClient().emails.send({
    from: FROM_NOREPLY,
    to,
    subject: 'Your Vastra sign-in link',
    html: signinLinkHtml(link, expiryMinutes),
  })
}

// ─── Templates ────────────────────────────────────────────────────────────────

const baseStyle = `
  font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
  background: #ffffff;
  color: #111111;
  max-width: 560px;
  margin: 0 auto;
  padding: 40px 32px;
  border: 2px solid #111111;
`

const btnStyle = `
  display: inline-block;
  background: #111111;
  color: #ffffff !important;
  padding: 14px 28px;
  font-family: inherit;
  font-weight: 700;
  font-size: 15px;
  text-decoration: none;
  border: 2px solid #111111;
  letter-spacing: 0.02em;
`

export const dividerStyle = `border: none; border-top: 2px solid #111111; margin: 32px 0;`

export const footerStyle = `font-size: 12px; color: #555555; margin-top: 32px;`

export function shell(content: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Vastra</title></head><body style="margin:0;padding:16px;background:#f5f5f5;"><div style="${baseStyle}">${content}</div></body></html>`
}

function welcomeHtml(name: string): string {
  return shell(`
    <h1 style="font-size:28px;font-weight:900;margin:0 0 8px;">Welcome to Vastra, ${name}.</h1>
    <p style="font-size:16px;margin:0 0 24px;color:#333;">Your Smart Wardrobe</p>
    <hr style="${dividerStyle}">
    <p style="margin:0 0 12px;">Here's what you can do:</p>
    <ul style="margin:0 0 24px;padding-left:20px;line-height:1.8;">
      <li>📸 Photograph your clothes and let AI categorize them</li>
      <li>🌤 Get daily outfit suggestions based on the weather</li>
      <li>👗 Virtual try-on to see how outfits look before you wear them</li>
      <li>🤝 Share outfits with friends on Vastra — match looks between closets to coordinate</li>
    </ul>
    <a href="https://vastra.cc" style="${btnStyle}">Open Vastra →</a>
    <hr style="${dividerStyle}">
    <p style="${footerStyle}">Questions? Reply to <a href="mailto:support@vastra.cc">support@vastra.cc</a></p>
  `)
}

function signinLinkHtml(link: string, expiryMinutes: number): string {
  return shell(`
    <h1 style="font-size:24px;font-weight:900;margin:0 0 8px;">Sign in to Vastra</h1>
    <p style="font-size:16px;margin:0 0 24px;color:#333;">Click the button below to sign in. This link expires in ${expiryMinutes} minutes.</p>
    <a href="${link}" style="${btnStyle}">Sign in to Vastra →</a>
    <hr style="${dividerStyle}">
    <p style="font-size:13px;color:#555;">Didn't request this? You can safely ignore this email.</p>
  `)
}
