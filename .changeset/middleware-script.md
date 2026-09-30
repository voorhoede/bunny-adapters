---
"@bunny.net/astro-adapter": minor
---

Add the `script` option. `script: "middleware"` builds a middleware script for a pull zone whose origin is the storage zone: Astro's routes render in the script, and every other request goes on to the origin inside the deploy's folder, so the pull zone reads the file from the nearest storage replica. The default, `"standalone"`, builds the same script as before.
