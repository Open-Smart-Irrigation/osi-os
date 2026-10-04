# Command ledger before WATERMARK cloud parity

`osi-command-ledger/index.js` and `osi-command-ledger/package.json` are the
last state of
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/`
on main before the WATERMARK cloud-parity feature, taken from main commit
90ea6e56c. `scripts/deploy-command-ledger-dependency.test.js` installs them as
the "old pair" a deploy must keep runnable until migration 0068 has run.

`package.json` is byte-identical to main (sha256 `3fe84044...`).
`index.js` differs from main (sha256 `14bce06e...`) in one comment line only
(line 367): a gateway name was replaced by "A customer gateway" to keep
deployment identities out of new files. The code is unchanged.

Do not update these files when the live ledger changes: they stand for the
ledger that gateways run before this feature is deployed.
