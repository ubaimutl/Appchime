# Appchime

Appchime is a GNOME Shell extension that plays notification sounds. You can choose a default sound, give individual apps their own sound, or mute them.

It supports GNOME Shell 46–50. The preferences window uses GTK4 and libadwaita.

## Install

Build the extension archive:

```sh
./pack.sh
```

Install it:

```sh
gnome-extensions install --force dist/appchime@ubai.dev.shell-extension.zip
```

Log out and back in, then enable it:

```sh
gnome-extensions enable appchime@ubai.dev
```

Open preferences with `gnome-extensions prefs appchime@ubai.dev`.

## Settings

The **Sounds** page lets you select and preview the default sound. You can also choose a custom audio file, set a minimum time between sounds, respect Do Not Disturb, and decide whether Appchime should play when a notification already has a sound.

The **Applications** page lets you assign a sound or mute each app. Apps that send notifications appear in the list automatically. You can also ignore notifications whose app name or identifier contains a chosen phrase.

Custom Ogg Vorbis and WAV files play directly. Preferences attempts to convert other common audio formats to Ogg Vorbis when you select them.

## Source

The extension code is in `appchime@ubai.dev/`. The sound files are in the same folder, with licensing information in [CREDITS.md](appchime@ubai.dev/CREDITS.md).

Code: GPL-3.0-or-later. Bundled sounds: CC0 1.0.
