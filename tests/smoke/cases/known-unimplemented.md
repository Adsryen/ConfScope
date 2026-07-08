# Known Unimplemented Product Features

This file tracks product capabilities that are not implemented. Automation gaps, environment gaps, and accepted manual-risk
items belong in `tests/smoke/cases/matrix.md`, not here.

Current status:

- No confirmed product-unimplemented items are tracked by the reusable container smoke suite.

Notes:

- Native Apollo, native Consul, native config snapshot WebDAV, native app-data WebDAV explicit list, and Docker SSH smoke are
  covered by `tests/smoke/native/specs/native-full.spec.ts`.
- Real external MSE, public update feed checks, OS dialogs, install/restart, and external file-open workflows are environment
  or risk-acceptance rows in the matrix.
