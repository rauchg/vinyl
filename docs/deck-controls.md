# Deck controls and hardware references

This project synthesizes sound from a simulated groove, stylus, cartridge and
turntable mechanics. Deck gestures must change those same engine parameters;
rotating the rendered platter alone would leave playback speed unchanged.

The renderer describes a generic direct-drive deck. Its layout resembles a
Technics SL-1200, but it does not claim to reproduce a particular model. The
SL-1200MK7 manual is the reference for the control layout and pitch ranges;
Audio-Technica's documentation independently explains the tonearm adjustments.
Sources were consulted on 2026-11-09.

## Control mapping

| Visible control | Behavior in this app | Hardware reference |
| --- | --- | --- |
| Front-left round switch/strobe housing | Toggles deck power. Switching off cuts motor drive and lets the platter coast; powering on does not move the arm or start the motor. | Technics manual, pp. 8, 18–19 |
| Large rectangular front-left button | Starts/stops the motor while deck power is on. | Technics, pp. 18–19 |
| Small 33 / 45 buttons | Select base RPM; the panel additionally offers 78.26 RPM. Both deck speed lamps light at 78. | Technics, pp. 18–19 (hardware calls this 78 RPM) |
| Right-hand slider | Fine speed/pitch adjustment: toward the front increases speed, toward the back decreases it. The center snaps to zero. | Technics, p. 20 and its slider diagram |
| Pitch controls in the panel | Default range ±8%; selectable ±16%; Reset pitch returns the slider to zero. | Technics, p. 20 |
| Cue lever beside the arm | Raises/lowers the needle without stopping the platter. | Technics, pp. 18–19; Audio-Technica tonearm guide |
| Counterweight behind the arm | Drag up/right to increase tracking force, down/left to decrease it; the same value appears in Tracking g. | Technics, pp. 14–15; Audio-Technica tonearm guide |
| Small dial beside the arm pivot | Drag up/right to increase anti-skate compensation, down/left to decrease it; synchronized with Anti-skate. | Technics, p. 15; Audio-Technica anti-skate guide |
| Added front-right knob | App output volume, synchronized with App volume in the panel. This is an app convenience, not an original SL-1200 control. | App-specific addition |

Power, motor state, needle position and output volume are independent. A spinning
record can be silent when the needle is lifted or resting outside the groove.
For manual playback, power on, start the motor, move the arm over the record,
and lower the needle. The original introductory power pill and first tap on
empty space retain the app's one-gesture autoplay shortcut. That shortcut is
separate from using the physical deck power switch.

Pitch changes the engine's target angular velocity:

```
actual target RPM = selected base RPM × (1 + pitch percentage / 100)
```

At 33⅓ RPM and +8%, the target is about 36 RPM. Both tempo and musical pitch
increase because the stylus reads the groove faster. The renderer follows actual
engine telemetry, including acceleration and coast-down.

## Intentional simplifications

- This is a generic deck, not an exact MK7 replica. The zero light indicates a
  centered pitch slider; the panel's reset returns it to zero. The MK7 instead
  has a dedicated reset/lock button that overrides the slider's position.
- Tracking force and anti-skate use the existing simulated parameters and ranges.
  Dragging adjusts them directly; it does not reproduce the complete mechanical
  procedure of balancing an actual arm and calibrating its numbered ring.
- Counterweight travel and dial/lever animation show the current setting. Their
  geometry is illustrative rather than a calibrated hardware model.
- The existing platter dots/light remain visual details. They are not a calibrated
  stroboscope and must not be used to measure RPM; use the telemetry readout.
- The existing engine uses the same motor-off/coast model for Start/Stop and
  power-off. An electronic brake with a separate stopping curve is not added.
- Volume is output gain. Tracking force and anti-skate are not loudness controls.
  Anti-skate initially matching tracking force is a manufacturer starting point,
  not a reason to couple their values automatically during later adjustments.

## Sources

1. [Technics SL-1200MK7 owner's manual](https://help.na.panasonic.com/wp-content/uploads/2023/02/SL1200MK7_TQBM0410_ENG_FRE.pdf),
   printed English pages 8, 14–15, 18–20. Includes the named parts, power versus
   Start/Stop, cueing, speed selection, pitch direction, ±8/±16% ranges and reset.
   [Official product support page](https://help.na.panasonic.com/technics/turntables/sl-1200mk7/).
2. [Audio-Technica AT-LP2022 tonearm guide](https://www.audio-technica.co.jp/document/AT-LP2022/en/Content/Turntable/AT-LP2022/part-names/names-tonearm.html).
   Defines counterweight, tracking-force ring, cue lift and anti-skate dial.
3. [Audio-Technica AT-LP2022 anti-skate adjustment](https://www.audio-technica.co.jp/document/AT-LP2022/en/Content/Turntable/AT-LP2022/preparation/setting-anti-skate.html).
   Explains inward skating force and the initial matching setting.
4. [Original renderer](https://github.com/rauchg/vinyl/blob/bcc9264/src/render.js)
   and [original UI wiring](https://github.com/rauchg/vinyl/blob/bcc9264/src/main.js).
   The original deck controls were drawn as meshes; RPM and cartridge parameters
   were already supported by the panel and physics engine.

## Browser verification checklist

- With the deck off, Start is disabled. Powering on from its physical switch
  leaves the motor off and the arm alone. Start then spins the platter.
- Start/Stop does not toggle deck power or the strobe light. Power off stops
  motor drive; power on works again after the introductory pill has disappeared.
- At either base speed, the slider's front endpoint produces a positive pitch
  percentage and the rear endpoint a negative one. Center/reset produces zero.
  Check both ±8% and ±16%; shrinking the range clamps the current pitch.
- Panel changes update the deck slider/knobs; deck gestures update panel readouts.
- Cue raises/lowers the stylus without changing motor state. Adjusting the weight
  and anti-skate changes their corresponding panel values independently.
- Volume reaches silence at 0% and changes neither RPM nor tracking force.
- Cancelled button gestures, a drag away from a button, and a two-finger pinch
  must not accidentally activate it. Camera orbit, arm movement and record
  scratching still work outside the control targets.
- Check a touch device and iOS Safari separately: audio resume remains in a
  click/touchend gesture, but desktop synthetic events cannot prove iOS behavior.
