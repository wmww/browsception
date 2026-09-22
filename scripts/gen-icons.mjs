#!/usr/bin/env node
// Renders icon.svg (the source of truth) to the PNGs both manifests list
// (`icons` + `action.default_icon` in scripts/lib/manifest.mjs). Chrome takes
// no SVG icons, so both browsers get the same PNGs. Output is committed; rerun
// after editing icon.svg. Needs rsvg-convert (librsvg).
//
// icons/source.sha256 records which icon.svg the PNGs came from; tier-0
// manifest.test.mjs fails when it goes stale.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutRoot } from './lib/paths.mjs';
import { ICON_SIZES, iconPath } from './lib/manifest.mjs';

const svg = join(checkoutRoot, 'icon.svg');
const src = join(checkoutRoot, 'src');
mkdirSync(join(src, 'ext/icons'), { recursive: true });
for (const size of ICON_SIZES)
  execFileSync('rsvg-convert', ['-w', size, '-h', size, '-o', join(src, iconPath(size)), svg]);
const hash = createHash('sha256').update(readFileSync(svg)).digest('hex');
writeFileSync(join(src, 'ext/icons/source.sha256'), hash + '\n');
console.log(`generated src/ext/icons/ (${ICON_SIZES.join(', ')} px)`);
