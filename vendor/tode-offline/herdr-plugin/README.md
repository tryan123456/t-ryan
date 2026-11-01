# terminal-code herdr plugin
VS Code inside your terminal



<video src="https://github.com/user-attachments/assets/4ba0d434-896a-4ab3-9c91-5d351dacee08" controls></video>

### Install (macOS & Linux)

Upstream's one-liner is `herdr plugin install zenbu-labs/terminal-code/herdr-plugin`,
which clones from GitHub and then curls the installer — both need network.
This is the offline copy; from the bundle root, one directory up:

```bash
./install-offline.sh --link-plugin
```

or the two steps separately:

```bash
./install-offline.sh                    # tode + code-server, from artifacts/
herdr plugin link "$PWD/herdr-plugin"   # the plugin; absolute path required
```

See `../README.md` for the whole procedure.
### Herdr actions 
#### `open-split`

Open terminal-code in a split to the right of your focused pane.

### Usage
```
tode # opens the folder in the current working directory
tode <folder> # opens the specified folder
tode <file> # opens the specified file
tode --split right # opens the editor in a split pane to the right
```
