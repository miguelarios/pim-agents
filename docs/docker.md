# Running in Docker

There is no dedicated image: each server runs from the official `node` image with `npx`,
pinned to an exact package version. That keeps the version you run explicit and lets you
upgrade by changing one tag.

Two ways to run a server, picked by `PIM_MCP_TRANSPORT`:

| Transport | Who starts the container | Use it for |
|-----------|--------------------------|------------|
| **stdio** (default) | Your MCP client, once per session, with `docker run -i` | A desktop client (Claude Desktop, Claude Code, Cursor) on the same machine |
| **Streamable HTTP** | You, as a long-running service | Several clients sharing one server, a server on another machine, a homelab |

Streamable HTTP needs **email-mcp 0.17.0, cal-mcp 0.20.0, card-mcp 0.12.0** or later.

- [Conventions used below](#conventions-used-below)
- [Email](#email) · [Calendar](#calendar) · [Contacts](#contacts)
- [All three with Docker Compose](#all-three-with-docker-compose)
- [Connecting a client over HTTP](#connecting-a-client-over-http)
- [Exposing a server beyond your machine](#exposing-a-server-beyond-your-machine)
- [Upgrading](#upgrading) · [Troubleshooting](#troubleshooting)

## Conventions used below

- **Credentials live in an env file** (`email.env`, `cal.env`, `card.env`) passed with
  `--env-file` / `env_file:`, never on the command line, where they would land in your shell
  history and `docker inspect`. Keep these files out of version control.
- **`--user node`** runs the server as the image's unprivileged user rather than root.
- **A named volume at `/home/node`** caches the downloaded package, so only the first start
  fetches it from npm, and holds cal-mcp's URL cache (`~/.cache/cal-mcp`). Mount it at the home
  directory, not at `/home/node/.npm`: Docker creates a volume on a path that does not exist in
  the image as root-owned, and the `node` user then cannot write its npm cache. `/home/node`
  exists in the image, owned by `node`, and a new volume inherits that.
- **HTTP servers listen on port 3000 inside their container** (`PIM_MCP_HTTP_HOST=0.0.0.0` so
  the port can be published) and are published on `127.0.0.1` only, as 3001 (email), 3002
  (calendar) and 3003 (contacts). Publishing on `127.0.0.1` keeps them reachable from this
  machine alone. **The servers do no authentication** — see
  [Exposing a server beyond your machine](#exposing-a-server-beyond-your-machine).
- **`GET /healthz`** answers `ok` without contacting your mail or DAV server, so it is safe to
  poll. The `node:alpine` image ships `wget` for the health check.

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
# PIM_TIMEZONE=America/Chicago
```

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
        "--user", "node",
        "--env-file", "/absolute/path/to/email.env",
        "-v", "email-mcp-home:/home/node",
        "node:22-alpine",
        "npx", "-y", "@miguelarios/email-mcp@0.17.0"
      ]
    }
  }
}
```

The env file path must be absolute: the client does not start Docker from the directory the
file is in.

### Streamable HTTP with `docker run`

```bash
docker run -d --name email-mcp --restart unless-stopped \
  --user node \
  --env-file email.env \
  -e PIM_MCP_TRANSPORT=http \
  -e PIM_MCP_HTTP_HOST=0.0.0.0 \
  -e PIM_MCP_HTTP_PORT=3000 \
  -p 127.0.0.1:3001:3000 \
  -v email-mcp-home:/home/node \
  --health-cmd "wget -qO- http://127.0.0.1:3000/healthz" \
  --health-interval 30s --health-start-period 60s \
  node:22-alpine \
  npx -y @miguelarios/email-mcp@0.17.0
```

The endpoint is `http://127.0.0.1:3001/mcp`.

### Streamable HTTP with Docker Compose

```yaml
services:
  email-mcp:
    image: node:22-alpine
    command: ["npx", "-y", "@miguelarios/email-mcp@0.17.0"]
    user: node
    restart: unless-stopped
    env_file: email.env
    environment:
      PIM_MCP_TRANSPORT: http
      PIM_MCP_HTTP_HOST: 0.0.0.0
      PIM_MCP_HTTP_PORT: "3000"
    ports:
      - "127.0.0.1:3001:3000"
    volumes:
      - email-mcp-home:/home/node
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]
      interval: 30s
      timeout: 5s
      start_period: 60s

volumes:
  email-mcp-home:
```

### Sending files from disk

`send_email` only attaches files by path from inside `EMAIL_ATTACHMENT_DIR`, and inside a
container that is a container path. Mount the host directory read-only and point the variable
at the mount:

```yaml
    environment:
      EMAIL_ATTACHMENT_DIR: /attachments
    volumes:
      - email-mcp-home:/home/node
      - ./outbox:/attachments:ro
```

Add `-v "$PWD/outbox:/attachments:ro" -e EMAIL_ATTACHMENT_DIR=/attachments` to the
`docker run` forms. Without it, attach inline content with `attachments[].content` instead.

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
PIM_TIMEZONE=America/Chicago
```

**Set `PIM_TIMEZONE`.** Outside Docker the server defaults to the host's zone; inside a
container that is UTC, so `get_today_events` and `find_free_slots` would work in the wrong day.

### stdio

```json
{
  "mcpServers": {
    "calendar": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--user", "node",
        "--env-file", "/absolute/path/to/cal.env",
        "-v", "cal-mcp-home:/home/node",
        "node:22-alpine",
        "npx", "-y", "@miguelarios/cal-mcp@0.20.0"
      ]
    }
  }
}
```

### Streamable HTTP with `docker run`

```bash
docker run -d --name cal-mcp --restart unless-stopped \
  --user node \
  --env-file cal.env \
  -e PIM_MCP_TRANSPORT=http \
  -e PIM_MCP_HTTP_HOST=0.0.0.0 \
  -e PIM_MCP_HTTP_PORT=3000 \
  -p 127.0.0.1:3002:3000 \
  -v cal-mcp-home:/home/node \
  --health-cmd "wget -qO- http://127.0.0.1:3000/healthz" \
  --health-interval 30s --health-start-period 60s \
  node:22-alpine \
  npx -y @miguelarios/cal-mcp@0.20.0
```

The endpoint is `http://127.0.0.1:3002/mcp`.

### Streamable HTTP with Docker Compose

```yaml
services:
  cal-mcp:
    image: node:22-alpine
    command: ["npx", "-y", "@miguelarios/cal-mcp@0.20.0"]
    user: node
    restart: unless-stopped
    env_file: cal.env
    environment:
      PIM_MCP_TRANSPORT: http
      PIM_MCP_HTTP_HOST: 0.0.0.0
      PIM_MCP_HTTP_PORT: "3000"
    ports:
      - "127.0.0.1:3002:3000"
    volumes:
      - cal-mcp-home:/home/node
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]
      interval: 30s
      timeout: 5s
      start_period: 60s

volumes:
  cal-mcp-home:
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

### stdio

```json
{
  "mcpServers": {
    "contacts": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--user", "node",
        "--env-file", "/absolute/path/to/card.env",
        "-v", "card-mcp-home:/home/node",
        "node:22-alpine",
        "npx", "-y", "@miguelarios/card-mcp@0.12.0"
      ]
    }
  }
}
```

### Streamable HTTP with `docker run`

```bash
docker run -d --name card-mcp --restart unless-stopped \
  --user node \
  --env-file card.env \
  -e PIM_MCP_TRANSPORT=http \
  -e PIM_MCP_HTTP_HOST=0.0.0.0 \
  -e PIM_MCP_HTTP_PORT=3000 \
  -p 127.0.0.1:3003:3000 \
  -v card-mcp-home:/home/node \
  --health-cmd "wget -qO- http://127.0.0.1:3000/healthz" \
  --health-interval 30s --health-start-period 60s \
  node:22-alpine \
  npx -y @miguelarios/card-mcp@0.12.0
```

The endpoint is `http://127.0.0.1:3003/mcp`.

### Streamable HTTP with Docker Compose

```yaml
services:
  card-mcp:
    image: node:22-alpine
    command: ["npx", "-y", "@miguelarios/card-mcp@0.12.0"]
    user: node
    restart: unless-stopped
    env_file: card.env
    environment:
      PIM_MCP_TRANSPORT: http
      PIM_MCP_HTTP_HOST: 0.0.0.0
      PIM_MCP_HTTP_PORT: "3000"
    ports:
      - "127.0.0.1:3003:3000"
    volumes:
      - card-mcp-home:/home/node
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]
      interval: 30s
      timeout: 5s
      start_period: 60s

volumes:
  card-mcp-home:
```

## All three with Docker Compose

One `compose.yaml` next to `email.env`, `cal.env` and `card.env`. The shared settings are a
YAML anchor, so each service only states what is its own:

```yaml
x-mcp: &mcp
  image: node:22-alpine
  user: node
  restart: unless-stopped
  environment: &http
    PIM_MCP_TRANSPORT: http
    PIM_MCP_HTTP_HOST: 0.0.0.0
    PIM_MCP_HTTP_PORT: "3000"
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]
    interval: 30s
    timeout: 5s
    start_period: 60s

services:
  email-mcp:
    <<: *mcp
    command: ["npx", "-y", "@miguelarios/email-mcp@0.17.0"]
    env_file: email.env
    ports: ["127.0.0.1:3001:3000"]
    volumes: [email-mcp-home:/home/node]

  cal-mcp:
    <<: *mcp
    command: ["npx", "-y", "@miguelarios/cal-mcp@0.20.0"]
    env_file: cal.env
    environment:
      <<: *http
      PIM_TIMEZONE: America/Chicago
    ports: ["127.0.0.1:3002:3000"]
    volumes: [cal-mcp-home:/home/node]

  card-mcp:
    <<: *mcp
    command: ["npx", "-y", "@miguelarios/card-mcp@0.12.0"]
    env_file: card.env
    ports: ["127.0.0.1:3003:3000"]
    volumes: [card-mcp-home:/home/node]

volumes:
  email-mcp-home:
  cal-mcp-home:
  card-mcp-home:
```

```bash
docker compose up -d
docker compose ps        # all three should reach (healthy) within a minute
docker compose logs -f   # each logs "Server started on http://0.0.0.0:3000/mcp"
```

A service that redefines `environment:` replaces the anchor's map rather than adding to it,
which is why `cal-mcp` merges `*http` back in.

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

Change the version in the `npx` argument and restart:

```bash
docker compose up -d     # recreates the services whose command changed
```

The new version is downloaded on that start and cached in the volume. Check each package's
`CHANGELOG.md` before a minor-version bump: these are 0.x releases, where a minor version can
change behaviour.

Avoid `@latest` or an unpinned name: the server would change under you on any restart, with
no record of which version was running.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `(health: starting)` for the first minute | The first start downloads the package. Later starts read the volume's cache. |
| `npm error EACCES` or "Log files were not written" | The volume is mounted at `/home/node/.npm`, so it was created root-owned. Mount it at `/home/node` instead, and remove the old volume (`docker volume rm <name>`). |
| `Fatal error: Config validation failed` and the container restarts | A required variable is missing from the env file. The message names it. |
| `PIM_MCP_TRANSPORT must be "stdio" or "http"` | Typo in the transport value. |
| The client gets `404 Session not found` | The server restarted, or the session sat idle over 30 minutes. Clients re-initialize on their own; a hand-written client must too. |
| `403 Forbidden: origin not allowed` | A browser-based client. Add its origin to `PIM_MCP_HTTP_ALLOWED_ORIGINS`. |
| Calendar "today" is off by hours | `PIM_TIMEZONE` is unset, so the container's UTC is used. |
| stdio client shows no tools, container exits at once | `-i` is missing from the `docker run` arguments. |
