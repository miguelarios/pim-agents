# Running in Docker

Each server has its own image on the GitHub Container Registry:

| Server | Image |
|--------|-------|
| Email | `ghcr.io/miguelarios/email-mcp` |
| Calendar | `ghcr.io/miguelarios/cal-mcp` |
| Contacts | `ghcr.io/miguelarios/card-mcp` |

An image's tag is its server's npm version (`ghcr.io/miguelarios/cal-mcp:4.0.0`), and it is
built by installing that published package, as `npx @miguelarios/cal-mcp@4.0.0` would. Images
are built for `linux/amd64` and `linux/arm64`.

Two ways to run a server, picked by `PIM_MCP_TRANSPORT`:

| Transport | Who starts the container | Use it for |
|-----------|--------------------------|------------|
| **Streamable HTTP** (the image's default) | You, as a long-running service | Several clients sharing one server, a server on another machine, a homelab |
| **stdio** | Your MCP client, once per session, with `docker run -i` | A desktop client (Claude Desktop, Claude Code, Cursor) on the same machine |

- [What the image sets up](#what-the-image-sets-up)
- [Email](#email) · [Calendar](#calendar) · [Contacts](#contacts)
- [All three with Docker Compose](#all-three-with-docker-compose)
- [Connecting a client over HTTP](#connecting-a-client-over-http)
- [Exposing a server beyond your machine](#exposing-a-server-beyond-your-machine)
- [Upgrading](#upgrading) · [Without the image](#without-the-image) · [Troubleshooting](#troubleshooting)

## What the image sets up

- **Runs as the unprivileged `node` user**, from `node:22-alpine`.
- **Streamable HTTP on port 3000**, listening on all interfaces inside the container
  (`PIM_MCP_TRANSPORT=http`, `PIM_MCP_HTTP_HOST=0.0.0.0`, `PIM_MCP_HTTP_PORT=3000`). Set
  `PIM_MCP_TRANSPORT=stdio` for a desktop client.
- **A built-in health check** against `GET /healthz`, which answers `ok` without contacting
  your mail or DAV server.

The examples below follow these conventions:

- **Credentials live in an env file** (`email.env`, `cal.env`, `card.env`) passed with
  `--env-file` / `env_file:`, never on the command line, where they would land in your shell
  history and `docker inspect`. Keep these files out of version control.
- **Ports are published on `127.0.0.1` only**, as 3001 (email), 3002 (calendar) and 3003
  (contacts), so they are reachable from this machine alone. **The servers do no
  authentication** — see [Exposing a server beyond your machine](#exposing-a-server-beyond-your-machine).
- **Pin an exact version tag.** `latest`, `1` and `1.1` also exist and follow the newest
  release, but a pinned tag is what keeps a restart from changing the server under you. A
  version tag is normally built once; if it is ever rebuilt, its dependencies and Node base
  are resolved afresh. To pin those too, pin the digest
  (`ghcr.io/miguelarios/cal-mcp:4.0.0@sha256:…`, shown in `docker images --digests`).

## Email

`email.env`:

```bash
IMAP_HOST=imap.example.com
IMAP_USER=user@example.com
IMAP_PASS=your-app-password
SMTP_HOST=smtp.example.com
SMTP_USER=user@example.com
SMTP_PASS=your-app-password

# Optional — see the README's Email section for every setting
# IMAP_PORT=993
# SMTP_PORT=465
# SMTP_FROM_NAME=Your Name
# TZ=America/Chicago
```

### Streamable HTTP

```bash
docker run -d --name email-mcp --restart unless-stopped \
  --env-file email.env \
  -p 127.0.0.1:3001:3000 \
  ghcr.io/miguelarios/email-mcp:2.0.0
```

Or in Compose:

```yaml
services:
  email-mcp:
    image: ghcr.io/miguelarios/email-mcp:2.0.0
    restart: unless-stopped
    env_file: email.env
    ports:
      - "127.0.0.1:3001:3000"
```

The endpoint is `http://127.0.0.1:3001/mcp`.

### stdio

The client starts the container itself. Note `-i` (stdio needs an open stdin) and `--rm`
(each session gets a fresh container):

```json
{
  "mcpServers": {
    "email": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/absolute/path/to/email.env",
        "-e", "PIM_MCP_TRANSPORT=stdio",
        "ghcr.io/miguelarios/email-mcp:2.0.0"
      ]
    }
  }
}
```

The env file path must be absolute: the client does not start Docker from the directory the
file is in.

### Sending files from disk

`send_email` only attaches files by path from inside `EMAIL_ATTACHMENT_DIR`, and inside a
container that is a container path. Mount the host directory read-only and point the variable
at the mount:

```yaml
    environment:
      EMAIL_ATTACHMENT_DIR: /attachments
    volumes:
      - ./outbox:/attachments:ro
```

Add `-v "$PWD/outbox:/attachments:ro" -e EMAIL_ATTACHMENT_DIR=/attachments` to the
`docker run` forms. Paths the client passes must then start with `/attachments/`. Without the
mount, attach inline content with `attachments[].content` instead.

## Calendar

`cal.env` — one block of three variables per CalDAV account. The part between `CALDAV_` and
`_URL` becomes the account's id and prefixes its calendar ids (`mailbox/Work`):

```bash
CALDAV_MAILBOX_URL=https://dav.mailbox.org/caldav/
CALDAV_MAILBOX_USER=user@mailbox.org
CALDAV_MAILBOX_PASS=app-password

# A second account
# CALDAV_NEXTCLOUD_URL=https://cloud.example.com/remote.php/dav/
# CALDAV_NEXTCLOUD_USER=user
# CALDAV_NEXTCLOUD_PASS=app-password

# The container's clock is UTC; set your zone so "today" and local times are yours
TZ=America/Chicago
```

**Set `TZ`.** It is the same variable every other container takes, LinuxServer images
included. Outside Docker the server defaults to the host's zone; inside a container that is
UTC, so `get_today_events` and `find_free_slots` would work in the wrong day. The image needs
no `tzdata`: Node carries its own zone database.

cal-mcp caches calendar URLs under `/home/node/.cache/cal-mcp`. Mount a named volume at
`/home/node` to keep that cache across restarts; it is optional.

### Streamable HTTP

```bash
docker run -d --name cal-mcp --restart unless-stopped \
  --env-file cal.env \
  -p 127.0.0.1:3002:3000 \
  -v cal-mcp-home:/home/node \
  ghcr.io/miguelarios/cal-mcp:4.0.0
```

Or in Compose:

```yaml
services:
  cal-mcp:
    image: ghcr.io/miguelarios/cal-mcp:4.0.0
    restart: unless-stopped
    env_file: cal.env
    ports:
      - "127.0.0.1:3002:3000"
    volumes:
      - cal-mcp-home:/home/node

volumes:
  cal-mcp-home:
```

The endpoint is `http://127.0.0.1:3002/mcp`.

### stdio

```json
{
  "mcpServers": {
    "calendar": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/absolute/path/to/cal.env",
        "-e", "PIM_MCP_TRANSPORT=stdio",
        "-v", "cal-mcp-home:/home/node",
        "ghcr.io/miguelarios/cal-mcp:4.0.0"
      ]
    }
  }
}
```

## Contacts

`card.env`:

```bash
CARDDAV_URL=https://dav.example.com/carddav/
CARDDAV_USER=user@example.com
CARDDAV_PASS=your-app-password

# Optional: always fetch whole address books instead of server-side search
# CARDDAV_SERVER_SEARCH=off
```

### Streamable HTTP

```bash
docker run -d --name card-mcp --restart unless-stopped \
  --env-file card.env \
  -p 127.0.0.1:3003:3000 \
  ghcr.io/miguelarios/card-mcp:1.1.1
```

Or in Compose:

```yaml
services:
  card-mcp:
    image: ghcr.io/miguelarios/card-mcp:1.1.1
    restart: unless-stopped
    env_file: card.env
    ports:
      - "127.0.0.1:3003:3000"
```

The endpoint is `http://127.0.0.1:3003/mcp`.

### stdio

```json
{
  "mcpServers": {
    "contacts": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/absolute/path/to/card.env",
        "-e", "PIM_MCP_TRANSPORT=stdio",
        "ghcr.io/miguelarios/card-mcp:1.1.1"
      ]
    }
  }
}
```

## All three with Docker Compose

One `compose.yaml` next to `email.env`, `cal.env` and `card.env`. Each server stays its own
container, so one can be upgraded, restarted or crash without touching the others:

```yaml
x-mcp: &mcp
  restart: unless-stopped

services:
  email-mcp:
    <<: *mcp
    image: ghcr.io/miguelarios/email-mcp:2.0.0
    env_file: email.env
    environment:
      EMAIL_ATTACHMENT_DIR: /attachments
    ports: ["127.0.0.1:3001:3000"]
    volumes: ["./outbox:/attachments:ro"]

  cal-mcp:
    <<: *mcp
    image: ghcr.io/miguelarios/cal-mcp:4.0.0
    env_file: cal.env
    environment:
      TZ: America/Chicago
    ports: ["127.0.0.1:3002:3000"]
    volumes: [cal-mcp-home:/home/node]

  card-mcp:
    <<: *mcp
    image: ghcr.io/miguelarios/card-mcp:1.1.1
    env_file: card.env
    ports: ["127.0.0.1:3003:3000"]

volumes:
  cal-mcp-home:
```

```bash
docker compose up -d
docker compose ps        # all three should reach (healthy) within a minute
docker compose logs -f   # each logs "Server started on http://0.0.0.0:3000/mcp"
```

## Connecting a client over HTTP

Point the client at the `/mcp` endpoint.

Claude Code:

```bash
claude mcp add --transport http email    http://127.0.0.1:3001/mcp
claude mcp add --transport http calendar http://127.0.0.1:3002/mcp
claude mcp add --transport http contacts http://127.0.0.1:3003/mcp
```

A client configured by JSON takes the URL in place of a command. The exact key varies by
client — commonly `"type": "http"` with `"url"`:

```json
{
  "mcpServers": {
    "email": { "type": "http", "url": "http://127.0.0.1:3001/mcp" }
  }
}
```

To check a server by hand:

```bash
curl -s http://127.0.0.1:3001/healthz    # ok
```

## Exposing a server beyond your machine

**These servers do no authentication.** Anyone who can reach the port can read and send your
mail and change your calendars and contacts. Publishing on `127.0.0.1` is what keeps the
examples above safe.

- **Another machine on your network** — publish on a private interface address instead of
  `127.0.0.1`, and only on a network you trust.
- **A cloud client** such as a claude.ai custom connector — it connects from the internet, so
  the server needs a public HTTPS address **and** an OAuth proxy in front, for example
  [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy) behind your reverse proxy. Do not
  publish the server's port at all in that setup; let the proxy reach it over a Docker network.
- **Browser-based clients** send an `Origin` header, which is refused with `403` unless listed
  in `PIM_MCP_HTTP_ALLOWED_ORIGINS` (comma-separated). Non-browser clients send none and are
  unaffected.

Irreversible operations ask the user to confirm through the client. A client that cannot
show that prompt gets a `CONFIRMATION_UNSUPPORTED` error; `PIM_MCP_CONFIRM=off` disables
confirmation, which on a network-reachable server deserves particular care.

## Upgrading

Change the image tag and recreate:

```bash
docker compose pull
docker compose up -d     # recreates the services whose image changed
```

Check each package's `CHANGELOG.md` before a major-version bump: a major version changes
behaviour a client may depend on (cal-mcp 3.0.0 changed how time arguments are read, for
example).

## Without the image

Any version can also run straight from npm on the stock `node` image, which is how the servers
were run before they had images and still works for any version, including ones older than
the first image:

```bash
docker run -d --name email-mcp --restart unless-stopped \
  --user node \
  --env-file email.env \
  -e PIM_MCP_TRANSPORT=http -e PIM_MCP_HTTP_HOST=0.0.0.0 -e PIM_MCP_HTTP_PORT=3000 \
  -p 127.0.0.1:3001:3000 \
  -v email-mcp-home:/home/node \
  node:22-alpine \
  npx -y @miguelarios/email-mcp@2.0.0
```

The named volume at `/home/node` caches the downloaded package so only the first start
fetches it. Mount it at the home directory, not at `/home/node/.npm`: Docker creates a volume
on a path that does not exist in the image as root-owned, and the `node` user then cannot
write its npm cache. Streamable HTTP needs **email-mcp 0.17.0, cal-mcp 0.20.0, card-mcp
0.12.0** or later.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `Fatal error: Config validation failed` and the container restarts | A required variable is missing from the env file. The message names it. |
| `PIM_MCP_TRANSPORT must be "stdio" or "http"` | Typo in the transport value. |
| `denied` or `unauthorized` pulling from ghcr.io | The image tag does not exist (check the version), or the package is private and this machine has not run `docker login ghcr.io`. |
| The client gets `404 Session not found` | The server restarted, or the session sat idle over 30 minutes. Clients re-initialize on their own; a hand-written client must too. |
| `403 Forbidden: origin not allowed` | A browser-based client. Add its origin to `PIM_MCP_HTTP_ALLOWED_ORIGINS`. |
| Calendar "today" is off by hours | `TZ` is unset, so the container's UTC is used. |
| `PIM_TIMEZONE is no longer read; set TZ=… instead` | An env file from before cal-mcp 4.0.0 / email-mcp 2.0.0. Rename the variable to `TZ`. |
| stdio client shows no tools, container exits at once | `-i` is missing from the `docker run` arguments, or `PIM_MCP_TRANSPORT=stdio` is. |
| `(unhealthy)` with `PIM_MCP_HTTP_HOST` set to one address | The health check probes `127.0.0.1`. Leave the host at `0.0.0.0` inside the container and restrict access where the port is published. |
| stdio container shows `(unhealthy)` | Expected: the health check probes the HTTP port, which stdio does not open. It has no effect on a `--rm` container. |
| `npm error EACCES` with the `npx` form | The volume is mounted at `/home/node/.npm`, so it was created root-owned. Mount it at `/home/node` instead, and remove the old volume (`docker volume rm <name>`). |
