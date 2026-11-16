# Third-Party Notices

This project includes or depends on third-party software. Original copyright and license notices remain in effect.

## Stockfish.js 19.0.1

The following Stockfish.js `v19.0.1` release artifacts are bundled unmodified, except for renaming the ASM file. SHA-256 values are retained from the existing provenance inventory; they are not a claim of fresh APK/AAB or signature verification.

| Bundled file | Upstream artifact | SHA-256 |
| --- | --- | --- |
| `app/src/main/assets/lib/stockfish-local.js` | `stockfish-19-asm.js` | `c07dad9a00a89f4b1dcba3971d58d8078715556eac0212368e4aab510e1e27c9` |
| `app/src/main/assets/vendor/stockfish/stockfish-19-single.js` | `stockfish-19-single.js` | `8071dee87312f74805a859de933e1a1ef465579ab1a51fbd597388cdce9d444d` |
| `app/src/main/assets/vendor/stockfish/stockfish-19-single.wasm` | `stockfish-19-single.wasm` | `991bede2f253ebb08ff01fcc48270f4b9c8e66b12d5bd5f8d6f52eb3e3b3a740` |

Copyright notice from the bundled artifact:

```text
Stockfish.js 19 (c) 2026, Chess.com, LLC
Based on Stockfish (c) T. Romstad, M. Costalba, J. Kiiski,
G. Linscott and other contributors.
Nets by Chris Bao (sscg13).
```

License: GNU General Public License version 3 or later.

Source and build scripts:

- https://github.com/nmrugg/stockfish.js/tree/v19.0.1
- https://github.com/nmrugg/stockfish.js/blob/v19.0.1/build.js
- https://github.com/official-stockfish/Stockfish/tree/sf_19
- Full NNUE input: `nn-1a298aa575a0.nnue`, https://tests.stockfishchess.org/nns?network_name=nn-1a298aa575a0
- Lite NNUE input: `nn-61e7af4bb97d.nnue`, https://tests.stockfishchess.org/nns?network_name=nn-61e7af4bb97d

The pinned stockfish.js source includes the C++ engine, Emscripten glue, and build scripts. Its upstream build procedure requires Emscripten **6.0.9** and Node.js; run `./build.js --all` in that checkout. Outputs are written to `src/`. Bundle `stockfish-19-single.js` with `stockfish-19-single.wasm`, and rename the upstream `stockfish-19-asm.js` to `app/src/main/assets/lib/stockfish-local.js`. The base Stockfish link alone does not supply the stockfish.js glue, lite-network changes, or build procedure.

Detailed mapping and source references: [app/src/main/assets/vendor/stockfish/SOURCE.txt](app/src/main/assets/vendor/stockfish/SOURCE.txt).

Release artifact:

- https://github.com/nmrugg/stockfish.js/releases/download/v19.0.1/stockfish-19-asm.js
- https://github.com/nmrugg/stockfish.js/releases/download/v19.0.1/stockfish-19-single.js
- https://github.com/nmrugg/stockfish.js/releases/download/v19.0.1/stockfish-19-single.wasm

The complete GPL text is in [LICENSE](LICENSE) and is packaged next to Stockfish as `app/src/main/assets/vendor/stockfish/COPYING.txt`. The Gradle build also packages local copies of `LICENSE`, `APACHE-2.0.txt`, and `THIRD_PARTY_NOTICES.md` as assets; CI artifact ZIPs include these notices alongside the binaries.

The Android application source needed to build the APK is this repository. Anyone distributing an APK or AAB must preserve the notices and keep the complete corresponding source for that version, including engine source, build scripts, and network inputs, available by an allowed GPL section 6 method. An expiring CI artifact is not a substitute for those obligations. The asset-integrity script does not authenticate the publisher or verify an APK signature.

## AndroidX

The application uses these direct AndroidX runtime dependencies:

| Component | Version |
| --- | --- |
| Core KTX | 1.18.0 |
| AppCompat | 1.8.0 |
| Browser (Custom Tabs) | 1.9.0 |
| WebKit | 1.18.0 |

AndroidX and its transitive AndroidX components are copyright The Android Open Source Project and contributors and are distributed under the Apache License 2.0. Resolved versions are recorded in [app/gradle.lockfile](app/gradle.lockfile).

- https://github.com/androidx/androidx
- Local license text: [`APACHE-2.0.txt`](APACHE-2.0.txt)

## Kotlin

The Kotlin Gradle plugin and Kotlin standard library **2.1.21** are copyright JetBrains and contributors and are distributed under the Apache License 2.0. The standard library is a runtime dependency; the plugin is a build tool.

- https://github.com/JetBrains/kotlin
- Local license text: [`APACHE-2.0.txt`](APACHE-2.0.txt)

## Kotlin Coroutines

Runtime transitive dependencies `kotlinx-coroutines-core-jvm` and `kotlinx-coroutines-android` resolve to **1.9.0**. Kotlin Coroutines is copyright JetBrains and contributors and is distributed under the Apache License 2.0.

- https://github.com/Kotlin/kotlinx.coroutines
- Local license text: [APACHE-2.0.txt](APACHE-2.0.txt)

## Guava ListenableFuture

The runtime transitive dependency `com.google.guava:listenablefuture:1.0` is part of Guava, copyright Google and contributors, and is distributed under the Apache License 2.0. Other Guava versions in the lockfile belong to internal build/test tooling, not this runtime dependency.

- https://github.com/google/guava
- Local license text: [APACHE-2.0.txt](APACHE-2.0.txt)

## Opening Data

`app/src/main/assets/data/eco-book.js` is generated from **lichess-org/chess-openings**, dedicated to the public domain under **CC0-1.0**. Its provenance notice is copied unchanged from the extension source and packaged as [app/src/main/assets/data/chess-openings.COPYING.txt](app/src/main/assets/data/chess-openings.COPYING.txt).

- Source: https://github.com/lichess-org/chess-openings
- CC0 text: https://creativecommons.org/publicdomain/zero/1.0/legalcode

## Gradle Wrapper

The repository includes the Gradle Wrapper JAR and scripts for Gradle 8.13. Gradle is copyright Gradle, Inc. and contributors and is distributed under the Apache License 2.0.

- https://github.com/gradle/gradle/tree/v8.13.0
- Local license text: [`APACHE-2.0.txt`](APACHE-2.0.txt)

## Project License

Except where a file or this notice says otherwise, ChessCoach Android is distributed under GNU GPL version 3 or later. See `LICENSE` for the complete terms. There is no warranty, to the extent permitted by law.
