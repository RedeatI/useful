# Useful Trademark Policy

> This document is not legal advice. It must be reviewed before a public release.

## Open-source licenses and marks

The repository's open-source licenses grant rights in covered code and documentation. They do not
automatically grant rights to use the **Useful** name, logo, or official certification marks in a
way that implies sponsorship, endorsement, or an official build.

You may accurately state that a project is based on or compatible with Useful. Forks and modified
distributions should use their own product identity and clearly describe material changes. They must
not claim to be an official Useful release or source without authorization and matching technical
provenance.

## Technical identifiers

The project uses `Useful.exe`, `io.github.redeati.useful`, the Windows `Useful` data directory, `useful.*`
schemas, and `useful` package and command names. These identifiers do not grant permission to present
a third-party product as an official Useful build.

Using those identifiers where required for protocol, plugin, profile, update, shortcut, or data
compatibility is allowed by this policy when it is factual and does not create brand confusion.

## Forks, tools, and self-hosted sources

- A third-party fork must not present itself as an official Useful build.
- A third-party `.useful` tool may state factual compatibility, publisher identity, signature result,
  and version information.
- A self-hosted source may state factual signature and trust status, but must not display an official
  Useful source badge merely because it copies a name, source ID, URL, certificate, icon, or operator
  field.
- “Self-hosted” and “alternative service provider” are supported descriptions; do not describe
  normal source configuration as bypassing or cracking a service.

## Official identity

Official source and release identity is a cryptographic and operational decision. It must come from
the configured production trust roots and signed release process, not from branding strings. Before
those roots and the public repository are finalized, this repository makes no claim that an official
download, signed release, or official source is live.

## Assets outside the open-source distribution

Open-source licenses do not grant access to or rights in operational secrets and private assets,
including production signing/KMS keys, credentials, user data, production databases/configuration,
private packages, paid artifacts, CDN credentials, or private risk-control data.
