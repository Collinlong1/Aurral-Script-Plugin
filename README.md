# Run scripts

An Aurral plugin that runs your own executables when Aurral sends a notification or files a downloaded track. It replaces the built-in custom scripts (`AURRAL_SCRIPTS_DIR`) from the Collinlong1/aurral fork, using only Aurral's plugin API.

## Install

1. Mount your scripts folder into the container, read-only:

   ```yaml
   services:
     aurral:
       volumes:
         - ./scripts:/scripts:ro
   ```

2. In **Settings > Plugins**, paste `https://github.com/Collinlong1/Aurral-Script-Plugin` under **Install from a link** and select **Check**, then install. Or copy this repo's `manifest.json` and `index.js` to `/config/plugins/run-scripts` (the `plugins` folder of Aurral's data folder).
3. Open **Settings > Plugins > Run scripts**, set **Scripts folder** to `/scripts`, list script file names under each event, and turn the plugin on.
4. Select **Test**. It checks that every listed script exists and is executable. Turn on **Test runs the scripts** to also run each one with the event `scriptTest`.

## What a script receives

The same as the old built-in scripts: `AURRAL_EVENT`, `AURRAL_MESSAGE`, `AURRAL_ALBUM_NAME`, `AURRAL_ARTIST_NAME`, `AURRAL_ALBUM_PATH`, `AURRAL_TRACK_NAME`, `AURRAL_PATH`, `AURRAL_USERNAME`, `AURRAL_USER_ID`, `AURRAL_FLOW_NAME`, and `AURRAL_FLOW_PATH` as environment variables, and the same values as one JSON object on standard input. A script sees only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, and `TMPDIR` from the environment besides these. It starts without a shell, from the scripts folder, and only files inside that folder run, including after symlinks are followed.

| Setting           | `AURRAL_EVENT`           | Values                                                                 |
| ----------------- | ------------------------ | ---------------------------------------------------------------------- |
| Discover updated  | `notifyDiscoveryUpdated` | message, flow name                                                     |
| Flow finished     | `notifyFlowDone`         | message with counts, flow name and path                                |
| Request made      | `notifyRequestMade`      | album, artist, username                                                |
| Request available | `notifyRequestAvailable` | album, artist, username, and the album's Library folder when it exists |
| Artist added      | `notifyArtistAdded`      | artist, username                                                       |
| Track added       | `notifyTrackAdded`       | track, artist, album, file path, album folder                          |

## Differences from the built-in scripts

- **No retries.** Upstream doesn't retry plugin events. A failed script is logged once under `plugin:run-scripts`, and a failure within the first 7 seconds also shows as the plugin's last error.
- **No per-script arguments.** Put fixed arguments in a small wrapper script.
- **`AURRAL_USER_ID` is always empty**, because plugin events carry only the username.
- **Flow finished** is `notifyFlowDone`, upstream's current name, not `notifyWeeklyFlowDone`.
- **Output** goes to a log file per run in the plugin's data folder (the last 50 are kept), and its end goes to the Aurral log when the script finishes.
- **Timeout** (default 60 seconds, up to 3600) is enforced with coreutils `timeout`, which the Aurral image includes, so it holds after Aurral stops the idle plugin process. It stops the script and everything it started.
