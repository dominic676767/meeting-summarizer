# Agent setup: a settings import that carries no secret, and a fixed extension ID

**Status: accepted.** This adds to ADR-0001 and changes none of it. Settings are still written only by the Options page Save, and keys still live in `storage.local`.

A coding agent can now set up the extension by following `docs/guide/installation.md` (issue #52). Two parts of that setup need the extension's help. The agent must hand the user's choices to the Options page, and Ollama must allow this extension and no other. The research is in [agent-installation-guide.md](../research/agent-installation-guide.md), sections 8.3 and 8.5.

## The settings import: a paste box that fills the form

- **The agent prepares a JSON block and puts it on the clipboard.** The user pastes it into *Import settings* at the top of the Options page. The block has a version field, `"meetingSummarizerSettings": 1`.
- **The import fills the form and stores nothing.** The user reads the values, adds the keys, and selects Save. Save stays the one write path, so the microphone consent rule (`micConsentAfterSave`) applies to an imported engine as it does to a typed one.
- **No secret and no consent, ever.** The parser refuses the whole block, by field name, if it holds an API key, AWS credentials of any form, `micCapture` or the Prompt Templates. A refused field is not dropped silently: the message says where that value is entered instead. A key must never sit on the clipboard or in a file as an "imported" value. Microphone consent is the user's own act.
- **Only what the page offers.** Every value is checked against the same lists as the form: the Providers, the Transcription Providers, the Meeting Languages, the Whisper sizes and the two summary shapes. An unknown field is refused by its path. One bad value refuses the whole block, so a half-applied import never changes the form in a way the user did not read.

Considered and rejected:

- **A file picker.** It opens a second native dialog, the same step that makes *Load unpacked* the slowest part of setup, and it leaves the file on disk.
- **Defaults built into `dist/`** from a git-ignored file. After the first Save the stored values win, so a later rebuild changes nothing and says nothing. A key put in that file by mistake would ship in plain JS.
- **Chrome managed storage.** It needs a policy, which on macOS means a configuration profile: the "extra install step" that ADR-0001 rejects.
- **Writing `storage.local` over the DevTools Protocol.** The agent would hold a write path to the storage that holds the keys.

## A fixed extension ID

- **`src/manifest.json` carries a public `key`.** Chrome derives the ID from it: the first 16 bytes of SHA-256 of the DER public key, each hex digit mapped to a letter a–p. Without a key, an unpacked extension's ID is a hash of its folder path, so it differs for every clone and changes when the folder moves.
- **The ID is `hbobmcebmpakimlijcjiaklipegdelap`.** Ollama is set to `OLLAMA_ORIGINS=chrome-extension://hbobmcebmpakimlijcjiaklipegdelap`, not `chrome-extension://*`, which would trust every installed extension. `tests/manifest-key.test.ts` checks that the key gives this ID and that the Settings page, the README and the guide name only this origin.
- **The private key is not in the repo.** An unpacked load does not need it. It is kept outside git, only to pack a `.crx` with the same ID later. Because the public key is public, another extension could copy it and get the same ID: the exact origin trusts "the extension that carries this key". That is still much narrower than every extension.
- **The ID changed once, with no migration.** An install loaded before this change had the path-based ID, and its stored Settings and held items stay with that ID. Only the maintainer had such an install, so no migration was written.

## Consequences

- `scripts/doctor.mjs` (`npm run doctor -- --ollama`) checks that Ollama allows this origin and refuses a foreign one. On macOS, `launchctl setenv` is lost at a reboot. So the doctor reports the missing value, and the setup agent sets it again.
- The Ollama note on the Settings page and in the README names the exact origin.
