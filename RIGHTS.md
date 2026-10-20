# Rights and license scope

The [MIT license](LICENSE), copyright 2026 batteryshark, covers this project's
owned extension source, tests and associated documentation. Retain its
copyright and permission notice with copies or substantial portions.

The included Workstack comic logo depicts an original fox courier carrying one
oversized envelope. It was AI-generated through OpenAI's native Codex image tool
from a text-only brief, with no input/reference images. The orchestrator was
`gpt-6.1-sol`; the native image model is documented as `gpt-image-2`, but actual
backend model routing was not independently trace-verified.

Artwork files:

- `assets/workstack-mark-full.png`: 1254×1254 native RGBA pixels in a
  metadata-safe PNG container. Only a nonrendering provenance payload was
  removed; image pixels and alpha were preserved, without upsampling.
- `assets/workstack-mark.png`: 320×320 alpha-aware resampled badge derived
  from that full image. It is not a separately authored Tiny32 design.

The artwork is offered under MIT to the extent applicable. No exclusive
copyright in AI-generated elements is asserted. This grant doesn't convey
rights in third-party trademarks, characters or reference material, and is
not a guarantee of trademark clearance or exclusive originality. No reference
images or third-party artwork are bundled.

This source distribution bundles no third-party runtime npm dependencies.
Node, Pi, OpenCode and separately installed software retain their own licenses
and notices. Model outputs and material sent through the extension can have
separate rights and confidentiality obligations. A message's presence in a
session doesn't grant permission to redistribute it. Credentials, operator
configuration and private session state aren't part of this distribution.
