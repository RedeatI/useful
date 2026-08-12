# PR notes: README and English entry docs

## Summary

Rewrite public README in short technical English and matching plain Chinese. Add English entry pages
for docs that English readers hit from the default README. Label document language on both sides.

## Why

- Default English README linked into Chinese-only deep docs without labels.
- Previous README repeated legal-style disclaimers and AI-sounding phrasing.
- Clone instructions still said the sanitized repository was not public.

## What changed

### README

- `README.md` (English, STE-style)
- `README.zh-CN.md` (plain Chinese, same structure)

### English entry pages

- `docs/KNOWN-LIMITATIONS.en.md`
- `docs/DEVELOPER-PREVIEW.en.md`
- `docs/AI-INTEGRATION.en.md`
- `docs/TOOL-ACTIONS.en.md`
- `docs/PLUGIN_SDK.en.md`
- `docs/DEVELOPER-GUIDE.en.md`
- `docs/UTILITIES-ARCHITECTURE.en.md`
- `docs/agent/BUILD-A-TOOL.en.md`
- `docs/COMPUTER-USE.en.md`
- `docs/SECURITY-ASSURANCE.en.md`
- `docs/README-I18N.md` (language map)
- `docs/PR-README-STE.md` (this file)

### Chinese originals

- Language switcher lines added at the top of paired Chinese pages.

## Out of scope

- Full line-by-line English translation of every `docs/*` file
- Product code, CLI behavior, or release assets
- Push to GitHub (operator action)

## Test plan

- [ ] Open `README.md` on GitHub preview. Click each English entry link. Confirm pages open in English.
- [ ] Open `README.zh-CN.md`. Confirm Chinese deep links still open Chinese pages.
- [ ] Confirm clone block has no “after the sanitized repository is made public” wording.
- [ ] Confirm Action count claims still say 36 Actions and 40 MCP tools.
- [ ] Spot-check Office and Agent limit wording against `docs/KNOWN-LIMITATIONS.md`.
