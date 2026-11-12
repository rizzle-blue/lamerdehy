---
kind: upgrade-guide
description: "Removes the shipped Session upload, plugin inventory, and Desktop analytics rows from Lam Hy profiles."
---

# Session diagnostics stay local

## Change

Lam Hy profiles keep Session feedback, statistics, and crash reports locally. The shipped profiles no longer mount Session uploads, the DeepSeek plugin inventory, or Desktop analytics. DeepSeek model requests no longer include installation or Session identifiers in their headers. Existing Session logs remain readable.

## Migration

1. Remove overrides for `session-log-deepseek`, `session-telemetry-otel`, `otel`, `plugin-package-inventory-deepseek`, `desktop-product-telemetry`, `product-analytics`, and `ui-settings-session-log` from your profile and home `cordis.patch.yml` files. Review custom rows that install exporters separately.
2. If you construct `DeepSeekAdapter` directly, remove `resolveUserId` from its options.
3. Run `dsh --profile web --dump-config` and confirm the removed rows are absent. Open an existing Session in Web and check that its history and feedback remain available.
