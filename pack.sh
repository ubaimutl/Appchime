#!/bin/bash
# Pack Appchime into a zip for extensions.gnome.org.
# Sound files are added via --extra-source: gnome-extensions pack only
# bundles known file types automatically, and extra sources land at the
# top level of the zip (which is why the .oga files live in the
# extension root, not in a sounds/ subdirectory).
set -e
cd "$(dirname "$0")"

# Never ship a stale compiled schema.
rm -f "appchime@ubai.dev/schemas/gschemas.compiled"

mkdir -p dist
gnome-extensions pack "appchime@ubai.dev" --out-dir=dist --force \
    --extra-source=chime.oga \
    --extra-source=mail-swoosh.oga \
    --extra-source=message-chime.oga \
    --extra-source=glass-ping.oga \
    --extra-source=soft-bell.oga \
    --extra-source=marimba.oga \
    --extra-source=pop.oga \
    --extra-source=CREDITS.md

echo "--- zip contents: ---"
python3 -c "import zipfile,glob; z=zipfile.ZipFile(glob.glob('dist/*.zip')[0]); [print(f.filename, f.file_size) for f in z.infolist()]"
