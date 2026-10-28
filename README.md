# insync-mcp

MCP server for an **InSync Healthcare (Qualifacts)** patient portal — the
behavioral-health portals at `https://<practice>intouch.insynchcs.com` (the
owner's is `pfbhintouch`). It reads appointments, medications, allergies, secure
messages, forms, surveys, documents, profile and account balance; downloads
portal files; and uploads an insurance-card image.

> This project was developed and is maintained by AI. Use at your own discretion.
> It reads personal health information, and only ever from the signed-in user's own account.

## Not read-only

This server is **not** read-only. Alongside the reads it:

- **downloads** message attachments and account documents (a download changes no
  portal state and has an inverse — not persisting — so the download tools are
  still annotated `readOnly`);
- **uploads** an insurance-card image to your own profile — a real write the
  practice sees, with no delete/undo through this server, so it is annotated
  `destructive` and **confirm-gated** (see below);
- `insync_get_message` opening an **unread** message can **mark it read**, which
  the practice can see and which has no inverse. That tool is annotated
  `destructive` and gated behind `allow_mark_read` (default false): until you
  pass it, the tool returns the list-row metadata and a note, and never fetches
  the detail.

Out of scope, and deliberately not built: composing/replying to messages,
refill requests, appointment requests, and cancellations.

## Two ways to authenticate

| Mode | When | Credentials held |
|---|---|---|
| **Bridge-less** (default) | `INSYNC_USERNAME` + `INSYNC_PASSWORD` set | your portal password, in memory for the process |
| **Browser bridge** | no credentials configured | **none** |

**Bridge-less** signs in server-side with its own cookie jar — no browser, no
extension — which is what makes hosting possible. The password login was
**live-verified on 2026-10-28** against the owner's practice: a single POST to
`Login/userLogin`, no MFA, no device challenge. A rejected sign-in is **never
retried automatically**, because the portal counts failed attempts toward an
account lockout. The cookie jar lives in memory for the life of the process;
nothing is written to disk.

**Browser bridge** relays requests through your own signed-in portal tab via the
[fetchproxy](https://github.com/chrischall/fetchproxy) bridge and the ContextMint
Bridge extension, reusing that session. It holds **no credentials at all** — its
one virtue — so prefer it unless you specifically want the hosted, bridge-less
path.

Selection is automatic: `server` when both credentials are set, otherwise
`fetchproxy`. `INSYNC_TRANSPORT=server|fetchproxy` forces one.

## The S3 credentials the login carries

The `Login/userLogin` response includes **practice-wide AWS S3 credentials**
(`S3AccessKeyID`, `S3SecretAccessKey`, `S3BucketName`, `S3RegionEndpoint`,
`S3PracticeFolderName`). This server **never uses them to talk to S3 directly** —
hitting the bucket would bypass the portal's per-patient authorization and could
reach other patients' files. They are captured onto the session only so file
tools behave correctly, and every one of those values is **scrubbed by value**
from every tool result, error and log. All file transfer goes through the
portal's own session-authorized endpoints, and a download URL is refused unless
it stays on `*.insynchcs.com`.

## Insurance-card upload is unverified on the wire

The insurance-card upload shape is **derived from the portal's own JavaScript**
and is **UNVERIFIED on a live POST**: no automated run performs a real upload,
because it mutates practice-visible state. An owner-supervised live test confirms
it later. The confirm gate, the file vetting and the re-read-after-write guidance
are all in place; only the on-the-wire success signal is pending confirmation.
See [`docs/INSYNC-API.md`](docs/INSYNC-API.md).

## Confirm gate

`insync_upload_insurance_card` is gated by `@chrischall/mcp-utils`' `confirmWrite`.
The first call reads nothing from the portal and returns a **preview + a
`confirmToken`**; only a second call carrying that token — after you approve the
preview — uploads. The exact image bytes and the shown preview are bound into the
token, so a file or argument that changed since the preview is refused as
`DRAFT_CHANGED`. `MCP_CONFIRM_MODE` / `MCP_CONFIRM_ELICITATION` tune this (see the
env table).

## Install

```jsonc
{
  "mcpServers": {
    "insync": {
      "command": "npx",
      "args": ["-y", "@chrischall/insync-mcp"],
      "env": {
        "INSYNC_PORTAL": "https://<practice>intouch.insynchcs.com",
        "INSYNC_USERNAME": "your-portal-username",
        "INSYNC_PASSWORD": "your-portal-password"
      }
    }
  }
}
```

Leave `INSYNC_USERNAME` / `INSYNC_PASSWORD` out to use the browser bridge
instead; that path needs **ContextMint Bridge**, the fetchproxy browser
extension, installed from its
[releases page](https://github.com/nullnet-app/contextmint-bridge/releases), and
your portal open and signed in. Then call `insync_healthcheck`; the first call
prints a pair code to approve once in the extension popup.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `INSYNC_PORTAL` | yes | — | Your practice portal, scheme + host only (`https://<practice>intouch.insynchcs.com`), no path. The portal is per-practice, so a wrong host reads a different practice. |
| `INSYNC_USERNAME` | bridge-less only | — | Portal username. Set with the password to sign in server-side. |
| `INSYNC_PASSWORD` | bridge-less only | — | Portal password. Never retried on rejection (lockout risk). |
| `INSYNC_TRANSPORT` | no | auto | `server` or `fetchproxy`. Default: `server` when both credentials are set, else `fetchproxy`. |
| `INSYNC_WS_PORT` | no | `37149` | fetchproxy concentrator port. The whole fleet shares it; override only when hosting. |
| `INSYNC_OUTPUT_DIR` | no | `~/Downloads`, `~/Documents` | Where downloaded files are written (a path-delimiter list; `~` expands). A per-call `dest` must resolve inside one of these. |
| `INSYNC_INLINE_DOWNLOADS` | no | `false` | `true` returns downloaded bytes inline (base64) instead of writing to disk — for a hosted runner whose disk you cannot reach. |
| `MCP_CONFIRM_MODE` | no | `ask-user` | Confirm-gate mode for the upload. `ask-user` = preview + `confirmToken` round-trip; `auto` lets a capable host confirm in one step; an unrecognised value fails closed (`refuse`). |
| `MCP_CONFIRM_ELICITATION` | no | `on` | `on` lets the host confirm the upload interactively; `off` forces the `confirmToken` round-trip. |

A `.env` is read for local development; real environment values always win. See
[`.env.example`](.env.example).

## The fpx skill

Bundled under [`skills/insync-fpx/`](skills/insync-fpx/) is a lightweight
alternative to running this server: the `insync-fpx` skill reads the same portal
from a shell through your signed-in browser tab with the
[`fpx`](https://github.com/chrischall/fetchproxy) CLI (capture the session once,
then curl the endpoints). Use it when you want portal data in a script or without
the MCP installed. The MCP is the richer surface; the skill is the quick path.

## How it works

The portal is ASP.NET MVC. A signed-out session is never a `401`: it is the login
page served `200` (`<title>Portal :: Login`), an `{"isTimeout":true}` body, or a
`302` to `/Login`. This server detects that by content and surfaces an actionable
"not signed in" error naming the live transport. Every endpoint shape — reads,
file transfer and the upload — is documented, keys only (no values, which are
PHI), in [`docs/INSYNC-API.md`](docs/INSYNC-API.md).

## License

MIT
