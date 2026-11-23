# Enrich Layer v3 MCP server

An [MCP](https://modelcontextprotocol.io) server for the Enrich Layer v3 API on `api.enrichlayer.com`. It gives an AI agent six tools: person and company profiles, company search, company logos, work email search and email validation.

The hosted server at `https://mcp.enrichlayer.com/v3/mcp` needs nothing installed: add the address to your client and sign in with your Enrich Layer account. You can also run the server on your own machine with an API key.

This is a separate server from the v2 one ([`@enrichlayer/mcp-server`](https://www.npmjs.com/package/@enrichlayer/mcp-server)), which keeps working as before.

## Requirements

- An Enrich Layer account.
- For the local server: Node.js 20.3 or later and an Enrich Layer API key.

## Account and credits

- **Whose credits:** the server works under the Enrich Layer account you sign in with or, for the local server, the account whose key is set in `ENRICHLAYER_API_KEY`. Every successful call is charged to that account; the result shows the credits charged in `creditCost`. Calls that end in an error are not charged.
- **Get a key (local server only):** log in at [enrichlayer.com/dashboard](https://enrichlayer.com/dashboard), open the API Key tab and copy the key.
- **A separate account for an agent:** a person creates an Enrich Layer account on the website and tops it up, then signs in with it in the agent's client or, for the local server, puts its API key into the agent's MCP config. The person owns the account and its credits.
- **Rate limit:** the limit is counted per account. New accounts have a very small limit until their first payment.

## Install

### Hosted server

Add `https://mcp.enrichlayer.com/v3/mcp` to your client as a remote MCP server named `enrichlayer-v3`. Your client sends you to the Enrich Layer sign-in page at `auth.enrichlayer.com`: sign in, choose the account to use and confirm the access. No API key is needed, and calls spend the chosen account's credits.

- **Claude Code:** `claude mcp add --scope user --transport http enrichlayer-v3 https://mcp.enrichlayer.com/v3/mcp`, then sign in with `/mcp` in Claude Code or `claude mcp login enrichlayer-v3` in your shell.
- **Codex:** `codex mcp add enrichlayer-v3 --url https://mcp.enrichlayer.com/v3/mcp`, then sign in with `codex mcp login enrichlayer-v3`. Codex stops a tool call after 60 seconds by default: add `tool_timeout_sec = 310` under `[mcp_servers.enrichlayer-v3]` in `~/.codex/config.toml`.
- **Cursor:** add `"enrichlayer-v3": { "url": "https://mcp.enrichlayer.com/v3/mcp" }` to `mcpServers` in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).
- **Claude Desktop:** **Customize** → **Connectors** → **+ Add** → **Add custom connector**, then enter `enrichlayer-v3` as the name and the address above. On Team and Enterprise plans an owner adds the connector for the organization.
- **VS Code:** `code --add-mcp '{"name":"enrichlayer-v3","type":"http","url":"https://mcp.enrichlayer.com/v3/mcp"}'`.
- **Antigravity:** add `"enrichlayer-v3": { "serverUrl": "https://mcp.enrichlayer.com/v3/mcp", "timeoutSeconds": 310 }` to `mcpServers` in `~/.gemini/config/mcp_config.json` (`.agents/mcp_config.json` for one workspace). In the Antigravity app, sign in with **Authenticate** next to the server under **Customizations** → **Installed**.
- **Windsurf:** add `"enrichlayer-v3": { "serverUrl": "https://mcp.enrichlayer.com/v3/mcp" }` to `mcpServers` in `~/.config/devin/mcp_config.json` on macOS and Linux, `%AppData%/devin/mcp_config.json` on Windows.

### Local server with an API key

Both servers are named `enrichlayer-v3`, so a client keeps one of them under that name: to move from the local server to the hosted one, remove the local entry first.

Most clients keep the key in their config file, so keep that file private. VS Code asks for the key instead and stores it for you.

#### Claude Code

```bash
claude mcp add --env ENRICHLAYER_API_KEY=<your API key> --transport stdio enrichlayer-v3 -- npx -y @enrichlayer/mcp-server-v3
```

#### Codex

```bash
codex mcp add enrichlayer-v3 --env ENRICHLAYER_API_KEY=<your API key> -- npx -y @enrichlayer/mcp-server-v3
```

Codex stops a tool call after 60 seconds by default. Raise the limit in `~/.codex/config.toml`:

```toml
[mcp_servers.enrichlayer-v3]
command = "npx"
args = ["-y", "@enrichlayer/mcp-server-v3"]
env = { ENRICHLAYER_API_KEY = "<your API key>" }
tool_timeout_sec = 310
```

#### Cursor

[![Add Enrich Layer v3 to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=enrichlayer-v3&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBlbnJpY2hsYXllci9tY3Atc2VydmVyLXYzIl0sImVudiI6eyJFTlJJQ0hMQVlFUl9BUElfS0VZIjoiPHlvdXIgQVBJIGtleT4ifX0%3D)

The button opens Cursor's install link (`cursor://anysphere.cursor-deeplink/mcp/install?...`). The link carries no key: after the server is added, replace `<your API key>` with your key in Cursor's MCP settings.

To add it by hand, put this block into `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "enrichlayer-v3": {
      "command": "npx",
      "args": ["-y", "@enrichlayer/mcp-server-v3"],
      "env": { "ENRICHLAYER_API_KEY": "<your API key>" }
    }
  }
}
```

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add the same `mcpServers` block as for Cursor. Quit and reopen Claude Desktop. Server logs are in `~/Library/Logs/Claude/mcp-server-enrichlayer-v3.log` on macOS.

#### VS Code

[Install Enrich Layer v3 in VS Code](https://vscode.dev/redirect/mcp/install?name=enrichlayer-v3&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22enrichlayer-api-key%22%2C%22description%22%3A%22Enrich%20Layer%20API%20key%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40enrichlayer%2Fmcp-server-v3%22%5D%2C%22env%22%3A%7B%22ENRICHLAYER_API_KEY%22%3A%22%24%7Binput%3Aenrichlayer-api-key%7D%22%7D%7D)

The link opens VS Code's install link (`vscode:mcp/install?...`). VS Code asks for the API key when the server first starts.

To add it by hand, put this into `.vscode/mcp.json` in the workspace, or into the MCP configuration of your user profile:

```json
{
  "inputs": [
    { "type": "promptString", "id": "enrichlayer-api-key", "description": "Enrich Layer API key", "password": true }
  ],
  "servers": {
    "enrichlayer-v3": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@enrichlayer/mcp-server-v3"],
      "env": { "ENRICHLAYER_API_KEY": "${input:enrichlayer-api-key}" }
    }
  }
}
```

#### Antigravity

Open the `…` menu of the agent panel → **MCP Servers** → **Manage MCP Servers** → **View raw config**, or edit `~/.gemini/config/mcp_config.json` (`.agents/mcp_config.json` for one workspace). Add the same `mcpServers` block as for Cursor, with a longer tool call limit — Antigravity's default is 180 seconds:

```json
{
  "mcpServers": {
    "enrichlayer-v3": {
      "command": "npx",
      "args": ["-y", "@enrichlayer/mcp-server-v3"],
      "env": { "ENRICHLAYER_API_KEY": "<your API key>" },
      "timeoutSeconds": 310
    }
  }
}
```

#### Windsurf

Add the same `mcpServers` block as for Cursor to the MCP config file named in the [Windsurf MCP docs](https://docs.devin.ai/windsurf/plugins/cascade/mcp): `~/.config/devin/mcp_config.json` on macOS and Linux, `%AppData%/devin/mcp_config.json` on Windows. Cascade opens this file with its "Open MCP config file" action. Instead of the key itself you can write `${env:ENRICHLAYER_API_KEY}` there and keep the key in your environment.

## Tools

| Tool | v3 endpoint | What it does |
| -- | -- | -- |
| `get_person_profile` | `GET /v3/person` | One person by exactly one identifier: `profile` (LinkedIn URL or username), `email`, `twitter`, `facebook` or `github`. Optional sections: `socialLink`, `phoneNumber`, `personalEmail`, `workEmail`, `careerInsight`, `developerProfile`, `activities`. |
| `get_company_profile` | `GET /v3/company` | One company by its LinkedIn company or showcase page `url`. Optional sections: `fundingData`, `exitData`, `acquisitions`, `extra`, `activities`. |
| `search_companies` | `GET /v3/company/search` | Companies matching a name (`q`), up to 10. |
| `search_company_logos` | `GET /v3/company/logo` | Companies matching a name or domain (`q`), with logo URLs. |
| `find_work_emails` | `GET /v3/email/prospect` | Work email candidates for `full_name`, or `first_name` and/or `last_name`, at a company `domain`. |
| `validate_email` | `GET /v3/email/validate` | Whether one email address is deliverable. |

The input schemas are generated from the published v3 OpenAPI spec, so parameter names and allowed values are the ones v3 accepts.

Ask only for the sections you need. A full person profile can be long: Claude Code warns above 10,000 tokens of tool output and cuts it at 25,000 by default (raise `MAX_MCP_OUTPUT_TOKENS` if you need more).

### Email addresses

- `get_person_profile` with `personalEmail` or `workEmail` returns only addresses validated as deliverable. To find someone's work email from a profile URL, pass `profile` and `workEmail: "include"`; if `contactInformation.emails.work` is empty, `find_work_emails` with the person's name and company domain may still find candidates.
- `find_work_emails` returns candidates, each with a validation verdict in `validity`; only `valid` is confirmed deliverable.
- `validate_email` returns the verdict in `emailStatus`.

## What a call returns

- `data` — the full v3 answer, unchanged.
- `creditCost` — credits charged for the call, from the `X-EnrichLayer-Credit-Cost` header.
- `requestId` — the `X-Request-Id` of the call; quote it to support.

The result comes as MCP structured content and as the same JSON in a text block.

Errors come back as tool errors with a readable message, `creditCost`, `requestId` and the next step to take: invalid parameters (400), an invalid or missing key (401), not enough credits or no access (403), not found (404), no copy fresh enough (409, with the age of the newest cached copy), rate limit (429) and service errors (5xx). The server retries 429 and 5xx twice before it reports them.

## Freshness and long calls

`get_person_profile` and `get_company_profile` take `maxAgeSeconds`: the oldest cached copy you accept. By default it is 30 days, and the answer usually comes in seconds. A small value starts a live lookup, which is slower and costs more: it can take up to 5 minutes, and the server waits about 300 seconds for the answer.

MCP clients limit how long a tool call may run. Set the limit to at least 310 seconds where the client allows it:

- **Claude Code:** nothing to set. It cuts off a call only after 5 minutes without an answer or a progress notification (30 minutes for a server it starts itself), and this server sends a progress notification every 15 seconds while it waits.
- **Codex:** `tool_timeout_sec`, 60 seconds by default.
- **Antigravity:** `timeoutSeconds`, 180 seconds by default.
- **Cursor, Claude Desktop, VS Code and Windsurf** do not document a setting for this, and a long call can be cut off by the client.

A call cut off before the answer arrives may still be charged. To get the copy that was saved in the meantime, call again without `maxAgeSeconds`; do not repeat a live lookup right away.

## Environment variables

| Variable | Required | Default |
| -- | -- | -- |
| `ENRICHLAYER_API_KEY` | yes | — |
| `ENRICHLAYER_API_BASE_URL` | no | `https://api.enrichlayer.com` |

## Hosted connector

This section is for running the HTTP server yourself. To use the hosted server, see [Hosted server](#hosted-server).

The server behind `https://mcp.enrichlayer.com/v3/mcp` is the `enrichlayer-mcp-v3-http` command of this package. It serves Streamable HTTP without sessions, so any instance can answer any request:

| Path | What it does |
| -- | -- |
| `POST /v3/mcp` | MCP requests; needs a Bearer access token from the sign-in service |
| `GET /.well-known/oauth-protected-resource/v3/mcp` | Tells the client where to sign in |
| `GET /v3/health` | `{"status":"ok","version":"<version>"}` |

| Variable | Required | Default |
| -- | -- | -- |
| `MCP_BASE_URL` | yes | — (the public origin; access tokens must be issued by it and for it) |
| `AUTH_JWT_SECRET` | yes | — (the secret the sign-in service signs access tokens with) |
| `PORT` | no | `3000` |
| `ENRICHLAYER_API_BASE_URL` | no | `https://api.enrichlayer.com` |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT` | no | errors are not reported |
| `AUTH_ISSUER` | no | — (the sign-in service whose ES256 tokens are accepted, e.g. `https://auth.enrichlayer.com`) |
| `AUTH_MCP_AUDIENCE` | no | — (the `aud` its access tokens carry for this server) |
| `AUTH_API_AUDIENCE` | no | — (the audience requested for the token the REST API accepts) |
| `AUTH_MCP_CLIENT_ID`, `AUTH_MCP_CLIENT_SECRET` | no | — (this server's client registration, used for the token exchange) |

### ES256 access tokens

Set all five `AUTH_*` settings above, or none of them. With none, the server accepts only the HS256 tokens signed with `AUTH_JWT_SECRET`, and the resource metadata names `MCP_BASE_URL` as the authorization server. With a partial set the server refuses to start, and so it does when `AUTH_ISSUER` ends in a slash: it must equal the `iss` of the tokens exactly.

With all five, the server also accepts ES256 access tokens from `AUTH_ISSUER`, and the resource metadata names `AUTH_ISSUER` as the authorization server. HS256 tokens keep working beside them. The token header picks the check; any other algorithm, `none` included, gets `401`. An ES256 token must have `typ: at+jwt` and a `kid`, be signed by a key in `<AUTH_ISSUER>/.well-known/jwks.json`, carry `iss` = `AUTH_ISSUER` exactly, have `AUTH_MCP_AUDIENCE` in `aud`, and carry `sub`, `client_id`, `grant_id`, `scope`, `exp`, `iat` and `jti`. If the signing keys cannot be fetched, or the answer is not `200` with a key set, the answer is `500`, not `401`, so clients keep their tokens.

An ES256 token never reaches the REST API and never stands for an API key. For each call the server exchanges it at `<AUTH_ISSUER>/token` (RFC 8693 token exchange, client credentials over HTTP Basic, `audience` = `AUTH_API_AUDIENCE`, no redirects followed) and calls the API with the token it gets back. That token is reused until 30 s before it expires, separately for every incoming token and grant, and is asked for again on every retry; a token that comes without `expires_in` serves only its own call. A `401` from the API drops it, so the next call exchanges again and a revoked grant is refused at once. The wait for the exchange counts against the call's time limit and ends when the client cancels the call; the exchange itself goes on for other calls that share it. If the exchange fails, the tool call fails. Only an `invalid_grant` refusal, such as a revoked grant, tells the user to sign in again; any other refusal, an answer that cannot be read and an exchange that does not finish within the call's time limit are the server's to fix: the user is told to try again later and the error is reported. API refusals tell a signed-in user to sign in again rather than to fix an API key they do not have.

Each tool call writes one JSON line to stdout with the tool, the API status, `creditCost`, `requestId`, the time it took and the client name; keys, tokens and parameters are never logged.

A tag `v<version>` also builds the image `ghcr.io/enrichlayer/mcp:<version>`. To build and run it locally:

```bash
docker build -t enrichlayer-mcp-v3 .
docker run --rm -p 3000:3000 -e MCP_BASE_URL=http://localhost:3000 -e AUTH_JWT_SECRET=<secret> enrichlayer-mcp-v3
curl http://localhost:3000/v3/health
```

## Development

```bash
npm ci
npm test            # build, then unit and conformance tests
npm run update-spec # refresh spec/v3-openapi.json from the published spec
npm run gen:params  # regenerate src/generated/v3-params.ts from the spec copy
```

CI checks the types and runs the tests on Node 20, 22 and 24, and fails when the published v3 spec differs from `spec/v3-openapi.json`.

`server.json` describes the server for the official MCP registry. Its name, version and package must match `package.json`; a test checks this.

To release, set the version in `package.json` and `server.json` and push the tag `v<version>`. The tag runs the same checks and stages the version on npm; the package owner publishes it from Staged Packages on npmjs.com. Then run the Registry workflow by hand from the Actions tab to publish `server.json` to the MCP registry. The registry takes each version only once, so running the workflow again for the same version fails.

## License

MIT
