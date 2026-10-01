// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MASTER_SCHEMA_ID = 'org.gnome.desktop.notifications';
const MASTER_DND_KEY = 'show-banners';

const BUNDLED_SOUNDS = {
    'chime': 'chime.oga',
    'mail-swoosh': 'mail-swoosh.oga',
    'message-chime': 'message-chime.oga',
    'glass-ping': 'glass-ping.oga',
    'soft-bell': 'soft-bell.oga',
    'marimba': 'marimba.oga',
    'pop': 'pop.oga',
};

const DEFAULT_SOUND_ID = 'chime';
const CUSTOM = 'custom';
const MUTE = 'mute';
const MAX_SEEN_APPS = 200;

// Screen captures play a shell sound directly. Match source icons because
// notification titles are translated.
const SHELL_CAPTURE_ICONS = new Set([
    'screenshooter-symbolic',
    'screenshot-recorded-symbolic',
    'screencast-recorded-symbolic',
]);

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

export default class AppchimeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._masterSettings = new Gio.Settings({schema_id: MASTER_SCHEMA_ID});
        this._sourceHandlers = new Map();
        this._lastPlayedUs = 0;

        for (const source of Main.messageTray.getSources())
            this._watchSource(source);

        this._trayHandlerId = Main.messageTray.connect('source-added',
            (_tray, source) => this._watchSource(source));
        this._trayRemovedHandlerId = Main.messageTray.connect('source-removed',
            (_tray, source) => this._unwatchSource(source));

        this._log('enabled');
    }

    disable() {
        this._log('disabled');
        if (this._trayHandlerId && Main.messageTray)
            Main.messageTray.disconnect(this._trayHandlerId);
        if (this._trayRemovedHandlerId && Main.messageTray)
            Main.messageTray.disconnect(this._trayRemovedHandlerId);
        this._trayHandlerId = 0;
        this._trayRemovedHandlerId = 0;

        if (this._sourceHandlers) {
            this._sourceHandlers.forEach((notifyId, source) => {
                if (notifyId)
                    source.disconnect(notifyId);
            });
            this._sourceHandlers.clear();
            this._sourceHandlers = null;
        }

        this._masterSettings = null;
        this._settings = null;
        this._lastPlayedUs = 0;
    }

    _log(message) {
        if (!this._settings)
            return;
        const schema = this._settings.settings_schema;
        if (schema && schema.has_key('debug') &&
                this._settings.get_boolean('debug')) {
            console.log(`[Appchime] ${message}`);
        }
    }

    _watchSource(source) {
        if (!source || !this._sourceHandlers || this._sourceHandlers.has(source))
            return;
        const notifyId = source.connect('notification-added',
            (src, notification) => this._onNotification(src, notification));
        this._sourceHandlers.set(source, notifyId);
    }

    _unwatchSource(source, knownId) {
        if (!this._sourceHandlers)
            return;
        const notifyId = knownId !== undefined ? knownId : this._sourceHandlers.get(source);
        if (notifyId)
            source.disconnect(notifyId);
        this._sourceHandlers.delete(source);
    }

    _isIgnored(appId, displayName) {
        const patterns = this._settings.get_strv('ignore-patterns');
        if (!patterns.length)
            return false;
        const id = (appId || '').toLowerCase();
        const name = (displayName || '').toLowerCase();
        for (const pattern of patterns) {
            const needle = pattern.toLowerCase().trim();
            if (needle && (id.includes(needle) || name.includes(needle)))
                return true;
        }
        return false;
    }

    // GTK notification sources expose their app ID through _appId.
    _resolveAppId(source) {
        let id = null;
        let displayName = null;

        if (source.app) {
            id = source.app.get_id();
            displayName = source.app.get_name();
        }
        if (!id && source._appId)
            id = `${source._appId}.desktop`;
        if (!displayName)
            displayName = source.title;
        if (!id)
            id = displayName || 'unknown';
        if (!displayName)
            displayName = id;

        return {id, displayName};
    }

    _onNotification(source, notification) {
        if (!this._settings)
            return;
        const {id: appId, displayName} = this._resolveAppId(source);
        this._log(`notification from "${displayName}" (id: ${appId})`);
        this._recordSeenApp(appId, displayName);

        if (this._isIgnored(appId, displayName)) {
            this._log(`ignored by pattern for ${appId}`);
            return;
        }

        const rateLimitMs = this._settings.get_int('rate-limit-ms');
        const nowUs = GLib.get_monotonic_time();
        if (rateLimitMs > 0 && this._lastPlayedUs > 0 &&
                nowUs - this._lastPlayedUs < rateLimitMs * 1000) {
            return;
        }

        if (this._settings.get_boolean('respect-dnd') &&
                !this._masterSettings.get_boolean(MASTER_DND_KEY)) {
            return;
        }

        if (!this._settings.get_boolean('play-with-hint') &&
                this._notificationHasOwnSound(notification)) {
            this._log('skipped: notification carries its own sound hint');
            return;
        }

        const rules = parseJsonObject(this._settings.get_string('app-rules'));
        if (!rules[appId] && this._shellPlayedItsOwnSound(source)) {
            this._log('skipped: shell plays its own sound for this source');
            return;
        }

        const file = this._fileForApp(appId, rules);
        if (!file)
            return;

        if (this._playFile(file)) {
            this._lastPlayedUs = nowUs;
            this._log(`played ${file.get_basename()} for ${appId}`);
        }
    }

    // A Sound object can exist without a sound hint; check its fields.
    _notificationHasOwnSound(notification) {
        const sound = notification.sound;
        return !!(sound && (sound._soundFile || sound._soundName));
    }

    _shellPlayedItsOwnSound(source) {
        if (source.app || source._appId)
            return false;
        const icon = source.icon;
        if (icon instanceof Gio.ThemedIcon) {
            for (const name of icon.get_names()) {
                if (SHELL_CAPTURE_ICONS.has(name))
                    return true;
            }
        }
        return false;
    }

    _fileForApp(appId, rules) {
        const rule = rules[appId];
        if (rule && typeof rule === 'object') {
            let resolved = null;
            try {
                resolved = this._fileForSpec(rule.sound, rule.file);
            } catch (e) {
                console.error(`[Appchime] bad rule for ${appId}: ${e.message}`);
            }
            if (resolved)
                return resolved;
            if (rule.sound === MUTE)
                return null;
            this._log(`invalid rule for ${appId}, using default sound`);
        }
        return this._fileForSpec(
            this._settings.get_string('default-sound'),
            this._settings.get_string('default-custom-file'));
    }

    _fileForSpec(spec, customFile) {
        if (spec === MUTE)
            return null;
        if (spec === CUSTOM) {
            const file = this._customFileToGioFile(customFile);
            if (!file || !file.query_exists(null)) {
                this._log('custom sound file missing, falling back to bundled default');
                return this._bundledFile(DEFAULT_SOUND_ID);
            }
            if (!this._isRuntimePlayable(file)) {
                this._log(`${file.get_basename()} is not Ogg Vorbis or WAV, ` +
                    'which are the only formats the shell sound player decodes; ' +
                    'falling back to the bundled default (convert it with: ' +
                    'ffmpeg -i in.mp3 -c:a libvorbis out.oga)');
                return this._bundledFile(DEFAULT_SOUND_ID);
            }
            return file;
        }
        return this._bundledFile(spec && BUNDLED_SOUNDS[spec] ? spec : DEFAULT_SOUND_ID);
    }

    // The shell sound player accepts WAV and Ogg Vorbis.
    _isRuntimePlayable(file) {
        const playableTypes = new Set([
            'audio/ogg', 'application/ogg', 'audio/x-vorbis',
            'audio/x-wav', 'audio/wav', 'audio/vnd.wave', 'audio/x-pn-wav',
        ]);
        if (file.query_exists(null)) {
            const info = file.query_info('standard::content-type',
                Gio.FileQueryInfoFlags.NONE, null);
            if (playableTypes.has(info.get_content_type()))
                return true;
        }
        const name = (file.get_basename() || '').toLowerCase();
        return name.endsWith('.oga') || name.endsWith('.ogg') || name.endsWith('.wav');
    }

    _bundledFile(id) {
        return Gio.File.new_for_path(
            GLib.build_filenamev([this.path, BUNDLED_SOUNDS[id]]));
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

    _playFile(file) {
        try {
            const player = global.display.get_sound_player();
            player.play_from_file(file, 'Appchime notification', null);
            return true;
        } catch (e) {
            console.error(`[Appchime] failed to play sound: ${e.message}`);
            return false;
        }
    }

    _recordSeenApp(appId, displayName) {
        const seen = parseJsonObject(this._settings.get_string('seen-apps'));
        if (seen[appId] === displayName)
            return;
        seen[appId] = displayName;
        const keys = Object.keys(seen);
        if (keys.length > MAX_SEEN_APPS) {
            for (const old of keys.slice(0, keys.length - MAX_SEEN_APPS))
                delete seen[old];
        }
        this._settings.set_string('seen-apps', JSON.stringify(seen));
    }
}
