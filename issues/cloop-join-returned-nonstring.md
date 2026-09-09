# One-off: Array.prototype.join returned a non-string under CLoop

Seen once (2026-08-14, engine `20260814-083049-d1ff7e9-main`) in a long single eval that had already
run ~8 benchmarks: `parts.join('&')` on a 100k-element string array produced something whose
`.split` was `0` —

    TypeError: joined.split is not a function. (In 'joined.split('&')', 'joined.split' is 0)

The identical body run on its own (scripts/js-speed-probe.mjs, `string-build`) passes and returns the
right checksum, repeatedly. So: state-dependent, not deterministic.

Suspects, in order: the known intermittent CLoop `Structure::materializePropertyTable` offset
inconsistency (engine-internals.md) surfacing as a bad property read rather than an abort; memory
pressure/GC in a long-running eval; a rope/string edge case.

Next step if it recurs: capture with a build that has ASSERTIONS on, and note whether the preceding
work allocated heavily (the failing run had just built ~20k objects + a 1 MB string). Guest-visible
JS miscompilation would be serious — worth 30 minutes if a second sighting shows up, not before.
