# Enrich Layer v3 MCP server

An [MCP](https://modelcontextprotocol.io) server for the Enrich Layer v3 API on `api.enrichlayer.com`. It gives an AI agent six tools: person and company profiles, company search, company logos, work email search and email validation.

This is a separate server from the v2 one ([`@enrichlayer/mcp-server`](https://www.npmjs.com/package/@enrichlayer/mcp-server)), which keeps working as before.

## Requirements

- Node.js 20.3 or later.
- An Enrich Layer API key.

## API key, account and credits

- **Get a key:** log in at [enrichlayer.com/dashboard](https://enrichlayer.com/dashboard), open the API Key tab and copy the key.
- **Whose credits:** the server works under the account whose key is set in `ENRICHLAYER_API_KEY`. Every successful call is charged to that account; the result shows the credits charged in `creditCost`. Calls that end in an error are not charged.
- **A separate account for an agent:** a person creates an Enrich Layer account on the website, tops it up, copies its API key and puts the key into the agent's MCP config. The person owns the account and its credits.
- **Rate limit:** the limit is counted per account. New accounts have a very small limit until their first payment.

## Install

Most clients keep the key in their config file, so keep that file private. VS Code asks for the key instead and stores it for you.

### Cursor

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

### VS Code

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

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add the same `mcpServers` block as for Cursor. Quit and reopen Claude Desktop. Server logs are in `~/Library/Logs/Claude/mcp-server-enrichlayer-v3.log` on macOS.

### Claude Code

```bash
claude mcp add --env ENRICHLAYER_API_KEY=<your API key> --transport stdio enrichlayer-v3 -- npx -y @enrichlayer/mcp-server-v3
```

### Codex

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

### Windsurf

Add the same `mcpServers` block as for Cursor to the MCP config file named in the [Windsurf MCP docs](https://docs.devin.ai/windsurf/plugins/cascade/mcp): `~/.config/devin/mcp_config.json` on macOS and Linux, `%AppData%/devin/mcp_config.json` on Windows. Cascade opens this file with its "Open MCP config file" action. Instead of the key itself you can write `${env:ENRICHLAYER_API_KEY}` there and keep the key in your environment.

### Antigravity

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

`get_person_profile` and `get_company_profile` take `maxAgeSeconds`: the oldest cached copy you accept. By default it is 30 days, and the answer usually comes in seconds. A small value starts a live lookup, which is slower and costs more: it can take up to 5 minutes, and the server waits up to 305 seconds.

MCP clients limit how long a tool call may run. Set the limit to at least 310 seconds where the client allows it:

- **Claude Code:** `MCP_TOOL_TIMEOUT` for all servers, or a `timeout` in milliseconds for one server in `.mcp.json`.
- **Codex:** `tool_timeout_sec`, 60 seconds by default.
- **Antigravity:** `timeoutSeconds`, 180 seconds by default.
- **Claude Desktop, Cursor, VS Code and Windsurf** do not document a setting for this, and a long call can be cut off by the client.

A call cut off before the answer arrives may still be charged. To get the copy that was saved in the meantime, call again without `maxAgeSeconds`; do not repeat a live lookup right away.

## Environment variables

| Variable | Required | Default |
| -- | -- | -- |
| `ENRICHLAYER_API_KEY` | yes | — |
| `ENRICHLAYER_API_BASE_URL` | no | `https://api.enrichlayer.com` |

## Hosted connector

The same tools are served over HTTP at `https://mcp.enrichlayer.com/v3/mcp`. Add that address as a remote MCP server in your client; the client opens the Enrich Layer sign-in page, where you paste your API key. Calls then spend that account's credits, as with the local server.

The server behind that address is the `enrichlayer-mcp-v3-http` command of this package. It serves Streamable HTTP without sessions, so any instance can answer any request:

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
