# Wanderer game

The is a test game that is developed exclusively by prompting the DeepSeek Flash. The code, assets, sounds, music and most of the text are done by it.

# How to run

Install Node.js and run `npm install`. After that run `npx vite` and open the link.

# Libraries

- Three.js, MIT
- Tone.js MIDI
- lil-gui
- coi-serviceworker

## coi-serviceworker patch

The vendored copy is marked with `PATCHED` comments. Changes from upstream v0.1.7:

- The fetch handler adds `Document-Policy: js-profiling` to navigations that include `?profile`, so JS profiling is enabled only after the user chooses **Enable profiling**.

# License

Who knows?
