# vinyl

A record player simulated "from the groove up" in the browser: **[vinyl-gl.vercel.app](https://vinyl-gl.vercel.app)**.

Instead of playing an audio file, the music is cut into a spiral [groove](https://en.wikipedia.org/wiki/Phonograph_record), and a simulated [stylus](https://en.wikipedia.org/wiki/Phonograph#Stylus), cantilever, [tonearm](https://en.wikipedia.org/wiki/Phonograph#Arm_systems) and [cartridge](https://en.wikipedia.org/wiki/Magnetic_cartridge) read it back on the audio thread. What you hear is the voltage that motion would induce in the cartridge, after phono equalisation.

This is a _physical simulation_ of a record player's mechanics, which happen to play sound.

## Features

- **"Real", procedural flaws**: hiss and crackle are roughness and dust on the groove walls. A scratch ticks once per turn because the needle crosses it once per turn. Treble dulls toward the label because the groove moves slower there. Knock the table and it skips.
- **Real physics, in real time**: a 2 DOF stylus tip on [Hertzian](https://en.wikipedia.org/wiki/Contact_mechanics#Hertzian_theory_of_non-adhesive_elastic_contact) wall contacts with friction, oversampled inside an `AudioWorklet`, with platter inertia, arm kinematics, [RIAA de-emphasis](https://en.wikipedia.org/wiki/RIAA_equalization) and three stylus shapes (conical, elliptical, micro-line).
- **Bring your own audio**: _Cut a file_ runs the lathe on anything you drop in, in a worker, in the browser. _Press again_ makes a dirtier (or cleaner) copy of the same cut.
- **DJ mode**: _Add deck_ puts a second turntable and a mixer next to the first, on one audio clock. Hot cues, beat loops, a jog wheel, tap tempo and sync, a two-channel mixer with EQ kills, filter, echo, crossfader and headphone cue, and recording of the mix to a file. Tempo is measured from the groove itself, so sync works on records you cut too.
- **No dependencies, no bundler**: plain ES modules, WebGL2 and Web Audio. The build copies files.

## Running it

```bash
$ vercel dev
```

That's it. `vercel dev` runs the same build as production (`node build.mjs`, which writes `dist/`) and serves it on [localhost:3000](http://localhost:3000). It builds once, so restart it after editing.

There's nothing to install. Node 22+ is enough for the build and the tests:

```bash
$ npm run build   # dist/: index.html, src/, assets/, records/
$ npm test        # offline checks of the physics (response, distortion, surface noise, cue, skip) and the DJ mixer
$ npm run bench   # CPU cost of the engine per second of audio
```

## How it works

**1️⃣ Cut.** The lathe ([`src/cut.js`](src/cut.js)) turns audio into the shape of the two walls of a [45/45 stereo groove](https://en.wikipedia.org/wiki/Phonograph_record#Stereophonic_sound) at 33⅓ rpm: RIAA pre-emphasis, an acceleration limiter so the cutter could have cut it, and a spiral pitched so the side fits on a 12" disc.

**2️⃣ Press.** The pressing plant ([`src/press.js`](src/press.js)) changes the geometry itself: wall roughness, dust, scratches, warp, an off-centre hole, groove echo. Nothing in it is an audio effect. It's seeded, so the same record always presses the same way.

**3️⃣ Play.** The engine ([`src/engine.js`](src/engine.js), [`src/engine-core.js`](src/engine-core.js), [`src/groove.js`](src/groove.js)) rides the stylus over those walls. A tip of finite radius can't follow the wall exactly, and that's where tracing distortion, pinch effect and inner-groove loss come from. Too little tracking force and it leaves the wall.

**4️⃣ Draw.** The deck ([`src/render.js`](src/render.js), [`src/shaders.js`](src/shaders.js)) draws the disc from the cut itself: the actual spiral, lit by how hard each revolution is modulated.

**5️⃣ Mix.** With two decks, both engines play into the desk ([`src/desk-worklet.js`](src/desk-worklet.js)), a mixer on the audio thread: trim, a three-band isolator with kills, filter, echo, channel faders, a crossfader, a split headphone cue and a look-ahead limiter. Each track's tempo is read off the groove walls ([`src/tempo.js`](src/tempo.js)), and the engine can jump and loop between two points of the spiral without a click.

## Records

Cutting a whole side takes a while, so the records on the shelf are cut ahead of time and committed to `assets/`. The clean cut ships as 16-bit [DPCM](https://en.wikipedia.org/wiki/Differential_pulse-code_modulation) inside FLAC (within a quarter of a nanometre of the cut wall), and the page presses it with the seed. The source audio lives in `records/`, listed in [`src/records.js`](src/records.js).

To add a record, or after changing the lathe, re-cut what's out of date (needs `ffmpeg`) and commit `assets/`:

```bash
$ npm run lathe           # every record that is out of date
$ node lathe.mjs toccata  # just this one
```

The build refuses to deploy a shelf record that was never cut.

## Credits

Every recording is public domain or freely licensed:

- Gershwin, _Rhapsody in Blue_: George Gershwin, piano, with Paul Whiteman's Concert Orchestra, Victor, 1924 ([LOC](https://www.loc.gov/item/jukebox-70342/))
- Beethoven, _Moonlight Sonata_: Paul Pitman, piano, for Musopen
- Satie, _Gymnopédie No. 1_: Robin Alciatore, piano, for Musopen
- Chopin, _Nocturne Op. 9 No. 2_: Frank Lévy, piano, for Musopen
- Debussy, _Clair de lune_: Laurens Goedhart, piano, 2011
- Grieg, _In the Hall of the Mountain King_: Musopen Symphony
- Tchaikovsky, _1812 Overture_: US Marine Band, live at Wolf Trap, 2019
- Bach, _Toccata and Fugue_: Ashtar Moïra, organ
- Vivaldi, _Summer: Presto_: John Harrison, violin, with the Wichita State University Chamber Players (CC BY-SA 4.0)
- HoliznaCC0, _Summer Air_ (CC0, [Free Music Archive](https://freemusicarchive.org/music/holiznacc0/summer-air-lo-fi/))

Sources for each are linked in [`src/records.js`](src/records.js). The _Demo EP_ is synthesised by the page.

## License

The code is [MIT](LICENSE). The recordings in `records/`, and the records cut from them in `assets/`, keep their own licenses, listed above. _Summer: Presto_ is CC BY-SA 4.0, so its cut is too.
