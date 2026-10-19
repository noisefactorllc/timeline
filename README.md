# Timeline

Cut Noisemaker programs to music on a timeline. Timeline is an audio reactive video editor for music videos, ads and anything else that moves with sound. You arrange Noisemaker DSL programs, transitions, text, images and video on tracks over your music. Every program can read the music through `audio()`, a shared post chain finishes the whole frame, and export writes every frame exactly to MP4 or WebM.

Use it at **https://timeline.noisedeck.app**. Your media stays on your computer: Timeline keeps a project in your browser or in a folder you choose, and never uploads it.

## Installation

### In the browser

There is nothing to install. Open https://timeline.noisedeck.app in a desktop browser with WebGL2. Chrome and Edge support everything Timeline uses. Opening a project folder needs the File System Access API, and export uses the browser's built-in WebCodecs encoders.

### The command-line tool

The `timeline` command checks a project folder, renders still frames of it, and renders the video. It runs the real app in Chrome on your computer. Chrome asks for the project's files, and the tool answers from disk, so nothing is uploaded.

You need Node 22 or later and Google Chrome. To use another Chromium build, set `CHROME_PATH`. The tool has no other dependencies.

```bash
git clone https://github.com/noisefactorllc/timeline.git
cd timeline
npm install -g .
```

To run it without installing, use `node cli/timeline.mjs` in place of `timeline`.

| Command | What it does |
|---|---|
| `timeline check <folder>` | Reads the project, compiles every program, and loads every media file, font and effect. It lists problems, and exits with 1 on errors. |
| `timeline snapshot <folder> --at 4,12.5,1:04` | Writes PNG frames to `<folder>/snapshots`, rendered exactly as export renders them. |
| `timeline render <folder>` | Writes the video to `<folder>/renders/<sequence>.mp4`. |

`render` takes these options:

| Option | What it sets |
|---|---|
| `--from` and `--to` | The range to render. |
| `--scale 0.5` | Renders at that fraction of the sequence's size. |
| `--format webm` | Writes WebM instead of MP4. |
| `--quality medium`, `high` or `best` | The bitrate. |
| `--no-audio` | Leaves the sound out. |
| `--out FILE` | Writes to that file instead. |

Every command also takes these:

| Option | What it does |
|---|---|
| `--json` | Writes output you can parse. |
| `--sequence NAME` | Chooses a sequence other than the main one. |
| `--url URL` | Runs another copy of the app instead of timeline.noisedeck.app. |

### The Claude Code plugin

The plugin teaches Claude to make videos with Timeline. It covers the project format, the DSL wiring, and the check, snapshot and render loop. In Claude Code, run:

```
/plugin marketplace add noisefactorllc/timeline
/plugin install timeline@noisefactor-timeline
```

From a clone, add the marketplace by its path instead: `/plugin marketplace add ./timeline`.

To make a video, describe what you want to Claude, such as the length, the music, the words on screen and the look. Claude writes a project folder and asks you to open it in Timeline, so you can watch the sequence take shape and edit alongside it. Then it checks the project, looks at frames, and renders the video.

## Project folders

A project can live in a folder: a `project.json`, and the media it names by relative path. To open one, choose File, then Open folder, in Chrome or Edge. An empty folder starts a new project.

- Changes made to the folder by another program, such as an editor or an agent, appear within a second. Undo steps back over each one.
- Your edits in Timeline are saved back to the folder.

Only `sequences` is required, and everything else has a default:

```json
{
  "media": { "song": { "path": "media/song.mp3" } },
  "sequences": {
    "main": {
      "duration": 16, "bpm": 120,
      "tracks": [{ "clips": [
        { "start": 0, "duration": 16, "dsl": "search synth, filter\nnoise(octaves: 3, colorMode: rgb)\n  .bloom(intensity: audio(band: audioBand.low, min: 0.1, max: 0.5))\n  .write(o0)\nrender(o0)" }
      ] }],
      "audioTracks": [{ "clips": [{ "mediaId": "song", "start": 0 }] }]
    }
  }
}
```

The full format is the JSON schema in [`schema/project.schema.json`](schema/project.schema.json), also served at https://timeline.noisedeck.app/schema/project.schema.json.

## Development

```bash
npm install
npm run dev                       # http://localhost:3027
npm test                          # unit tests
npm run lint                      # syntax check
npx playwright install chromium   # once, for the end-to-end tests
npm run test:e2e                  # end-to-end tests in Chromium
```

There is no build step. The site is `index.html`, `css/`, `js/`, `img/`, `media/` and `schema/`, served as they are. The Noisemaker engine loads from shaders.noisedeck.app, the interface components from handfish.noisefactor.io, and the typefaces from fonts.noisefactor.io. A push to `main` publishes timeline.noisedeck.app.

- `npm run vendor` copies Mediabunny and fflate from `node_modules` into `js/lib`.
- `npm run demo-audio` renders the demo soundtrack again. It needs Chrome and ffmpeg.

## Demo soundtrack

The demo, Refinery, plays a 60-second industrial techno track at 128 BPM. It comes as two lossless stems in `media/`: `refinery-drums.flac` and `refinery-synths.flac`. The track is synthesized entirely by the code in `scripts/demo-track/synth.js`, with no samples.

## Libraries

- [Noisemaker](https://github.com/noisefactorllc/noisemaker): the shader engine, by Noise Factor (MIT License)
- [Handfish](https://handfish.noisefactor.io): interface components, by Noise Factor (MIT License)
- [Mediabunny](https://github.com/Vanilagy/mediabunny), by Vanilagy: video encoding and decoding through WebCodecs, vendored in `js/lib` (MPL-2.0 License)
- [fflate](https://github.com/101arrowz/fflate), by Arjun Barrett: zip files, vendored in `js/lib` (MIT License)
- Atkinson Hyperlegible and Noto Sans Mono: typefaces (OFL-1.1)
- The typefaces offered for text clips come from the Noise Factor font service, each under its own license
- Material Symbols: icon font, by Google (Apache 2.0 License)

## License

Timeline is released under the [MIT License](LICENSE). Use of the Timeline and Noise Factor names in derivative products is subject to the [Trademark Policy](TRADEMARK.md).

Copyright (c) 2026 Noise Factor LLC
