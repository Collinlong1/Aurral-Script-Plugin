# Scripts for Aurral

An [Aurral](https://github.com/lklynet/aurral) plugin that runs your own scripts when something happens in Aurral: an album request comes in, a requested album becomes available, a track lands in your Library, a flow finishes, and so on.

Use it to tag new albums with beets, kick off a media server scan, post to a chat service, write a log, or anything else a script can do.

> Aurral plugins are in beta, and Aurral can change how they work in any release. Check this plugin still works after you update Aurral.

## Requirements

- Aurral with plugins: a page at **Settings > Plugins**. No stable release has them yet (the latest, v2.13.0, doesn't), so use the nightly image, `ghcr.io/lklynet/aurral:nightly`, until the next release.
- Scripts that are executable files (`chmod +x`) and start with a shebang line such as `#!/bin/sh`. The Aurral Docker image includes `sh`, `bash`, `python3`, `node`, and `ffmpeg`.

## Install

1. **Mount a scripts folder** into the Aurral container. Read-only is safest, so nothing inside the container can change your scripts:

   ```yaml
   services:
     aurral:
       volumes:
         - ./scripts:/scripts:ro
   ```

2. **Install the plugin.** In **Settings > Plugins**, paste this link under **Install from a link**, select **Check**, then install:

   ```
   https://github.com/Collinlong1/Aurral-Script-Plugin
   ```

   Or copy `manifest.json` and `index.js` into `/config/plugins/scripts` and reopen **Settings > Plugins**.

3. **Set it up.** Open **Settings > Plugins > Scripts**:
   - Set **Scripts folder** to the folder as Aurral sees it, for example `/scripts`.
   - Under each event, list the scripts to run, separated by commas, for example `tag.sh, scan.py`. Leave an event blank to run nothing for it.
   - Turn the plugin on.

4. **Test it.** Select **Test**. It lists the scripts in your folder, so you can copy their names into the event fields, and flags any problems:
   - files that aren't executable yet (fix with `chmod +x`)
   - scripts you've listed that are missing, not executable, or outside the folder
   - scripts in the folder that no event uses

   To also run each listed script once with sample values, turn on **Test runs the scripts** first. The scripts then get the event `scriptTest`.

   Aurral's settings fields are plain text boxes, so the plugin can't fill them in or offer a dropdown. **Test** is the way to see what's there.

## The switches under "Adds"

The plugin's page in **Settings > Plugins** lists what the plugin adds, each with a switch:

```
Adds
  notification                 [on]
  Event
  download.finished            [on]
  Event
```

**Leave both on.**

Here, the small **Event** under each name is Aurral's label for a message it sends to the plugin when something happens. It isn't one of the six events you pick scripts for further down the page. Aurral sends this plugin two kinds of message, and the plugin turns each into the matching script setting:

| Under Adds          | Aurral sends it when                          | Runs the scripts listed under                                                  |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| `notification`      | Aurral sends any notification                 | Discover updated, Flow finished, Request made, Request available, Artist added |
| `download.finished` | Aurral adds a downloaded track to the Library | Track added                                                                    |

Turning one off stops Aurral sending that message to the plugin, so every script listed under the settings in its row stops running, with no error.

Aurral shows these switches for every plugin, so you can turn off part of a plugin that does several unrelated things. This plugin doesn't need them. To stop scripts running for one event, clear that event's script list instead.

## Events

These are the settings you list scripts under, one per event.

| Setting           | Runs when                                                     | `AURRAL_EVENT`           |
| ----------------- | ------------------------------------------------------------- | ------------------------ |
| Discover updated  | The daily Discover recommendations refresh                    | `notifyDiscoveryUpdated` |
| Flow finished     | A flow finishes its downloads                                 | `notifyFlowDone`         |
| Request made      | Someone requests an album                                     | `notifyRequestMade`      |
| Request available | A requested album is downloaded, or was already on disk       | `notifyRequestAvailable` |
| Artist added      | Someone adds an artist to the Library                         | `notifyArtistAdded`      |
| Track added       | Aurral adds a downloaded track to the Library, once per track | `notifyTrackAdded`       |

## What a script receives

Each value arrives two ways: as an environment variable, and in one JSON object on standard input (keys in brackets). A value that doesn't apply to the event is an empty string.

| Variable             | JSON key     | Value                                                                         |
| -------------------- | ------------ | ----------------------------------------------------------------------------- |
| `AURRAL_EVENT`       | `event`      | The event, from the table above                                               |
| `AURRAL_MESSAGE`     | `message`    | A ready-made sentence, for example `Album available: Hits by Band`            |
| `AURRAL_ARTIST_NAME` | `artistName` | The artist                                                                    |
| `AURRAL_ALBUM_NAME`  | `albumName`  | The album                                                                     |
| `AURRAL_ALBUM_PATH`  | `albumPath`  | The album's folder. Track added, and Request available when the folder exists |
| `AURRAL_TRACK_NAME`  | `trackName`  | The track, for Track added                                                    |
| `AURRAL_PATH`        | `path`       | The track's file, for Track added                                             |
| `AURRAL_USERNAME`    | `username`   | Who requested the album or added the artist                                   |
| `AURRAL_USER_ID`     | `userId`     | Always empty. Aurral only passes plugins the username                         |
| `AURRAL_FLOW_NAME`   | `flowName`   | The flow, for Flow finished and Discover updated                              |
| `AURRAL_FLOW_PATH`   | `flowPath`   | The flow's media path, for Flow finished                                      |

Paths are as Aurral sees them inside its container.

Besides these, a script sees only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, and `TMPDIR`, so secrets in Aurral's environment stay out of it. It starts from the scripts folder, without a shell, and takes no arguments. If a script needs fixed arguments, call it from a small wrapper script.

### Examples

Log every album that becomes available:

```sh
#!/bin/sh
echo "$(date -Is) $AURRAL_ARTIST_NAME - $AURRAL_ALBUM_NAME ($AURRAL_ALBUM_PATH)" >> /config/available.log
```

Read the JSON in Python instead:

```python
#!/usr/bin/env python3
import json, sys
event = json.load(sys.stdin)
print(f"{event['event']}: {event['message']}")
```

The scripts folder is mounted read-only in the example above, so write files somewhere else, such as `/config`.

## Success, failure, and timeouts

- A script **succeeds** when it exits with code `0` before its timeout.
- **Timeout** is 60 seconds unless you set **Timeout (seconds)**, up to 3600. When it passes, the script and every process it started are stopped.
- A **failure** is logged in Aurral's log under `plugin:scripts` with the exit code and the end of the script's output. If it fails within about 7 seconds, it also shows as the plugin's last error on its page.
- **Failed scripts aren't retried.** Aurral doesn't retry plugin events.
- Each run's **full output** is saved in the plugin's data folder (`/config/plugin-data/scripts/logs`). The last 50 are kept.
- Scripts run **in the background**, so a slow script never holds Aurral up. Several scripts for one event run at the same time.

## Security

A script runs with Aurral's permissions, so it can read and change anything Aurral can. Only admins can install and set up plugins. The plugin runs only files inside the scripts folder, and refuses any name or symlink that leads outside it. Mount the folder read-only.

## License

MIT
