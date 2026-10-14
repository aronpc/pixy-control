# PIXY Control

**English** · [Português](README.pt-BR.md)

Linux app to control the **EMEET PIXY** AI webcam: privacy mode, AI tracking, gestures and audio modes, a PTZ joystick, a tray icon with global shortcuts, and an always-on virtual camera with background blur for Teams, Meet, Zoom, OBS and friends.

> The interface is in Brazilian Portuguese for now. Translations are welcome.

![PIXY Control: preview, PTZ joystick and camera controls](docs/screenshots/pixy-control-camera.png)

| Image | Virtual camera | App |
| --- | --- | --- |
| ![Resolution, FPS and image controls](docs/screenshots/pixy-control-imagem.png) | ![Virtual camera with background blur](docs/screenshots/pixy-control-virtual.png) | ![Start with the system and global shortcuts](docs/screenshots/pixy-control-app.png) |

## Supported cameras

Cameras tested with the app. **Other webcams work in basic mode**: pick the camera in the **Câmera** tab (button "Usar") and the app uses the standard UVC/V4L2 controls: image settings, zoom and pan/tilt when the camera has them, preview, resolution and FPS, and the blurred virtual camera. Features that need the vendor controls (mode, privacy, tracking, gestures, audio) are disabled in the UI, with the reason. Preferences, resolution and FPS are saved per camera.

| Camera | USB | Firmware | Tested on | What works |
| --- | --- | --- | --- | --- |
| EMEET PIXY | `328f:00c0` | 20.04 | 2026-10-14 | PTZ joystick, tracking and target, privacy, gestures, mirroring and auto-rotate, audio mode, image (V4L2), modes up to 4K30 and 1080p60, virtual camera with background blur |

Tested another model or firmware? Open an issue with the [**Camera report**](https://github.com/aronpc/pixy-control/issues/new?template=camera-report.yml) form, with the model, USB ID and firmware shown in the **Câmera** tab, and what worked. The list lives in [`src/cameras.json`](src/cameras.json).

## Install

Download the [latest release](https://github.com/aronpc/pixy-control/releases/latest):

- **AppImage** (recommended): updates itself. After downloading, run the system setup once (below).
  ```sh
  chmod +x pixy-control-*.AppImage && ./pixy-control-*.AppImage
  ```
- **.deb** (Debian/Ubuntu): also installs the camera access rule. It does not update itself; the app tells you when a new version is out.
  ```sh
  sudo apt install ./pixy-control-*.deb
  ```

### System setup (once)

The app needs three things from the system. A diagnostics bar at the top of the window says what is missing and the command to fix it; the script below does everything at once.

1. **Access to the camera HID** (privacy, tracking, gestures, PTZ): a udev rule, since only root can use it by default.
2. **v4l2loopback** with an "EMEET PIXY (virtual)" device: that is the virtual camera.
3. **A WirePlumber rule**: on Ubuntu 24.04 (PipeWire 1.0 + xdg-desktop-portal 1.18) the portal does not grant cameras to non-Flatpak apps, and the preview would report no camera.

```sh
sudo apt install v4l2loopback-dkms      # if you don't have it yet
sudo ~/.config/pixy-control/system/setup/pixy-control-setup   # the app copies the script here on start
systemctl --user restart wireplumber
```

Already have another v4l2loopback configuration? Add a device with `card_label="EMEET PIXY (virtual)"` and `exclusive_caps=1` to it, for example:

```
options v4l2loopback devices=2 video_nr=10,11 card_label="Other,EMEET PIXY (virtual)" exclusive_caps=1,1
```

`exclusive_caps=1` is required: with `0` the device advertises output alongside capture, and Chrome, Edge (Teams, Meet), Zoom and others ignore it.

Dependencies: `python3`, `ffmpeg`, `pipewire-bin` (`pw-dump`, `pw-cli`), `gstreamer1.0-tools` and `gstreamer1.0-pipewire`, and GNOME for global shortcuts.

## Features

- **Camera mode**: Standard, Tracking and Privacy, from the buttons, the tray or a global shortcut. Privacy toggles: turning it off goes back to the previous mode.
- **PTZ**: joystick with proportional speed, keyboard, clickable position map and 4 presets.
- **180° image rotation** (camera mounted upside down), mirroring and automatic correction from the camera's sensor.
- **Multiple cameras**: choose which one to use; unsupported ones run in basic mode with unavailable controls disabled.
- **Virtual camera** "EMEET PIXY (virtual)": always on while the app runs (tray included). "Fundo desfocado" (background blur) toggles the effect live, so apps using the virtual camera never lose it.
- **Image in privacy mode**: with the camera in privacy mode, the virtual camera shows your own image (or a "Câmera em pausa" card) instead of the black frame from the retracted lens. When leaving privacy, the image can stay a few more seconds (2 s by default, configurable) while the lens rises and exposure settles. Only for the virtual camera; apps using the camera directly still get black.
- **Video**: resolution and FPS among the modes the camera offers (up to 4K30 and 1080p60). With blur, the output is capped at 1920×1080.
- **Preview** of the camera or the virtual camera, without locking the camera for other apps (via PipeWire).
- **Image**: brightness, contrast, focus, exposure, white balance, anti-flicker and every other control the camera exposes.
- **Global shortcuts** configurable in the app, with conflict detection against GNOME shortcuts.
- **Everything is saved** and restored: camera settings are reapplied when the app starts and whenever the camera reappears (it forgets or restores old values on reset).
- **Start with the system**, straight to the tray.
- **Diagnostics** on start: if something is missing, a bar says what, what it affects and the command to fix it.
- **Auto-update** for the AppImage, from GitHub releases.

Settings are organized in tabs: **Câmera** (connected cameras and vendor controls), **Imagem** (resolution, FPS and image settings), **Virtual** (virtual camera, blur and privacy image) and **App** (start with the system and shortcuts).

### Controls

| Action | Mouse | Keyboard |
| --- | --- | --- |
| Continuous pan/tilt | drag the joystick | arrows or WASD; `Shift` = fast |
| Zoom | mouse wheel over the joystick, slider | `Q`/`E` or `-`/`+` |
| Point directly | click the map | — |
| Center | button | `C` or `Home` |
| Presets 1–4 | click = go, right click = save | `1`–`4` go, `Shift`+`1`–`4` save |
| Tracking / Privacy | top buttons | `T` / `P` |
| Stop moving | — | `Space` |
| From anywhere | tray menu | global shortcuts (default `Ctrl+Alt+Shift+P` / `T`) |

Closing the window only hides it in the tray; quit from the tray menu.

## Known issues

- **Preview or virtual camera with no image**: another program opened the camera directly (not through PipeWire). The app says which one and recovers by itself once it is released.
- **PIXY zoom at 1920×1080 60 fps**: the camera ignores zoom in this mode (firmware limitation). The app disables zoom there and suggests 30 fps or 1280×720 at 60.
- **FPS lower than the mode's maximum** (e.g. 1080p at 30): Chromium would open the camera at the maximum rate and drop frames, so the app pins the exact mode first with a minimal GStreamer consumer (`gstreamer1.0-tools` and `gstreamer1.0-pipewire`). Without GStreamer the camera stays at the maximum rate.
- **FPS below the chosen value**: in low light the camera itself lengthens exposure and lowers the rate. At 4K the blur runs close to 20 fps.
- **"Idle" mode**: with no app using the video, the PIXY ignores tracking requests and always wakes up in standard. The app remembers the chosen mode and reapplies it when video opens.
- **Black image on the virtual camera**: the camera is in privacy mode.
- **Virtual camera missing in apps that use the camera through PipeWire** (Chrome/Edge with the PipeWire camera flag, OBS PipeWire source): PipeWire registers the v4l2loopback when the module loads, before the app writes to it, and with `exclusive_caps=1` it only advertises capture afterwards. Use those apps in the regular V4L2 mode (the default for Teams, Meet, Zoom and OBS), which sees the virtual camera.
- Tilt ranges from −52° to 90°; below that the camera just points at its own base.
- Moving the joystick while tracking switches to Standard, otherwise tracking would fight your hand.

App errors are logged to `~/.config/pixy-control/pixy-control.log`.

## How it works

- **`helper/pixyd.py`** (Python, standard library only) is a long-running process speaking line-delimited JSON with Electron. It uses V4L2 through `ioctl` directly and the vendor HID (`/dev/hidrawN`, 32-byte report `0x09`). It refuses the power, firmware and SD HID groups and the factory-reset and identity commands.
- **PTZ**: standard UVC controls; the joystick sets the axis limit as the motor target and adjusts speed over HID. With no command for 0.4 s, the helper stops the camera by itself.
- **Preview and virtual camera** open the camera through PipeWire (portal), requesting the exact native mode (`resizeMode: "none"`), and share it with other PipeWire clients. Whoever opens the camera first sets the format for everyone.
- **Virtual camera**: a hidden window reads frames with `MediaStreamTrackProcessor`, segments the person with MediaPipe's selfie segmenter (every other frame) and blurs the background; the frame is converted to I420 in a WebGL shader, read back asynchronously and sent to an `ffmpeg` that writes to the v4l2loopback. While writing, the app keeps `$XDG_RUNTIME_DIR/pixy-control-virtual.json` (device and PID) so other programs know there is an image.
- **Global shortcuts** are GNOME custom shortcuts that run `pixy-toggle`, which talks to the app over `$XDG_RUNTIME_DIR/pixy-control.sock`. Electron's `globalShortcut` does not work on X11 when the active keyboard layout is not the first in the list.
- **Security**: `contextIsolation`, `sandbox`, CSP, IPC accepted only from the app's own pages, navigation and new windows blocked, camera permission only for the app's pages, fuses (`RunAsNode` and friends off, app loaded only from the asar).

## Development

```sh
npm install
npm start            # or: npm start -- --hidden (straight to the tray)
npm run lint
npm test             # JS tests (node:test) and helper tests (unittest), no camera needed
npm run dist         # AppImage and .deb in release/
```

### Releasing

```sh
npm version patch    # or minor/major: bumps package.json, commits and tags vX.Y.Z
git push --follow-tags
```

GitHub Actions runs lint and tests, builds the AppImage and the `.deb` and publishes the release. Installed AppImages pick up the new version by themselves.

## Credits

The HID protocol comes from community reverse engineering and was verified on this camera (firmware 20.04):
[PixyDeck](https://github.com/dalu951/pixydeck), [emeet-pixyd](https://github.com/LarsArtmann/emeet-pixyd),
[Pixy Arch](https://github.com/Dkrynen/pixy-arch) and [branzo's gist](https://gist.github.com/branzo/de238cfe001fa4a834ca21ac43dca580).
Person segmentation: [MediaPipe](https://github.com/google-ai-edge/mediapipe) (selfie segmenter, Apache-2.0).

## License

[MIT](LICENSE)
