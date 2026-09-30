# Status Pages: a Blipbar extension

Blipbar is a macOS app that shows live items, called blips, in the Mac's notch. This folder
is one extension for it, in TypeScript with `@blipbar/api`.

- The guides are in `node_modules/@blipbar/api/docs/` (start with `extension-authoring.md`),
  and online at https://blipbar.app/docs/extensions.txt.
- `npx blipkit validate` runs it once without the app; `npx blipkit validate --tool <id> --values '<json>'`
  runs a tool once.
- `npx blipkit dev` builds on save, links it into Blipbar and prints its log as `[log]`. It keeps running.
- Declare every host it fetches in `blipbar.permissions.network`. Node's own `http`, `net` and
  `child_process` are off limits: use `fetch` and `ctx.exec`.
- Keep API keys in a `password` preference, never in the code.
- Pick a layout and a state for each blip; Blipbar draws it. There's no custom UI or colour.
- Blipbar schedules runs: return `{ nextRunAfter }` instead of setting timers.
