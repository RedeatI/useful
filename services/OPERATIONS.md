# Source service publisher-proof operations

Migration `0007_publisher_proof.sql` deliberately does not invent or backfill publisher proof.
Artifacts created before proof persistence can therefore have an empty `publisher_signature`, an
empty `signature_method`, or `publisher_signature_verified = false`. The source service rejects
such rows from TUF publication and download grants with the stable message:

`legacy artifact has no independently verifiable publisher proof; explicit re-release or revalidation is required`

Operators must not repair these rows by toggling convenience booleans. The supported remediation is
an explicit re-release from the publisher using the original artifact digest and a valid Ed25519
signature over `useful-artifact-v1\n<toolId>\n<version>\n<lowercase sha256>`, or a future audited
revalidation workflow that persists the same independently verifiable proof. Until that workflow
exists, a legacy release remains unavailable for new installation.

First publication currently accepts Ed25519 proof only. Sigstore verification code remains available
for isolated verifier validation, but Sigstore release requests and legacy Sigstore artifacts are
not admitted to approve, TUF metadata, download-grant, or install paths until the client can verify a
complete publisher proof independently.

TUF publication is serialized through a repository publish lease. PostgreSQL holds a fixed advisory
lock on one physical connection for the complete published-artifact read, version allocation, and
targets/snapshot/timestamp write sequence. An unlock failure discards that connection rather than
returning a possibly locked session to the pool.

Publication and withdrawal first persist `publish-pending` or `withdraw-pending`. Pending rows are
not catalog/download candidates; metadata reconciliation includes publish intents and excludes
withdraw intents. A successful timestamp switch finalizes the rows and clears publish staging.
Startup reconciliation and idempotent Approve/Withdraw retries replay incomplete intents.

Versioned targets and snapshot objects use no-clobber storage writes: identical bytes are an
idempotent success, while different bytes force allocation and signing of a fresh metadata version.
Only `timestamp.json` is an atomically replaceable pointer.
