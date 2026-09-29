# Security Policy

## Supported Versions

Only the latest version of VastraBot is supported for security updates.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability within this project, please open a public issue. Maybe try to please report it via the following method:

1.  **Email:** : Unfortunately the project isn't maintained on email, please write PR or message me on LinkedIn/Github`
2.  **Details:** Include as much information as possible, including steps to reproduce the issue.
3.  **Response:** You will receive an acknowledgment within 48 hours.

## Security Overview

VastraBot is designed to be self-hosted and prioritizes user privacy.

### Authentication & Authorization

- **Web app (the only live transport):** Email + password accounts. Sessions are stored server-side (`sessions` table) and carried by an `httpOnly closet-auth` cookie or a Bearer token. Google OAuth is also supported.
- **Admin fallback:** A single-password fallback (`WEB_AUTH_PASSWORD`) exists only when `ADMIN_BEARER_FALLBACK=true`. Leave it off unless recovering access.
- **Timing Attacks:** Comparison of authentication tokens uses `timingSafeEqual` to prevent timing-based side-channel attacks.
- **Telegram Bot:** Deprecated and disconnected. The legacy in-bot agent is hard-disabled because it predates per-user scoping and billing; do not re-enable it.

### Tenant Isolation

The deployment is multi-user, so isolation is enforced at the query layer rather than the route layer:

- Every data query requires an authenticated `userId`, validated at runtime. There are no optional-identity or "default to self" reads — those were removed because an omitted argument silently returned every user's data.
- Images live under per-user filesystem prefixes (`users/<userId>/...`) and the image route checks the authenticated user against the path prefix before serving.
- Derived data is scoped too: embedding vectors and the query-embedding cache are keyed by user, and raw query text is not persisted.
- Join tables are checked on both sides — e.g. adding an outfit to a collection requires ownership of both.

### Data Privacy

- **Local Storage:** All wardrobe data, settings, and images are stored in a SQLite database and on the filesystem (specified by `CLOSET_DATA_DIR`) on the server you control.
- **AI Processing:** Image data and text queries are sent to Google's Gemini API and optionally to OpenRouter (if configured) for processing. Users should review [Google's Generative AI Privacy Notice](https://generativelanguage.googleapis.com/privacy) and [OpenRouter's Privacy Policy](https://openrouter.ai/privacy).
- **No Third-Party Tracking:** This application does not include any third-party analytics or tracking scripts.

### Best Practices for Deployment

- **Environment Variables:** Never commit your `.env` file. A `.env.example` is provided as a template.
- **HTTPS:** Always run the web dashboard over HTTPS. If using a tunnel (like Cloudflare or ngrok), ensure you use the provided HTTPS URL.
- **Updates:** Keep your Node.js environment and dependencies updated to the latest stable versions.
