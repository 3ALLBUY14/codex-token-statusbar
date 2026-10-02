# Third-party notices

The capsule, status colors, context mini-bar, and panel styles are adapted from
[xhwxt/zcode-token-usage-statusbar](https://github.com/xhwxt/zcode-token-usage-statusbar),
commit `ac328de0523f60b83d0c5cd3ccacda8eda86f55e`.
Copyright (c) 2026 xhwx. MIT license; retained in `third_party/zcode/LICENSE`.
The original ZCode installer, database collector, and injection loader are not run.

The Codex IPC framing and active-thread notification names were researched against
[soleillevant0125/codex-token-overlay](https://github.com/soleillevant0125/codex-token-overlay).
The client in this project is an independent Node.js implementation. IPC is an
internal, version-sensitive Codex interface; connection loss and ambiguous routes
are shown explicitly.

The visible-document-title fallback was inspired by a community contributor's
`0.4.2-local.2` fix shared as a local package. The title index reader and selection
arbitration here are independently implemented; no executable or installer from
that package is redistributed.

Electron and its packaged dependencies retain their license notices in the
portable distribution (`LICENSE`, `LICENSES.chromium.html`, and dependency files).
