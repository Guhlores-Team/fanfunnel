# Preserved future work capsule

Archive SHA-256: `3b5086bd9fc5fd2426ab4f7ddd830f52153649182020905a5719cba5c2c9b1b1`. Size: 2,935,843 bytes.
This preserves prepared source; it is **not a release or a claim of completed
integration**. Current `../HANDOFF.md` and the committed repair checkpoint take
precedence over every historical note inside.

The archive contains exact source deltas for 0060 scratch (94 paths), 0061 bingo
(81), 0062 account security (67), 0063 operations (34), the mandatory 0063 safety
overlay (7 unique paths), final hardening 03 (36), and selected common/mapped
crypto, history, engagement, privacy-withdrawal and animation authorities. The
reviewed privacy authority includes common3 paths plus its mapped controller;
apply its exact correction before the context-only animation literal. No application source
from this archive has been applied to the current checkout by packaging it.

From the repository root, verify, extract and reconstruct **outside the checkout**:

```sh
(cd docs/handoff/artifacts && sha256sum -c SHA256SUMS)
mkdir -m 700 /tmp/fanfunnel-future-inputs
tar -xzf docs/handoff/artifacts/future-work-inputs.tar.gz -C /tmp/fanfunnel-future-inputs
python3 /tmp/fanfunnel-future-inputs/future-work-inputs/restore_historical.py --repo "$PWD" --output /tmp/fanfunnel-historical-sources
```

Both `/tmp` directories must be new (choose new names if already present). Git
must contain base `9642dfd4d24518c201f736f93387443e43d80a8f`, already in branch
history. The portable Python entrypoint performs no network, Git writes,
database calls, installs or deployment. It validates every member and all
before/after identities, reconstructs complete historical trees, applies all
six sequential patches and compares the full trees. Its output includes the
mapping from old environment-specific source paths to new restored directories.
Read the extracted `README.md` before integrating.

The included `prepared-composition/reassemble.py` is preserved unfinished work
with old environment constants. It requires review/adaptation and a clean new
0059 repair commit; it is not the portable restore entrypoint. The historical
numeric sources must be rebased deliberately to retain the current crypto,
privacy, history, engagement and animation fixes. Mirrors keep their complete
new prior prefix and append only the exact corrected next migration once. 0060
retires only the known one-time 0059 workflow correction after 0059 actual hosted
repair succeeds; its helper/tests stay. Apply the seven-path safety overlay
before first 0063 verification/CI/boot. Never copy an old whole controller or
mirror over newer common repairs.

`RECONSTRUCTION_PROOF.json` records actual local successful patch/full-tree
reconstruction for all six deltas (94/81/67/34/7/36). Source-only allowlisting and
credential-signature checks are recorded in `SOURCE_ALLOWLIST_PROOF.json`.
Dependencies, build output, environment/auth files, reward backups, provider
metadata, raw logs, screenshots and private fan URLs were excluded. These are
source preservation checks; every future release still needs the required two
complete verification rounds and exact-SHA CI/TEST/Preview checks.
