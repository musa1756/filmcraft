# filmcraft-mcp-lite

A token-lean MCP server for the **running** FilmCraft app. It talks to the app's JSON-lines
control channel (`FilmCraft --control 9876`), so it works with the installed `/Applications/FilmCraft.app`
and needs no Rust toolchain or `filmcraft-cli`.

Everything is reachable: all ~675 engine commands, the ~120 menu-only UI commands, every on-screen
element (click/drag/keys) and every raw control method. What changes is how much an agent has to
read to use them.

| | built-in `filmcraft-cli mcp` | this server |
|---|---|---|
| Find a command | `command_list` dumps the catalog (~38k tokens) | `fc_find "speed"`: matching lines only |
| Read the timeline | `sequence_inspect`: pretty JSON (~5–20k tokens) | `fc_seq`: one line per clip, non-default params only (~10× smaller) |
| Look at the cut | one screenshot per frame | `fc_sheet`: every shot in one small image |
| Animate | toggle + N × setParam + interpolation | `fc_keys` in one call |
| Rough cut | N × `timeline.place` with tick math | `fc_append` in one call |
| Export | poll `jobs.list` yourself | `fc_export` waits, reports progress, runs ffprobe |
| Time | ticks (254 016 000 000/s) | any `key_s` (seconds) / `key_f` (frames) is converted, frame-snapped |

## Tools

`fc_app` (status / launch / restart), `fc_guide` (verified recipes by topic), `fc_find`, `fc_help`,
`fc_run`, `fc_batch`, `fc_seq`, `fc_project`, `fc_clip`, `fc_effects`, `fc_keys`, `fc_append`,
`fc_frame`, `fc_sheet`, `fc_shot`, `fc_ui`, `fc_control`, `fc_export`.

## Setup

```sh
cd mcp && npm install
```

`.mcp.json` (Claude Code):

```json
{ "mcpServers": { "filmcraft": { "command": "node", "args": ["/abs/path/filmcraft/mcp/src/server.mjs"] } } }
```

The server launches FilmCraft with the control port when it isn't running. If the app is already open
without the port, `fc_app {action:"restart"}` relaunches it (save first).

Environment: `FILMCRAFT_PORT` (9876), `FILMCRAFT_APP` (path to the app binary),
`FILMCRAFT_AUTOLAUNCH=0` to never launch, `FFMPEG` (for image downscaling and contact sheets;
ffmpeg runs only as an external tool).

## Tests

`npm run smoke` runs read-only checks against the running app (it never edits the open project).
`node test/call.mjs <tool> '<json>' …` calls any tool through a real MCP client.
