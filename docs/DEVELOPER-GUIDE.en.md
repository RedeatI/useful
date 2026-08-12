# Developer guide (human maintainers and publishers)

[简体中文](DEVELOPER-GUIDE.md) · English

This page is for human maintainers and self-hosted source operators. It includes interactive,
local-service, and network publish commands.

Do not feed this page to an external Agent as its build procedure. External Agents that build
third-party tools must follow only [`agent/BUILD-A-TOOL.md`](agent/BUILD-A-TOOL.md) (Chinese). Those
Agents run non-interactive `--json` commands and stop on the first non-zero exit code.

Human maintainers can use this page for:

`clone → develop → pack → create source → publish → install → update → withdraw → security advisory`

Commands are checked by `scripts/doc-smoke.mjs` and CI.

More detail:

- [Plugin SDK](PLUGIN_SDK.en.md)
- [TRP-v1](TRP-v1.md) (Chinese)
- [Owner gates](OWNER-GATES.md) (Chinese)

## 0. Quick start (Windows entry)

```powershell
git clone <repo> useful; cd useful
.\scripts\useful.ps1 doctor
.\scripts\useful.ps1 bootstrap
.\scripts\useful.ps1 verify:all
```

CLI entry: `node packages/useful-cli/bin/useful.mjs <command>` (short form below: `useful`).

Network publish, withdraw, and production operations still need separate explicit authorization.

## 1. Create a web tool → local preview → validate manifest

```powershell
useful dev  examples/hello-web-tool
useful validate  examples/hello-web-tool
```

Manifest fields: [Plugin SDK](PLUGIN_SDK.en.md).

## 2. Pack `.useful`

```powershell
useful pack  examples/hello-web-tool  ./out
```

Output: `<id>-<version>.useful`.

## 3. Create a local static source → publish a tool

A static source needs no backend. Host files only (TUF metadata + content-addressed targets).

```powershell
useful source init  ./mysource --name "My Source" --id com.me.source
useful source add-package  ./mysource  ./out/com.useful.hello-1.0.0.useful
useful source publish  ./mysource
useful source export-static  ./mysource  ./dist
useful source serve  ./mysource --port 8090
```

`export-static` output never includes private keys.

The root fingerprint (SHA-256 of `1.root.json`) is the trust anchor when a client adds the source the
first time.

## 4. Client: add source → search → install

In the client Source Center:

1. Add source.
2. Enter the source URL.
3. Confirm the root fingerprint.
4. Sync catalog.
5. Search.
6. Install free tools.

Paid tools use OAuth login plus a download grant.

The UI shows separate signals. It does not merge them into one “safe” boolean:

- source signature
- publisher signature (Ed25519 or Sigstore)
- official review
- security scan
- source availability
- reproducible-build status

## 5. Publisher signature (choose one)

- **Ed25519:** Sign
  `useful-artifact-v1\n<toolId>\n<version>\n<sha256>`
  with a long-term private key. Submit `publisherSignature` with the release request. See
  [Security assurance](SECURITY-ASSURANCE.md) (Chinese).
- **Sigstore identity:** Sign with workflow OIDC identity. Submit `sigstoreBundle`. The server checks
  issuer and SAN policy. See [ADR-013](adr/ADR-013-sigstore-identity.md).

## 6. Client update keys (isolated from tool-source TUF)

```powershell
useful key init-root  ./updroot --env test --threshold 2 --roots 3
useful key sign-root  ./updroot --key ./updroot/keys/root-1.private.pem
useful key sign-root  ./updroot --key ./updroot/keys/root-2.private.pem
useful key verify-ceremony  ./updroot
useful app-update create  ./update.json --product useful-desktop --version 1.2.0 `
  --channel stable --env test --artifact ./Useful.zip
useful app-update sign  ./update.json --root ./updroot --key ./updroot/keys/release.private.pem
useful app-update verify  ./update.json --root ./updroot
```

Production root creation and code-signing certificates are Owner gates
([OWNER-GATES](OWNER-GATES.md), Chinese). `--production` verification rejects test roots (ADR-014).

## 7. Publish update / withdraw / advisory

- Publish a new tool version: repeat `add-package` + `publish` for a static source. Dynamic sources
  use `/v1/publisher/releases`.
- Withdraw: dynamic source `POST /v1/publisher/releases/{id}/withdraw`. Records remain. New grants
  return 403.
- Security advisory: `POST /v1/publisher/advisories`. Installed clients can see advisories through
  catalog endpoints.

Dynamic publisher APIs use RBAC plus API tokens (`Authorization: Bearer usefuls_…`). Create the first
admin token with `source-server -init-admin`. See [ADR-011](adr/ADR-011-api-token-rbac.md).

## 8. Key rotate / loss recovery

- Publisher key rotate: the new key needs cross-signature from the old key
  (`POST /v1/publisher/keys/rotate`). Without continuity proof, treat it as a new publisher.
- Update root rotate: `useful key rotate-root` (old keys revoked, version +1, re-sign to threshold).
- Single key revoke: `useful key revoke --keyid <id>`. Verification rejects signatures from revoked
  keys.

## 9. Self-hosted dynamic source

Full Chinese text for dynamic source deploy, monitoring, and operations is in
[DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md).

## Related English entry pages

- [Developer preview](DEVELOPER-PREVIEW.en.md)
- [Plugin SDK](PLUGIN_SDK.en.md)
- [AI Integration](AI-INTEGRATION.en.md)
- [Known limitations](KNOWN-LIMITATIONS.en.md)
