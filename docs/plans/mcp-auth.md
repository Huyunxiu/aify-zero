# MCP Authorization Plan

This plan adds OAuth authorization to a remote MCP server (`http` / `sse`). The user clicks **Authorize**
once on the settings page and agrees in the browser; the token lands in a local table, and each turn
then assembles the tools as usual. The scope stops at authorization: no resources, prompts, or sampling.

## Decisions

| Decision            | Outcome                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mechanism           | The `auth` field has three states: `none` / `headers` / `oauth`                                                                                                           |
| Protocol            | Reuse `auth()` and `OAuthClientProvider` from `@ai-sdk/mcp`. The plan implements the provider and the persistence only                                                    |
| Transport           | `http` / `sse` only. `stdio` still uses `env`                                                                                                                             |
| Starter             | The browser opens only after the user clicks **Authorize** on the settings page. A background 401 marks the server `needs-auth`. A 401 in a session returns an error text |
| Callback            | `http://127.0.0.1:<port>/api/mcp/oauth/callback`. It mounts before `bearerAuth`; see ADR-0003                                                                             |
| Credential          | The `mcp_credential` table. It stores one row per `(server_id, kind)`, and the `generation` column makes a conditional delete                                             |
| Binding             | One credential belongs to one server id. A change of the URL or the issuer, a delete of the server, or a return to static headers discards it                             |
| Refresh             | Only a 401 starts a refresh. The code never refreshes in advance                                                                                                          |
| Test connection     | **Test connection** sends a stored token only. It does not start authorization, register a client, or overwrite the verifier                                              |
| Cleanup on failure  | Follow the scope that the SDK gives. `invalid_client` on a dynamic registration deletes every row; `invalid_grant` deletes the token only                                 |
| After authorization | The manager connects once immediately and refreshes the status                                                                                                            |
| Revoke              | A row that holds an authorization offers **Remove authorization**. It clears the token and the registration                                                               |
| Compatibility       | Dynamic registration only. The plan does not permit a typed `client_id`, `secret`, or scope                                                                               |
| Trust               | `validateAuthorizationServerURL` permits https and the loopback only                                                                                                      |

## Data Structures

```ts
// New in the config. When it is absent, the code infers it from whether headers is empty, so stored settings need no migration
type McpAuth = { type: "none" } | { type: "headers" } | { type: "oauth" };
```

```sql
-- mcp_credential: one row per write; generation adds one on every write
create table mcp_credential (
  server_id text not null,
  kind      text not null,      -- tokens | client | verifier
  generation integer not null default 0,
  content   text not null,      -- JSON
  created_at integer not null,
  updated_at integer not null,
  primary key (server_id, kind)
);
```

The `tokens` row stores `OAuthTokens` exactly as the SDK returns it. That value already carries the
pin of the authorization server (`issuer` / `authorization_server` / `token_endpoint`), and a refresh
reads the pin to decide if this token came from the same authorization server. The `client` row
stores `OAuthClientInformation`. The `verifier` row stores `{ codeVerifier, state }`.

## Modules

| Path                                               | Responsibility                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/src/mcp/oauth/store.ts`            | The `McpCredentialStore` interface and the generation type                                                           |
| `packages/agent/src/mcp/oauth/provider.ts`         | The `OAuthClientProvider` implementation. It captures the authorization address and does not open the browser itself |
| `packages/agent/src/mcp/oauth/flows.ts`            | The in-process pending-authorization table: `state` to a configuration snapshot, with a ten-minute expiry            |
| `packages/agent/src/mcp/oauth/authorize.ts`        | `completeMcpAuthorization()`: it exchanges the authorization code for a token                                        |
| `packages/server/src/mcp/credentials.ts`           | The table read and write, and the cleanup per server                                                                 |
| `packages/server/src/mcp/credentials-cleanup.ts`   | Discards a credential that no longer matches, after a configuration change                                           |
| `packages/server/src/mcp/oauth.ts`                 | Assembles the configuration, the store, the pending table, and the loopback address into one provider                |
| `packages/server/src/mcp/oauth-callback.ts`        | The handler of the callback route and its page                                                                       |
| `packages/server/src/routers/mcp/mcp.router.ts`    | The `authorize` / `revoke` routes                                                                                    |
| `packages/ui/src/blocks/settings/mcp-settings.tsx` | The choice of authorization, the clickable `needs-auth`, and revoke                                                  |

## Request Flow

**The user clicks Authorize**: the interface calls `mcp.authorize({ id })`. The manager starts a new
generation and opens a connection. The server returns 401. The transport layer calls `auth()`. That
call discovers the metadata, registers a client, and makes the PKCE pair. `redirectToAuthorization(url)`
keeps the address on the provider, and the transport raises `UnauthorizedError`. The manager takes the
address and sets the status to `needs-auth`. The route hands `{ url }` to the interface, and the
interface calls `window.open(url)`. On the desktop, the main process passes the URL to the system browser.

**Callback**: the browser sends `code` and `state` to the loopback route. The route takes the
configuration snapshot from the pending-authorization table, and it assembles the provider again with
the same loopback address. It calls `auth({ authorizationCode, callbackState, callbackIssuer })`,
exchanges the code for a token, and writes the table. The manager starts a new generation and
reconnects. The page shows "Authorization complete. You can close this tab."

**A 401 at run time**: the transport layer first exchanges the refresh token once. If that fails,
`auth()` needs a new authorization and raises `UnauthorizedError`. The tool returns "Authorization has
expired. Authorize again on the settings page." The status of that server becomes `needs-auth`.

**Revoke**: the code deletes the `tokens`, `client`, and `verifier` rows. The manager starts a new
generation. The status returns to `idle`.

## Status

`McpServerStatus` goes from four values to five, with the new `needs-auth`. It is separate from
`failed`: one waits for the user, and the other waits for the next retry. `needs-auth` is a terminal
state, and time does not start a retry. A retry would discover the metadata again and register another
client, and the user did not authorize. Only **Authorize**, **Remove authorization**, or a configuration
change starts a new generation.

## Security

- The callback route does not read the settings, does not return error details, and does not write the authorization code to the log. A `state` value works once and expires after ten minutes.
- `validateAuthorizationServerURL` rejects an authorization server that is not https and not the loopback.
- The callback page returns one static text only. It renders no content that comes from the request.

## Step-by-Step Implementation

1. Documents and schema: the `auth` field, the cross-field check (`oauth` applies to a remote server only), and `mcpAuthType()`.
2. Migration: the `mcp_credential` table and its repository.
3. Provider and store interface: read and write for the token, the registration, and the verifier; the conditional delete on the generation.
4. Connection and manager: pass the provider, catch `UnauthorizedError`, and add `needs-auth`, `authorize()`, and `revoke()`.
5. Loopback callback: the route, the pending-authorization table, and `completeAuthorization()`.
6. Settings page: the choice of authorization, the clickable status, revoke, and i18n.
7. Tests: a fake authorization server runs the full flow, with the generation delete and the configuration check.

## Risks

- **The callback is unreachable**: when the code attaches a remote server, the loopback address is not the machine of the user. The interface tells the user to authorize on the host machine.
- **Concurrent refresh**: two turns that meet a 401 at the same time refresh once each. The conditional delete on the generation never removes a new token that another turn just stored, but the code can exchange the token one extra time. The plan accepts this.
- **Plain-text storage**: the token goes to the database in plain text, as `apiKey` does. The repository has no keychain, and a second mechanism would only give a secret two ways to edit it.
- **A third-party server that does not comply**: the plan adds no back door for a typed client. If that case occurs, the user goes back to the `headers` state.
