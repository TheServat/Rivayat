/**
 * The stylesheet entry point.
 *
 * Imported once, from `main.ts`, in dependency order: the font faces, then the tokens
 * they are named in, then the baseline that consumes them, then the motion system,
 * which is last because its reduced-motion block has to override anything the
 * baseline set. A component that imports a
 * token file directly would get a second copy in the bundle and, worse, would suggest
 * that importing tokens is something a component decides.
 *
 * The font is self-hosted (`@fontsource-variable/vazirmatn`) rather than pulled from a
 * CDN: the studio has to render Persian correctly on a machine with no network, which
 * is the same machine the local ComfyUI lane runs on.
 */

import '@fontsource-variable/vazirmatn';

import './tokens.css';
import './base.css';
import './motion.css';
import './illustration.css';
