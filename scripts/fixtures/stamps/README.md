# Timestamp fixtures

Real receipts for `scripts/stamp.test.js`, so the tests never need the network.

| File | What it is |
|---|---|
| `freetsa.tsr` | A FreeTSA TimeStampResp (Oct 7, 2026) for the hash in `freetsa.hash`, requested without certificates (`openssl ts -query -digest … -sha256`) |
| `freetsa-with-certs.tsr` | The same hash, requested with `-cert`: the token carries FreeTSA's signing certificate and root |
| `local-rsa.tsr`, `local-p256.tsr` | Tokens from a throwaway local authority (`openssl ts -reply`, ESS signing-certificate v2, SHA-256) for the hash in `local.hash`, signed by an RSA-2048 and a P-256 key; their roots are `local-rsa-root.pem` and `local-p256-root.pem` |
| `hello-world.txt.ots`, `hello-world.txt` | python-opentimestamps' example: a finished proof in Bitcoin block 358391 (uses RIPEMD-160) |
| `merkle1.txt.ots`, `merkle1.txt` | python-opentimestamps' example: pending at two calendars, through a merkle tree |
| `neo-pending.ots` | A proof made by `stamp-ots.js` against the four public calendars (Oct 7, 2026) for the hash in `neo-pending.hash`; `ots info` reads it, and python-opentimestamps writes it back byte for byte |
| `block-358391.txt` | Block 358391's id and 80-byte header, from mempool.space |

FreeTSA's certificates (`certs/freetsa-root.pem`, `certs/freetsa-tsa.pem`) are NEO's own trust anchors, from https://freetsa.org/files/.
