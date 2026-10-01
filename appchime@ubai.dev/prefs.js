// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gst from 'gi://Gst';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BUNDLED_SOUNDS = [
    {id: 'chime', name: 'Warm Chime', file: 'chime.oga'},
    {id: 'mail-swoosh', name: 'Mail Swoosh', file: 'mail-swoosh.oga'},
    {id: 'message-chime', name: 'Message Chime', file: 'message-chime.oga'},
    {id: 'glass-ping', name: 'Glass Ping', file: 'glass-ping.oga'},
    {id: 'soft-bell', name: 'Soft Bell', file: 'soft-bell.oga'},
    {id: 'marimba', name: 'Gentle Marimba', file: 'marimba.oga'},
    {id: 'pop', name: 'Soft Pop', file: 'pop.oga'},
];

const RULE_DEFAULT = 'default';
const RULE_CUSTOM = 'custom';
const RULE_MUTE = 'mute';

function parseJsonObject(text) {
    try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value))
            return value;
    } catch {
        return {};
    }
    return {};
}

export default class AppchimePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._previews = [];
        this._previewPipeline = null;
        this._activeConverts = new Map();
        this._closed = false;
        try {
            Gst.init(null);
        } catch (e) {
            this._log(`Gst unavailable, mp3 preview disabled: ${e.message}`);
        }
        window.connect('close-request', () => {
            this._closed = true;
            this._stopPreviewPipeline();
            this._previews = [];
            this._appRows = [];
            this._appList = null;
            this._defaultFileRow = null;
            this._ignoreList = null;
            this._ignoreEntry = null;
        });
        window.set_default_size(680, 700);
        window.search_enabled = false;

        window.add(this._buildSoundsPage());
        window.add(this._buildAppsPage());
    }

    _log(message) {
        const settings = this._settings;
        if (!settings)
            return;
        const schema = settings.settings_schema;
        if (schema && schema.has_key('debug') &&
                settings.get_boolean('debug')) {
            console.log(`[Appchime] ${message}`);
        }
    }

    _buildSoundsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Sounds',
            icon_name: 'multimedia-volume-control-symbolic',
        });

        const defaultGroup = new Adw.PreferencesGroup({
            title: 'Default Sound',
            description: 'Played for every notification that has no per-app rule.',
        });

        const names = BUNDLED_SOUNDS.map(s => s.name);
        names.push('Custom audio file');
        const combo = new Adw.ComboRow({
            title: 'Sound',
            model: new Gtk.StringList({strings: names}),
        });
        combo.set_selected(this._defaultSoundIndex());
        combo.connect('notify::selected', () => {
            const i = combo.get_selected();
            if (i < BUNDLED_SOUNDS.length)
                this._settings.set_string('default-sound', BUNDLED_SOUNDS[i].id);
            else
                this._settings.set_string('default-sound', RULE_CUSTOM);
            this._refreshDefaultFileRow();
        });
        defaultGroup.add(combo);

        this._defaultFileRow = new Adw.ActionRow({
            title: 'Custom audio file',
            activatable: true,
        });
        this._defaultFileRow.connect('activated', () => this._chooseFile(file => {
            if (file)
                this._adoptDefaultFile(file);
        }));
        const chooseButton = new Gtk.Button({
            label: 'Choose…',
            valign: Gtk.Align.CENTER,
        });
        chooseButton.connect('clicked', () => this._chooseFile(file => {
            if (file)
                this._adoptDefaultFile(file);
        }));
        this._defaultFileRow.add_suffix(chooseButton);
        defaultGroup.add(this._defaultFileRow);
        this._settings.connect('changed::default-sound',
            () => this._refreshDefaultFileRow());
        this._settings.connect('changed::default-custom-file',
            () => this._refreshDefaultFileRow());
        this._refreshDefaultFileRow();

        const previewRow = new Adw.ActionRow({title: 'Preview default sound'});
        const previewButton = new Gtk.Button({
            icon_name: 'media-playback-start-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Play',
        });
        previewButton.connect('clicked', () => this._previewDefault());
        previewRow.add_suffix(previewButton);
        defaultGroup.add(previewRow);
        page.add(defaultGroup);

        const optionsGroup = new Adw.PreferencesGroup({
            title: 'Options',
        });

        const rateRow = new Adw.SpinRow({
            title: 'Minimum time between sounds',
            subtitle: 'Notifications arriving faster than this stay silent.',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 10000, step_increment: 100, page_increment: 500,
            }),
        });
        rateRow.set_value(this._settings.get_int('rate-limit-ms'));
        rateRow.connect('notify::value', () => {
            this._settings.set_int('rate-limit-ms', Math.round(rateRow.get_value()));
        });
        const msLabel = new Gtk.Label({label: 'ms'});
        rateRow.add_suffix(msLabel);
        optionsGroup.add(rateRow);

        const dndRow = new Adw.SwitchRow({
            title: 'Respect Do Not Disturb',
            subtitle: 'Stay silent while banners are disabled system-wide.',
        });
        dndRow.set_active(this._settings.get_boolean('respect-dnd'));
        dndRow.connect('notify::active', () => {
            this._settings.set_boolean('respect-dnd', dndRow.get_active());
        });
        optionsGroup.add(dndRow);

        const hintRow = new Adw.SwitchRow({
            title: 'Play even when the notification has its own sound',
            subtitle: 'Off by default, so the sound is not played twice.',
        });
        hintRow.set_active(this._settings.get_boolean('play-with-hint'));
        hintRow.connect('notify::active', () => {
            this._settings.set_boolean('play-with-hint', hintRow.get_active());
        });
        optionsGroup.add(hintRow);

        const volumeRow = new Adw.ActionRow({
            title: 'Master volume',
            subtitle: 'Not available: the shell sound player offers no volume ' +
                'control. Sounds follow the system alert volume in Settings → Sound.',
        });
        volumeRow.add_suffix(new Gtk.Image({
            icon_name: 'dialog-information-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        optionsGroup.add(volumeRow);
        page.add(optionsGroup);

        return page;
    }

    _defaultSoundIndex() {
        const spec = this._settings.get_string('default-sound');
        if (spec === RULE_CUSTOM)
            return BUNDLED_SOUNDS.length;
        const i = BUNDLED_SOUNDS.findIndex(s => s.id === spec);
        return i >= 0 ? i : 0;
    }

    _adoptDefaultFile(chosen) {
        const previous = this._settings.get_string('default-custom-file');
        this._settings.set_string('default-custom-file', chosen);
        this._refreshDefaultFileRow();
        this._adoptCustomFile(chosen, final => {
            if (final === chosen || this._closed)
                return;
            if (this._settings.get_string('default-custom-file') !== chosen)
                return;
            this._settings.set_string('default-custom-file', final);
            if (previous !== final)
                this._discardConverted(previous);
            this._refreshDefaultFileRow();
        });
    }

    _refreshDefaultFileRow() {
        const isCustom = this._settings.get_string('default-sound') === RULE_CUSTOM;
        const file = this._settings.get_string('default-custom-file');
        if (!file) {
            this._defaultFileRow.set_subtitle('No file chosen');
        } else {
            let sub = GLib.filename_display_basename(file);
            if (!this._isRuntimePlayable(file))
                sub += ' — not directly playable in notifications (auto-convert attempted; else convert to Ogg Vorbis, see README)';
            this._defaultFileRow.set_subtitle(sub);
        }
        this._defaultFileRow.set_visible(isCustom);
    }

    _previewDefault() {
        const file = this._resolveFile(
            this._settings.get_string('default-sound'),
            this._settings.get_string('default-custom-file'));
        if (file)
            this._previewFile(file);
    }

    _buildAppsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Applications',
            icon_name: 'application-x-executable-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Per-App Sounds',
            description: 'Pick a sound, a custom file, or mute for each app. ' +
                'Apps that have sent notifications appear here automatically.',
        });

        const search = new Gtk.SearchEntry({
            placeholder_text: 'Search applications…',
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });
        search.set_width_chars(24);
        group.set_header_suffix(search);

        this._appRows = [];
        for (const app of this._collectApps())
            this._appRows.push(this._buildAppRow(app));

        this._appList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        for (const row of this._appRows)
            this._appList.append(row.widget);

        search.connect('search-changed', () => this._applyAppFilter(search));
        search.connect('changed', () => this._applyAppFilter(search));

        group.add(this._appList);
        page.add(group);
        page.add(this._buildIgnoredGroup());
        return page;
    }

    _buildIgnoredGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Ignored Notifications',
            description: 'Notifications whose app identifier or title ' +
                'contains any of these texts stay silent. Example: suspend.',
        });

        this._ignoreList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        group.add(this._ignoreList);

        const addRow = new Adw.ActionRow({title: 'Ignore matching notifications'});
        this._ignoreEntry = new Gtk.Entry({
            placeholder_text: 'e.g. suspend',
            valign: Gtk.Align.CENTER,
            hexpand: true,
            width_chars: 18,
        });
        const addButton = new Gtk.Button({
            label: 'Add',
            valign: Gtk.Align.CENTER,
        });
        const addPattern = () => {
            const pattern = this._ignoreEntry.get_text().trim();
            if (!pattern)
                return;
            const patterns = this._settings.get_strv('ignore-patterns');
            if (!patterns.includes(pattern)) {
                patterns.push(pattern);
                this._settings.set_strv('ignore-patterns', patterns);
            }
            this._ignoreEntry.set_text('');
        };
        addButton.connect('clicked', addPattern);
        this._ignoreEntry.connect('activate', addPattern);
        addRow.add_suffix(this._ignoreEntry);
        addRow.add_suffix(addButton);
        group.add(addRow);

        this._settings.connect('changed::ignore-patterns',
            () => this._refreshIgnoreList());
        this._refreshIgnoreList();
        return group;
    }

    _refreshIgnoreList() {
        let child = this._ignoreList.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._ignoreList.remove(child);
            child = next;
        }
        for (const pattern of this._settings.get_strv('ignore-patterns')) {
            const row = new Adw.ActionRow({title: pattern});
            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Remove',
            });
            removeButton.connect('clicked', () => {
                this._settings.set_strv('ignore-patterns',
                    this._settings.get_strv('ignore-patterns').filter(p => p !== pattern));
            });
            row.add_suffix(removeButton);
            this._ignoreList.append(row);
        }
    }

    _applyAppFilter(search) {
        const query = search.get_text().toLowerCase().trim();
        for (const row of this._appRows) {
            row.widget.set_visible(!query ||
                row.searchText.includes(query));
        }
    }

    _collectApps() {
        const byId = new Map();
        for (const info of Gio.AppInfo.get_all()) {
            if (!info.should_show())
                continue;
            const id = info.get_id();
            const name = info.get_display_name();
            if (!id || !name)
                continue;
            byId.set(id, {
                id, name,
                icon: info.get_icon(),
                seenOnly: false,
            });
        }

        const seen = parseJsonObject(this._settings.get_string('seen-apps'));
        for (const [id, name] of Object.entries(seen)) {
            if (!byId.has(id)) {
                byId.set(id, {
                    id,
                    name: typeof name === 'string' && name ? name : id,
                    icon: null,
                    seenOnly: true,
                });
            }
        }

        return [...byId.values()].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
    }

    _ruleFor(appId) {
        const rules = parseJsonObject(this._settings.get_string('app-rules'));
        const rule = rules[appId];
        if (rule && typeof rule === 'object' && typeof rule.sound === 'string')
            return rule;
        return {sound: RULE_DEFAULT, file: ''};
    }

    _saveRule(appId, rule) {
        const rules = parseJsonObject(this._settings.get_string('app-rules'));
        if (rule.sound === RULE_DEFAULT)
            delete rules[appId];
        else
            rules[appId] = {sound: rule.sound, file: rule.file || ''};
        this._settings.set_string('app-rules', JSON.stringify(rules));
    }

    _buildAppRow(app) {
        const row = new Adw.ActionRow({
            title: app.name,
            activatable: false,
        });
        if (app.icon) {
            row.add_prefix(new Gtk.Image({
                gicon: app.icon,
                pixel_size: 32,
                valign: Gtk.Align.CENTER,
            }));
        }

        const options = ['Use default',
            ...BUNDLED_SOUNDS.map(s => s.name),
            'Custom file…', 'Mute this app'];
        const drop = new Gtk.DropDown({
            model: new Gtk.StringList({strings: options}),
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Sound for this app',
        });

        const fileButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Choose audio file…',
        });
        const previewButton = new Gtk.Button({
            icon_name: 'media-playback-start-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Preview',
        });

        const updateSubtitle = rule => {
            let detail;
            if (rule.sound === RULE_DEFAULT)
                detail = 'Default';
            else if (rule.sound === RULE_MUTE)
                detail = 'Muted';
            else if (rule.sound === RULE_CUSTOM) {
                detail = rule.file ? GLib.filename_display_basename(rule.file) : 'Custom (no file)';
                if (rule.file && !this._isRuntimePlayable(rule.file))
                    detail += ' — not directly playable (auto-convert attempted, see README)';
            } else {
                detail = this._bundledName(rule.sound);
            }
            const seen = app.seenOnly ? ' · seen in notifications' : '';
            row.set_subtitle(`${app.id} · ${detail}${seen}`);
        };

        const syncFromSettings = () => {
            const rule = this._ruleFor(app.id);
            drop.set_selected(this._ruleToIndex(rule.sound));
            fileButton.set_visible(rule.sound === RULE_CUSTOM);
            updateSubtitle(rule);
        };

        drop.connect('notify::selected', () => {
            const rule = this._ruleFor(app.id);
            const oldFile = rule.sound === RULE_CUSTOM ? rule.file : null;
            rule.sound = this._indexToRule(drop.get_selected());
            if (rule.sound !== RULE_CUSTOM) {
                rule.file = '';
                this._discardConverted(oldFile);
            }
            this._saveRule(app.id, rule);
            fileButton.set_visible(rule.sound === RULE_CUSTOM);
            updateSubtitle(rule);
        });

        fileButton.connect('clicked', () => this._chooseFile(chosen => {
            if (!chosen)
                return;
            const rule = this._ruleFor(app.id);
            const previous = rule.file;
            rule.sound = RULE_CUSTOM;
            rule.file = chosen;
            this._saveRule(app.id, rule);
            updateSubtitle(rule);
            this._adoptCustomFile(chosen, final => {
                if (final === chosen || this._closed)
                    return;
                const current = this._ruleFor(app.id);
                if (current.sound !== RULE_CUSTOM || current.file !== chosen)
                    return;
                current.file = final;
                this._saveRule(app.id, current);
                if (previous !== final)
                    this._discardConverted(previous);
                updateSubtitle(current);
            });
        }));

        previewButton.connect('clicked', () => {
            const rule = this._ruleFor(app.id);
            let file;
            if (rule.sound === RULE_DEFAULT) {
                file = this._resolveFile(
                    this._settings.get_string('default-sound'),
                    this._settings.get_string('default-custom-file'));
            } else if (rule.sound === RULE_MUTE) {
                return;
            } else {
                file = this._resolveFile(rule.sound, rule.file);
            }
            if (file)
                this._previewFile(file);
        });

        row.add_suffix(drop);
        row.add_suffix(fileButton);
        row.add_suffix(previewButton);
        syncFromSettings();

        return {
            widget: row,
            searchText: `${app.name} ${app.id}`.toLowerCase(),
        };
    }

    _ruleToIndex(sound) {
        if (sound === RULE_CUSTOM)
            return BUNDLED_SOUNDS.length + 1;
        if (sound === RULE_MUTE)
            return BUNDLED_SOUNDS.length + 2;
        const i = BUNDLED_SOUNDS.findIndex(s => s.id === sound);
        return i >= 0 ? i + 1 : 0;
    }

    _indexToRule(index) {
        if (index === 0)
            return RULE_DEFAULT;
        if (index === BUNDLED_SOUNDS.length + 1)
            return RULE_CUSTOM;
        if (index === BUNDLED_SOUNDS.length + 2)
            return RULE_MUTE;
        return BUNDLED_SOUNDS[index - 1].id;
    }

    _bundledName(id) {
        const found = BUNDLED_SOUNDS.find(s => s.id === id);
        return found ? found.name : id;
    }

    _resolveFile(spec, customFile) {
        if (spec === RULE_MUTE)
            return null;
        if (spec === RULE_CUSTOM) {
            const file = this._customFileToGioFile(customFile);
            if (file && file.query_exists(null))
                return file;
            spec = 'chime';
        }
        const bundled = BUNDLED_SOUNDS.find(s => s.id === spec) || BUNDLED_SOUNDS[0];
        return Gio.File.new_for_path(
            GLib.build_filenamev([this.path, bundled.file]));
    }

    _customFileToGioFile(spec) {
        if (!spec)
            return null;
        if (spec.startsWith('file://'))
            return Gio.File.new_for_uri(spec);
        if (spec.startsWith('/'))
            return Gio.File.new_for_path(spec);
        return null;
    }

    _isRuntimePlayable(spec) {
        const file = this._customFileToGioFile(spec);
        if (!file)
            return false;
        if (file.query_exists(null)) {
            const info = file.query_info('standard::content-type',
                Gio.FileQueryInfoFlags.NONE, null);
            if (new Set(['audio/ogg', 'application/ogg', 'audio/x-vorbis',
                'audio/x-wav', 'audio/wav', 'audio/vnd.wave',
                'audio/x-pn-wav']).has(info.get_content_type())) {
                return true;
            }
        }
        const name = (file.get_basename() || '').toLowerCase();
        return name.endsWith('.oga') || name.endsWith('.ogg') || name.endsWith('.wav');
    }

    _chooseFile(onChosen) {
        const dialog = new Gtk.FileDialog({
            title: 'Choose audio file',
            modal: true,
        });
        dialog.open(null, null, (_dlg, result) => {
            let chosen = null;
            try {
                const file = dialog.open_finish(result);
                chosen = file.get_path() || file.get_uri();
            } catch (e) {
                if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    throw e;
            }
            onChosen(chosen);
        });
    }

    _adoptCustomFile(srcPath, onDone) {
        const src = this._customFileToGioFile(srcPath);
        if (!src || this._isRuntimePlayable(srcPath)) {
            onDone(srcPath);
            return;
        }
        const target = this._convertedTargetFor(src);
        if (!target) {
            onDone(srcPath);
            return;
        }
        let contentType = null;
        if (src.query_exists(null)) {
            contentType = src.query_info('standard::content-type',
                Gio.FileQueryInfoFlags.NONE, null).get_content_type();
        }
        const branch = this._transcodeBranch(contentType);
        if (!branch || this._runTranscode(src, target, branch,
            () => onDone(target.get_path()))) {
            onDone(this._targetIsFresh(src, target) ? target.get_path() : srcPath);
        }
    }

    // Use explicit MP3 elements to avoid decodebin3 failures on some systems.
    _transcodeBranch(contentType) {
        const registry = Gst.Registry.get();
        const has = name => !!registry.lookup_feature(name);
        if (!has('vorbisenc') || !has('oggmux') || !has('audioconvert') ||
                !has('audioresample')) {
            return null;
        }
        if (contentType === 'audio/mpeg' && has('mpegaudioparse') && has('mpg123audiodec'))
            return 'mpegaudioparse ! mpg123audiodec';
        if ((contentType === 'audio/x-flac' || contentType === 'audio/flac') &&
                has('flacparse') && has('flacdec')) {
            return 'flacparse ! flacdec';
        }
        if ((contentType === 'audio/ogg' || contentType === 'application/ogg' ||
                contentType === 'audio/opus' || contentType === 'audio/x-opus') &&
                has('oggdemux') && has('opusdec')) {
            return 'oggdemux ! opusdec';
        }
        if ((contentType === 'audio/mp4' || contentType === 'audio/x-m4a' ||
                contentType === 'audio/aac' || contentType === 'audio/x-aac') &&
                has('qtdemux') && (has('avdec_aac') || has('faad'))) {
            return `qtdemux ! ${has('avdec_aac') ? 'avdec_aac' : 'faad'}`;
        }
        return null;
    }

    _convertedTargetFor(srcFile) {
        const local = srcFile.get_path();
        if (!local)
            return null;
        const digest = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA1, srcFile.get_uri(), -1);
        return Gio.File.new_for_path(GLib.build_filenamev(
            [this.path, 'converted', `custom-${digest}.oga`]));
    }

    _convertedDir() {
        return Gio.File.new_for_path(
            GLib.build_filenamev([this.path, 'converted']));
    }

    _targetIsFresh(srcFile, targetFile) {
        if (!targetFile.query_exists(null) || !srcFile.query_exists(null))
            return false;
        const srcTime = srcFile.query_info('time::modified',
            Gio.FileQueryInfoFlags.NONE, null).get_modification_date_time();
        const targetTime = targetFile.query_info('time::modified',
            Gio.FileQueryInfoFlags.NONE, null).get_modification_date_time();
        return targetTime.compare(srcTime) >= 0;
    }

    // Only delete files in the extension's converted directory.
    _discardConverted(path) {
        if (!path)
            return;
        const file = path.startsWith('file://')
            ? Gio.File.new_for_uri(path)
            : Gio.File.new_for_path(path);
        const filePath = file.get_path();
        const dirPath = this._convertedDir().get_path();
        if (!filePath || !filePath.startsWith(`${dirPath}/`))
            return;
        if (file.query_exists(null))
            file.delete(null);
    }

    // Share in-progress conversions for the same target.
    _runTranscode(src, target, branch, onFinish) {
        if (this._targetIsFresh(src, target))
            return true;
        if (!this._activeConverts)
            this._activeConverts = new Map();
        const key = target.get_uri();
        let waiting = this._activeConverts.get(key);
        if (!waiting) {
            waiting = [];
            this._activeConverts.set(key, waiting);
            this._startTranscode(src, target, branch, key);
        }
        waiting.push(onFinish);
        return false;
    }

    _startTranscode(src, target, branch, key) {
        const part = Gio.File.new_for_path(`${target.get_path()}.part`);
        const done = ok => this._doneTranscode(key, part, target, ok);
        const dir = this._convertedDir();
        if (!dir.query_exists(null)) {
            try {
                dir.make_directory_with_parents(null);
            } catch (e) {
                console.error(`[Appchime] convert failed: ${e.message}`);
                done(false);
                return;
            }
        }
        const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        let pipeline = null;
        try {
            pipeline = Gst.parse_launch('filesrc location="' +
                esc(src.get_path() || '') + '" ! ' + branch +
                ' ! audioconvert ! audioresample ! vorbisenc quality=0.6' +
                ' ! oggmux ! filesink location="' + esc(part.get_path()) + '"');
        } catch (e) {
            console.error(`[Appchime] convert failed: ${e.message}`);
            done(false);
            return;
        }
        const bus = pipeline.get_bus();
        bus.add_watch(GLib.PRIORITY_DEFAULT, (_bus, message) => {
            if (message.type === Gst.MessageType.ERROR) {
                const [err] = message.parse_error();
                console.error(`[Appchime] convert failed: ${err.message}`);
                pipeline.set_state(Gst.State.NULL);
                done(false);
                return GLib.SOURCE_REMOVE;
            }
            if (message.type === Gst.MessageType.EOS) {
                pipeline.set_state(Gst.State.NULL);
                done(this._verifyPart(src, part, target));
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        pipeline.set_state(Gst.State.PLAYING);
    }

    _verifyPart(src, part, target) {
        if (!part.query_exists(null))
            return false;
        const size = part.query_info('standard::size',
            Gio.FileQueryInfoFlags.NONE, null).get_size();
        if (size <= 1024)
            return false;
        if (!this._targetIsFresh(src, part))
            return false;
        part.move(target, Gio.FileCopyFlags.OVERWRITE, null, null);
        this._log(`converted to ${target.get_basename()}`);
        return true;
    }

    _doneTranscode(key, part, target, ok) {
        const waiting = this._activeConverts.get(key) || [];
        this._activeConverts.delete(key);
        if (part.query_exists(null))
            part.delete(null);
        if (!ok && target.query_exists(null))
            target.delete(null);
        if (ok) {
            for (const cb of waiting)
                cb(true);
        }
    }

    _previewFile(file) {
        if (this._isMp3(file))
            this._previewMp3(file);
        else
            this._previewMediaFile(file);
    }

    _isMp3(file) {
        if (file.query_exists(null)) {
            const info = file.query_info('standard::content-type',
                Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_content_type() === 'audio/mpeg')
                return true;
        }
        const name = file.get_basename() || '';
        return name.toLowerCase().endsWith('.mp3');
    }

    _stopPreviewPipeline() {
        if (this._previewPipeline) {
            this._previewPipeline.set_state(Gst.State.NULL);
            this._previewPipeline = null;
        }
    }

    _previewMp3(file) {
        this._stopPreviewPipeline();
        let pipeline = null;
        try {
            const registry = Gst.Registry.get();
            if (!registry.lookup_feature('mpg123audiodec') ||
                    !registry.lookup_feature('mpegaudioparse')) {
                throw new Error('no mp3 decoder found');
            }
            const path = (file.get_path() || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            pipeline = Gst.parse_launch(
                `filesrc location="${path}" ! mpegaudioparse ! mpg123audiodec ! audioconvert ! autoaudiosink`);
        } catch (e) {
            console.error(`[Appchime] preview failed: ${e.message}`);
            return;
        }
        this._previewPipeline = pipeline;
        const bus = pipeline.get_bus();
        bus.add_watch(GLib.PRIORITY_DEFAULT, (_bus, message) => {
            if (message.type === Gst.MessageType.ERROR) {
                const [err] = message.parse_error();
                console.error(`[Appchime] preview failed: ${err.message}`);
                this._stopPreviewPipeline();
                return GLib.SOURCE_REMOVE;
            }
            if (message.type === Gst.MessageType.EOS) {
                this._stopPreviewPipeline();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        pipeline.set_state(Gst.State.PLAYING);
    }

    _previewMediaFile(file) {
        try {
            const media = Gtk.MediaFile.new_for_file(file);
            const handlerIds = [];
            let cleaned = false;
            const cleanup = () => {
                if (cleaned)
                    return;
                cleaned = true;
                for (const id of handlerIds)
                    media.disconnect(id);
                const i = this._previews.indexOf(media);
                if (i >= 0)
                    this._previews.splice(i, 1);
            };
            handlerIds.push(media.connect('notify::ended', () => {
                if (media.ended)
                    cleanup();
            }));
            handlerIds.push(media.connect('notify::error', () => cleanup()));
            this._previews.push(media);
            media.play();
        } catch (e) {
            console.error(`[Appchime] preview failed: ${e.message}`);
        }
    }
}
