/* prefs.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


import Adw       from 'gi://Adw';
import Gdk       from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio       from 'gi://Gio';
import GLib      from 'gi://GLib';
import GObject   from 'gi://GObject';
import Gtk       from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Base32      from './base32.js';
import MyAlertDialog    from './myAlertDialog.js';
import MyEntryRow       from './myEntryRow.js';
import MySpinRow        from './mySpinRow.js';
import * as SecretUtils from './secretUtils.js';
import TOTP             from './totp.js';


Gio._promisify(Gio.Subprocess.prototype, 'communicate_async', 'communicate_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_text_async', 'read_text_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_texture_async', 'read_texture_finish');

const AlertDialog = Gtk.AlertDialog ?? MyAlertDialog;
Gio._promisify(AlertDialog.prototype, 'choose', 'choose_finish');

const EntryRow = Adw.EntryRow ?? MyEntryRow;

const SpinRow = Adw.SpinRow ?? MySpinRow;


function makeLabel({issuer, name})
{
    const safe_issuer = GLib.markup_escape_text(issuer, -1);
    const safe_name = GLib.markup_escape_text(name, -1);
    return `${safe_issuer}: ${safe_name}`;
}


function reportError(root, e)
{
    logError(e);
    try {
        const dialog = new AlertDialog({
            modal: true,
            detail: _(e.message),
            message: _('Error')
        });
        dialog.show(root);
    }
    catch (ee) {
        logError(ee);
    }
}


function now()
{
    return new Date().getTime() / 1000;
}


function findListBoxChild(start)
{
    // Note: use BFS
    const queue = [start];

    while (queue.length > 0) {
        const current = queue.shift();
        if (current instanceof Gtk.ListBox)
            return current;

        let child = current.get_first_child();
        while (child) {
            queue.push(child);
            child = child.get_next_sibling();
        }
    }

    return null;
}


function makeStringList(...strings)
{
    if (!Gtk.check_version(4, 10, 0))
        return new Gtk.StringList({ strings: strings });

    const list = new Gtk.StringList();
    strings.forEach(s => list.append(s));
    return list;
}


function totpToVariant(totp)
{
    return new GLib.Variant('a{sv}', {
        issuer    : GLib.Variant.new_string(totp.issuer),
        name      : GLib.Variant.new_string(totp.name),
        digits    : GLib.Variant.new_uint32(totp.digits),
        period    : GLib.Variant.new_uint32(totp.period),
        algorithm : GLib.Variant.new_string(totp.algorithm),
    });
}


/*
function adwCheckVersion(req_major, req_minor)
{
    const major = Adw.get_major_version();
    if (major < req_major)
        return false;
    if (major > req_major)
        return true;
    return Adw.get_minor_version() >= req_minor;
}
*/


class ScanQRButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #settings;


    constructor(settings)
    {
        super({
            icon_name: 'camera-photo-symbolic',
            tooltip_text: _('Scan QR code.'),
            valign: Gtk.Align.CENTER
        });

        this.#settings = settings;
    }


    async on_clicked()
    {
        try {
            const qrscan_cmd = this.#settings.get_string('qrscan-cmd');
            const [parsed, args] = GLib.shell_parse_argv(qrscan_cmd);
            if (!parsed)
                throw new Error(_('Failed to parse "qrscan-cmd" option.'));

            const proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE);

            const [stdout] = await proc.communicate_utf8_async(null, null);
            if (!stdout)
                return;

            this.activate_action('import-uri',
                                 GLib.Variant.new_string(stdout));
        }
        catch (e) {
            reportError(this.root, e);
        }
    }

};


class PasteButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #settings;


    constructor(settings)
    {
        super({
            icon_name: 'edit-paste-symbolic',
            tooltip_text: _('Paste either the "otpauth://" URI, or the QR code image.'),
            valign: Gtk.Align.CENTER
        });

        this.#settings = settings;
    }


    async on_clicked()
    {
        try {
            const clipboard = this.get_clipboard();

            let text = null;

            if (clipboard.formats.contain_mime_type('text/plain;charset=utf-8'))
                text = await clipboard.read_text_async(null);
            else {
                const texture = await clipboard.read_texture_async(null);
                if (!texture)
                    return;

                const img_bytes = texture.save_to_png_bytes();

                const qrimage_cmd = this.#settings.get_string('qrimage-cmd');
                const [parsed, args] = GLib.shell_parse_argv(qrimage_cmd);
                if (!parsed)
                    throw new Error(_('Failed to parse "qrimage-cmd" option.'));

                const proc = Gio.Subprocess.new(args,
                                                Gio.SubprocessFlags.STDIN_PIPE
                                                | Gio.SubprocessFlags.STDOUT_PIPE);

                const [stdout] = await proc.communicate_async(img_bytes, null);
                if (!stdout)
                    return;

                const td = new TextDecoder();
                text = td.decode(stdout.get_data());
            }

            if (text)
                this.activate_action('import-uri',
                                     GLib.Variant.new_string(text));
        }
        catch (e) {
            reportError(this.root, e);
        }
    }

};


class SecretDialog extends Gtk.Dialog {

    static {
        GObject.registerClass(this);

        this.install_action('import-uri', 's',
                            (obj, name, arg) => obj.importURI(arg.unpack()));
    }

    static digits_list = ['5', '6', '7', '8'];
    static period_list = ['15', '30', '60'];
    static algorithm_list = ['SHA-1', 'SHA-256', 'SHA-512'];


    #reject;
    #resolve;
    #ui = {};


    constructor({ title, totp, settings })
    {
        const fields = totp.fields_non_destructive();

        super({
            title: title,
            default_width: 500,
            // WORKAROUND: need header bar, otherwise the dialog is not centered
            use_header_bar: true
        });

        const group = new Adw.PreferencesGroup({
            title: title,
            margin_bottom: 12,
            margin_top: 12,
            margin_start: 12,
            margin_end: 12
        });
        this.get_content_area().append(group);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6
        });
        group.set_header_suffix(box);

        box.append(new PasteButton(settings));
        box.append(new ScanQRButton(settings));


        // UI: issuer
        this.#ui.issuer = new EntryRow({
            title: _('Issuer'),
            text: fields.issuer,
            tooltip_text: _('The name of the organization (Google, Facebook, etc) that issued the OTP.')
        });
        group.add(this.#ui.issuer);

        // UI: name
        this.#ui.name = new EntryRow({
            title: _('Name'),
            text: fields.name
        });
        group.add(this.#ui.name);

        // UI: secret
        this.#ui.secret = new EntryRow({
            title: _('Secret'),
            text: fields.secret,
            tooltip_text: _('The shared secret key.')
        });
        this.#ui.secret_type = new Gtk.DropDown({
            model: makeStringList('Base32', 'Base64'),
            selected: 0,
            tooltip_text: _('How the secret key is encoded.')
        });
        this.#ui.secret.add_suffix(this.#ui.secret_type);
        group.add(this.#ui.secret);

        // UI: digits
        this.#ui.digits = new Adw.ComboRow({
            title: _('Digits'),
            title_lines: 1,
            model: makeStringList(...SecretDialog.digits_list),
            selected: SecretDialog.digits_list.indexOf(fields.digits),
            tooltip_text: _('How many digits in the code.')
        });
        group.add(this.#ui.digits);

        // UI: period
        this.#ui.period = new Adw.ComboRow({
            title: _('Period'),
            title_lines: 1,
            subtitle: _('Time between code updates, in seconds.'),
            subtitle_lines: 1,
            model: makeStringList(...SecretDialog.period_list),
            selected: SecretDialog.period_list.indexOf(fields.period)
        });
        group.add(this.#ui.period);

        // UI: algorithm
        this.#ui.algorithm = new Adw.ComboRow({
            title: _('Algorithm'),
            title_lines: 1,
            model: makeStringList(...SecretDialog.algorithm_list),
            selected: SecretDialog.algorithm_list.indexOf(fields.algorithm),
            tooltip_text: _('The hash algorithm used to generate codes.')
        });
        group.add(this.#ui.algorithm);


        // UI: confirm/cancel buttons
        this.add_button(_('_Cancel'), Gtk.ResponseType.CANCEL);

        const ok_button = this.add_button(_('_OK'), Gtk.ResponseType.OK);
        ok_button.add_css_class('suggested-action');
        this.set_default_widget(ok_button);


        // make sure the Issuer is focused
        this.#ui.issuer.grab_focus();
    }


    on_close_request()
    {
        this.#reject   = null;
        this.#resolve  = null;
        this.#ui       = null;
        return false;
    }


    on_response(response)
    {
        this.#resolve(response == Gtk.ResponseType.OK
                      ? this.getTOTP()
                      : null);
        this.close();
    }


    getTOTP()
    {
        let secret = this.#ui.secret.text;
        if (this.#ui.secret_type.selected == 1) // base64 -> base32
            secret = Base32.encode(GLib.base64_decode(secret));

        return new TOTP({
            issuer: this.#ui.issuer.text,
            name: this.#ui.name.text,
            secret: secret,
            digits: parseInt(this.#ui.digits.selected_item.string),
            period: parseInt(this.#ui.period.selected_item.string),
            algorithm: this.#ui.algorithm.selected_item.string
        });
    }


    setTOTP(totp)
    {
        const fields = totp.fields();
        this.#ui.issuer.text = fields.issuer;
        this.#ui.name.text = fields.name;
        this.#ui.secret.text = fields.secret;
        this.#ui.secret_type.selected = 0;
        this.#ui.digits.selected = SecretDialog.digits_list.indexOf(fields.digits.toString());
        this.#ui.period.selected = SecretDialog.period_list.indexOf(fields.period.toString());
        this.#ui.algorithm.selected = SecretDialog.algorithm_list.indexOf(fields.algorithm);
    }


    choose(parent)
    {
        this.transient_for = parent;
        this.modal = !!parent;
        this.visible = true;

        return new Promise((resolve, reject) => {
            this.#resolve = resolve;
            this.#reject = reject;
        });
    }


    importURI(uri)
    {
        try {
            this.setTOTP(new TOTP({ uri: uri }));
        }
        catch (e) {
            reportError(this.root, e);
        }
    }

};


class CopyCodeButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #code = null;
    #expiry = 0;
    #label;
    #level;
    #totp;
    #update_source = 0;


    constructor(totp)
    {
        super({
            tooltip_text: _('Copy code to clipboard.'),
            valign: Gtk.Align.CENTER,
        });

        this.#totp = totp;

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6
        });
        this.set_child(box);

        box.append(new Gtk.Image({
            icon_name: 'edit-copy-symbolic'
        }));

        this.#label = new Gtk.Label({
            label: _('Unlock'),
            use_markup: false,
            width_chars: 10
        });
        box.append(this.#label);

        this.#level = new Gtk.LevelBar({
            inverted: true,
            max_value: this.#totp.period,
            min_value: 0,
            mode: Gtk.LevelBarMode.CONTINUOUS,
            orientation: Gtk.Orientation.VERTICAL
        });
        this.#level.add_css_class('totp-code-level');
        this.#level.add_offset_value('full', this.#totp.period);
        this.#level.add_offset_value('high', 10);
        this.#level.add_offset_value('low', 5);

        box.append(this.#level);

        this.#update_source = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                                               500,
                                               () => {
                                                   try {
                                                       this.updateCode();
                                                   }
                                                   catch (e) {
                                                       this.cancelUpdates();
                                                       return GLib.SOURCE_REMOVE;
                                                   }
                                                   return GLib.SOURCE_CONTINUE;
                                               });

    }


    destroy()
    {
        this.cancelUpdates();
    }


    async updateCode()
    {
        try {
            if (this.expired()) {
                const item = await SecretUtils.getOTPItem(this.#totp);
                if (item.locked) {
                    this.#level.value = 0;
                    this.#label.label = _('Unlock');
                    this.#label.use_markup = false;
                    return;
                }

                this.#totp.secret = await SecretUtils.getSecret(this.#totp);

                const [code, expiry] = this.#totp.code_and_expiry();
                this.#expiry = expiry;
                this.#code = code;
            }
            this.#level.value = Math.max(this.#expiry - now(), 0);
            this.#label.label = `<tt>${this.#code}</tt>`;
            this.#label.use_markup = true;
        }
        catch (e) {
            /*
             * Note: errors here are harmless, it usually means the item was deleted or
             * edited while this async function was running. So we just disable the button
             * and call .destroy() to disable the callback.
             */
            this.sensitive = false;
            this.cancelUpdates();
        }
    }


    cancelUpdates()
    {
        if (this.#update_source) {
            GLib.Source.remove(this.#update_source);
            this.#update_source = 0;
        }
    }


    expired()
    {
        if (!this.#expiry == 0 || !this.#code)
            return true;
        if (this.#expiry < now())
            return true;
        return false;
    }


    async on_clicked()
    {
        try {
            this.#totp.secret = await SecretUtils.getSecret(this.#totp);
            const code = this.#totp.code();
            const arg = new GLib.Variant('(ssb)',
                                         [
                                             code,
                                             _('OTP code copied to clipboard.'),
                                             false
                                         ]);
            this.activate_action('totp.copy-to-clipboard', arg);
        }
        catch (e) {
            reportError(this.root, e);
        }
    }

};


class ExportQRWindow extends Gtk.Window {

    static {
        GObject.registerClass(this);
    }


    constructor(parent, img_stream)
    {
        super({
            transient_for: parent,
            modal: true,
            title: _('QR code'),
        });
        this.add_css_class('qr-export-window');

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL
        });
        this.set_child(box);

        const pbuf = GdkPixbuf.Pixbuf.new_from_stream(img_stream, null);

        const img = new Gtk.Image({
            hexpand: true,
            vexpand: true,
            height_request: 400,
            width_request: 400,
        });
        img.set_from_pixbuf(pbuf);
        box.append(img);

        const button = new Gtk.Button({
            label: _('_Close'),
            use_underline: true
        });
        button.connect('clicked', () => this.close());
        box.append(button);
    }

};


class MoveButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #direction;
    #group;
    #row;


    constructor(group, row, direction)
    {
        super({
            icon_name: (direction < 0 ? 'go-up-symbolic' : 'go-down-symbolic'),
            tooltip_text: (direction < 0
                           ? _('Move this secret up; hold down the SHIFT key to move to the top of the list.')
                           : _('Move this secret down; hold down the SHIFT key to move to the bottom of the list.'))
        });
        this.add_css_class('flat');
        this.add_css_class('totp-sort-button');
        this.#group = group;
        this.#row = row;
        this.#direction = direction;
    }


    destroy()
    {
        this.#group = null;
        this.#row = null;
    }


    on_clicked()
    {
        const display = Gdk.Display.get_default();
        const seat = display.get_default_seat();
        const kb = seat.get_keyboard();
        const modifier = kb.modifier_state;
        const shift_pressed = !!(modifier & Gdk.ModifierType.SHIFT_MASK);
        let offset = this.#direction;
        if (shift_pressed)
            offset *= Infinity;
        this.#group.moveBy(this.#row, offset);
    }

};


class SecretRow extends Adw.ActionRow {

    static {
        GObject.registerClass(this);
    }


    #copy_code_button;
    #down_button;
    #up_button;


    constructor(totp, group, settings)
    {
        super({
            title: totp.issuer,
            title_lines: 1,
            subtitle: totp.name,
            subtitle_lines: 1,
        });


        this._totp = totp; // used by storeAllRowsOrders()

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            homogeneous: true
        });
        this.add_prefix(box);

        this.#up_button = new MoveButton(group, this, -1);
        this.#down_button = new MoveButton(group, this, +1);
        box.append(this.#up_button);
        box.append(this.#down_button);

        this.#copy_code_button = new CopyCodeButton(totp);
        this.add_suffix(this.#copy_code_button);


        const menu = new Gio.Menu();

        // helper function
        const add_item = (label, action) => {
            const item = new Gio.MenuItem();
            item.set_label(label);
            item.set_action_and_target_value(action, totpToVariant(totp));
            menu.append_item(item);
        };

        add_item(_('_Edit...'),
                 'totp.edit-secret');

        add_item(_('_Copy to clipboard'),
                 'totp.export-secret-clipboard');

        add_item(_('Export to _QR code...'),
                 'totp.export-secret-qr');

        add_item(_('_Remove'),
                 'totp.remove-secret');

        this.add_suffix(new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            valign: Gtk.Align.CENTER,
            menu_model: menu,
        }));
    }


    destroy()
    {
        this.#up_button = null;
        this.#down_button = null;

        this.#copy_code_button.destroy?.();
        this.#copy_code_button = null;
    }


    updateButtons()
    {
        this.#up_button.sensitive = !!this.get_prev_sibling();
        this.#down_button.sensitive = !!this.get_next_sibling();
    }

};


class ImportURIsDialog extends Gtk.Dialog {

    static {
        GObject.registerClass(this);

        this.install_action('import-uri', 's',
                            (obj, name, arg) => obj.importURI(arg.unpack()));
    }


    #buffer;
    #reject;
    #resolve;


    constructor(settings)
    {
        super({
            title: _('Importing "otpauth://" URIs'),
            default_width: 600,
            default_height: 400,
            use_header_bar: true
        });
        this.add_css_class('import-uris-dialog');

        const vbox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6
        });
        vbox.add_css_class('import-uris-vbox');
        this.set_child(vbox);

        const hbox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6
        });
        vbox.append(hbox);

        const heading = new Gtk.Label({
            label: _('Paste all "otpauth://" URIs you want to import, one per line.'),
            hexpand: true,
        });
        hbox.append(heading);

        hbox.append(new PasteButton(settings));
        hbox.append(new ScanQRButton(settings));


        this.#buffer = new Gtk.TextBuffer();

        const scroll = new Gtk.ScrolledWindow({
            vexpand: true,
            hexpand: true,
            child: new Gtk.TextView({
                monospace: true,
                buffer: this.#buffer
            })
        });
        vbox.append(scroll);


        // UI: import/cancel buttons
        this.add_button(_('_Cancel'), Gtk.ResponseType.CANCEL);

        const import_button = this.add_button(_('_Import'), Gtk.ResponseType.OK);
        import_button.add_css_class('suggested-action');
        this.set_default_widget(import_button);
    }


    on_response(response)
    {
        this.#resolve(response == Gtk.ResponseType.OK
                      ? this.getText()
                      : null);
        this.close();
    }


    getText()
    {
        return this.#buffer.text;
    }


    choose(parent)
    {
        this.transient_for = parent;
        this.modal = !!parent;
        this.visible = true;

        return new Promise((resolve, reject) => {
            this.#resolve = resolve;
            this.#reject = reject;
        });
    }


    importURI(uri)
    {
        const iter = this.#buffer.get_end_iter();
        this.#buffer.insert(iter, uri + '\n', -1);
    }


};


class LockButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #locked = true;


    constructor(args)
    {
        super({
            icon_name: 'dialog-password-symbolic',
            ...args
        });

        this.updateState();
    }


    async updateState()
    {
        try {
            this.#locked = await SecretUtils.isOTPCollectionLocked();
            if (this.#locked) {
                this.icon_name = 'changes-prevent-symbolic';
                this.tooltip_text = _('Unlock OTP secrets...');
            } else {
                this.icon_name = 'changes-allow-symbolic';
                this.tooltip_text = _('Lock OTP secrets');
            }
        }
        catch (e) {
            logError(e);
        }
    }


    async on_clicked()
    {
        try {
            const success = this.#locked
                ? await SecretUtils.unlockOTPCollection()
                : await SecretUtils.lockOTPCollection();
            await this.updateState();
            this.activate_action('totp.refresh', null);
        }
        catch (e) {
            reportError(this.root, e);
        }
    }

};


class SecretsGroup extends Adw.PreferencesGroup {

    static {
        GObject.registerClass(this);

        this.install_action('totp.create', null,
                            obj => obj.createSecret());

        this.install_action('totp.refresh', null,
                            obj => obj.refreshRows());

        this.install_action('totp.import', null,
                            obj => obj.importSecrets());

        this.install_action('totp.export-all', null,
                            obj => obj.exportAllSecrets());

        this.install_action('totp.copy-to-clipboard', '(ssb)',
                            (obj, name, args) =>
                            obj.copyToClipboard(...args.recursiveUnpack()));

        this.install_action('totp.edit-secret', 'a{sv}',
                            (obj, name, args) =>
                                obj.editSecret(new TOTP(args.recursiveUnpack())));

        this.install_action('totp.export-secret-clipboard', 'a{sv}',
                            (obj, name, args) =>
                                obj.exportSecretClipboard(new TOTP(args.recursiveUnpack())));

        this.install_action('totp.export-secret-qr', 'a{sv}',
                            (obj, name, args) =>
                                obj.exportSecretQR(new TOTP(args.recursiveUnpack())));

        this.install_action('totp.remove-secret', 'a{sv}',
                            (obj, name, args) =>
                                obj.removeSecret(new TOTP(args.recursiveUnpack())));

    }


    #clipboard_clear_source = 0;
    #lock_button;
    #rows = [];
    #settings;


    constructor(application_id, settings)
    {
        super({
            title: _('Secrets'),
            description: _('A list of all TOTP secrets from the keyring.')
        });

        const listbox = findListBoxChild(this);
        listbox?.set_sort_func(this.rowSortFunc.bind(this));

        this.#settings = settings;

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6
        });
        this.set_header_suffix(box);

        this.#lock_button = new LockButton({ valign: Gtk.Align.CENTER });
        box.append(this.#lock_button);

        box.append(
            new Gtk.Button({
                icon_name: 'document-new-symbolic',
                tooltip_text: _('Add secret...'),
                action_name: 'totp.create',
                valign: Gtk.Align.CENTER,
            })
        );

        box.append(
            new Gtk.Button({
                icon_name: 'view-refresh-symbolic',
                tooltip_text: _('Refresh secrets.'),
                action_name: 'totp.refresh',
                valign: Gtk.Align.CENTER,
            })
        );

        box.append(
            new Gtk.Button({
                icon_name: 'document-import-symbolic',
                action_name: 'totp.import',
                tooltip_text: _('Import secrets...'),
                valign: Gtk.Align.CENTER,
            })
        );

        box.append(
            new Gtk.Button({
                icon_name: 'document-export-symbolic',
                action_name: 'totp.export-all',
                tooltip_text: _('Export all secrets to the clipboard.'),
                valign: Gtk.Align.CENTER,
            })
        );

        this.refreshRows();
    }


    destroy()
    {
        this.cancelClipboardClear();
        this.clearRows();
        this.#lock_button = null;
        this.#settings    = null;
    }


    clearRows()
    {
        this.#rows.forEach(row => {
            this.remove(row);
            row.destroy();
        });
        this.#rows = [];
    }


    async refreshRows()
    {
        this.clearRows();
        try {
            const items = await SecretUtils.getOTPItems();
            this.#lock_button.updateState();
            items.forEach(item =>
                {
                    const totp = new TOTP(item.get_attributes());
                    const row = new SecretRow(totp, this, this.#settings);
                    this.#rows.push(row);
                    this.add(row);
                });
            this.#rows.forEach(r => r.updateButtons());
        }
        catch (e) {
            logError(e);
        }
    }


    async createSecret()
    {
        try {
            const dialog = new SecretDialog({
                title: _('Creating new TOTP secret'),
                totp: new TOTP(),
                settings: this.#settings
            });

            const totp = await dialog.choose(this.root);
            if (!totp)
                return;

            const n = this.#rows.length;
            await SecretUtils.createTOTPItem(totp, n);
            this.root?.add_toast(new Adw.Toast({ title: _('Created new secret.') }));
            await this.refreshRows();
        }
        catch (e) {
            reportError(this.root, e);
        }
    }


    async importSecrets()
    {
        try {
            const dialog = new ImportURIsDialog(this.#settings);
            const text = await dialog.choose(this.root);
            if (!text)
                return; // canceled or empty text

            const n = this.#rows.length;
            const uris = GLib.Uri.list_extract_uris(text);

            let successes = 0;
            for (let i = 0; i < uris.length; ++i) {
                try {
                    const totp = new TOTP({ uri: uris[i] });
                    await SecretUtils.createTOTPItem(totp, n + i);
                    ++successes;
                }
                catch (e) {
                    logError(e);
                }
            }
            this.root?.add_toast(new Adw.Toast({
                title: _('Imported secrets:') + ` ${successes}`
            }));

            await this.refreshRows();

        }
        catch (e) {
            reportError(this.root, e);
        }
    }


    async exportAllSecrets()
    {
        try {
            const uris = [];
            const items = await SecretUtils.getOTPItems();
            for (let i = 0; i < items.length; ++i) {
                const attrs = items[i].get_attributes();
                attrs.secret = await SecretUtils.getSecret(attrs);
                const totp = new TOTP(attrs);
                uris.push(totp.uri());
            }
            this.copyToClipboard(uris.join('\n'),
                                 _('Copied all OTP secrets to clipboard.'),
                                 true);
        }
        catch (e) {
            reportError(this.root, e);
        }
    }


    // Store the UI order in the keyring as their labels

    async storeOneRowOrder(row)
    {
        try {
            const idx = this.#rows.indexOf(row);
            const totp = row._totp;
            await SecretUtils.updateTOTPOrder(totp, idx);
        }
        catch (e) {
            logError(e);
        }
    }

    async storeAllRowsOrders()
    {
        try {
            for (let i = 0; i < this.#rows.length; ++i) {
                const totp = this.#rows[i]._totp;
                await SecretUtils.updateTOTPOrder(totp, i);
            }
        }
        catch (e) {
            logError(e);
        }
    }


    moveBy(row, offset)
    {
        const i = this.#rows.indexOf(row);
        if (i == -1)
            throw Error(`Trying to move a row that was not found: ${row}`);

        if (isFinite(offset)) {
            const j = i + offset;
            if (j < 0 || j >= this.#rows.length)
                return;
            // swap them
            [this.#rows[i], this.#rows[j]] = [this.#rows[j], this.#rows[i]];
            this.storeOneRowOrder(this.#rows[i]); // no await
            this.storeOneRowOrder(this.#rows[j]); // no await
        } else {
            this.#rows.splice(i, 1);
            if (offset < 0) {
                // move all the way to the front
                this.#rows.unshift(row);
            } else {
                // move all the way to the back
                this.#rows.push(row);
            }
            this.storeAllRowsOrders(); // no await
        }

        row.parent.invalidate_sort();
        this.#rows.forEach(r =>  r.updateButtons());
    }


    rowSortFunc(rowI, rowJ)
    {
        const i = this.#rows.indexOf(rowI);
        const j = this.#rows.indexOf(rowJ);
        return i - j;
    }


    copyToClipboard(text, title, sensitive)
    {
        // this runs outside gnome-shell, so we use GDK
        const display = Gdk.Display.get_default();
        const clipboard1 = display.get_primary_clipboard();
        const clipboard2 = display.get_clipboard();
        clipboard1.set(text);
        clipboard2.set(text);

        this.cancelClipboardClear();

        if (sensitive) {
            const delay = this.#settings.get_uint('clipboard-clear-delay');
            this.#clipboard_clear_source =
                GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                                 delay * 1000,
                                 this.clipboardClear.bind(this));
        }

        if (!title)
            return;

        this.root?.add_toast(new Adw.Toast({ title: title }));
    }


    clipboardClear()
    {
        this.cancelClipboardClear();
        try {
            const display = Gdk.Display.get_default();
            const clipboard1 = display.get_primary_clipboard();
            const clipboard2 = display.get_clipboard();
            if (clipboard1.local)
                clipboard1.set(null);
            if (clipboard2.local)
                clipboard2.set(null);
        }
        catch (e) {
            logError(e);
        }
        return GLib.SOURCE_REMOVE;
    }


    cancelClipboardClear()
    {
        if (!this.#clipboard_clear_source)
            return;
        GLib.Source.remove(this.#clipboard_clear_source);
        this.#clipboard_clear_source = 0;
    }


    async editSecret(totp)
    {
        try {
            totp.secret = await SecretUtils.getSecret(totp);

            const dialog = new SecretDialog({
                title: _('Editing TOTP secret'),
                totp: totp,
                settings: this.#settings
            });

            const new_totp = await dialog.choose(this.root);
            if (!new_totp)
                return;

            await SecretUtils.updateTOTPItem(totp, new_totp);
            totp.wipe();
            await this.refreshRows();
        }
        catch (e) {
            reportError(this.root, e);
        }
    }


    async exportSecretClipboard(totp)
    {
        try {
            totp.secret = await SecretUtils.getSecret(totp);
            const uri = totp.uri();
            this.copyToClipboard(uri,
                                 _('Copied secret URI to clipboard.'),
                                 true);
        }
        catch (e) {
            reportError(this.root, e);
        }
    }


    async exportSecretQR(totp)
    {
        try {
            totp.secret = await SecretUtils.getSecret(totp);
            const uri = totp.uri();

            const te = new TextEncoder();
            const uri_data = te.encode(uri);

            const qrencode_cmd = this.#settings.get_string('qrencode-cmd');
            const [parsed, args] = GLib.shell_parse_argv(qrencode_cmd);
            if (!parsed)
                throw new Error(_('Failed to parse "qrencode-cmd" option.'));

            const proc = Gio.Subprocess.new(args,
                                            Gio.SubprocessFlags.STDIN_PIPE
                                            | Gio.SubprocessFlags.STDOUT_PIPE
                                            | Gio.SubprocessFlags.STDERR_PIPE);

            /*
             * WORKAROUND: `.communicate_async()` will randomly fail with a broken pipe
             * error, so we have to use the blocking API instead.
             */
            const [success, stdout, stderr] = proc.communicate(uri_data, null);

            const status = proc.get_exit_status();
            if (status) {
                if (stderr) {
                    const td = new TextDecoder();
                    const stderr_text = td.decode(stderr.get_data());
                    throw new Error(stderr_text);
                } else
                    throw new Error(`Process exited with status: ${status}`);
            }

            if (!stdout)
                throw new Error('Empty stdout');

            const img_stream = Gio.MemoryInputStream.new_from_bytes(stdout);
            const export_window = new ExportQRWindow(this.root, img_stream);
            export_window.show();
        }
        catch (e) {
            reportError(this.root, e);
        }
    }


    async removeSecret(totp)
    {
        try {
            const cancel_response = 0;
            const delete_response = 1;
            const buttons = [_('_Cancel'), _('_Delete')];
            const label = makeLabel(totp);
            const dialog = new AlertDialog({
                message: _('Deleting TOTP secret'),
                detail: _('Deleting secret:') + ` "${label}"`,
                modal: true,
                default_button: delete_response,
                cancel_button: cancel_response,
                buttons: buttons
            });

            const response = await dialog.choose(this.root, null);
            if (response == delete_response) {
                const success = await SecretUtils.removeTOTPItem(totp);
                if (!success)
                    throw new Error(_('Failed to remove secret. Is it locked?'));
                this.root?.add_toast(
                    new Adw.Toast({ title: _('Deleted secret:') + ` "${label}"` })
                );
                await this.refreshRows();
                await this.storeAllRowsOrders();
            }
        }
        catch (e) {
            reportError(this.root, e);
        }
    }

};


class CmdSettingRow extends EntryRow {

    static {
        GObject.registerClass(this);

        this.install_action('reset-setting', null,
                            obj => obj.resetSetting());
    }


    #key;
    #settings;


    constructor({settings, key, ...args})
    {
        super(args);
        this.add_css_class('command-entry');

        this.#key = key;
        this.#settings = settings;

        this.#settings.bind(key,
                            this, 'text',
                            Gio.SettingsBindFlags.DEFAULT);

        this.add_suffix(new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: _('Revert option back to the default value.'),
            action_name: 'reset-setting',
            valign: Gtk.Align.CENTER,
        }));
    }


    destroy()
    {
        this.#settings = null;
    }


    resetSetting()
    {
        this.#settings.reset(this.#key);
    }

};


class OptionsGroup extends Adw.PreferencesGroup {

    static {
        GObject.registerClass(this);
    }


    #qrencode;
    #qrimage;
    #qrscan;


    constructor(settings)
    {
        super({
            title: _('Options')
        });

        this.#qrencode = new CmdSettingRow({
            settings: settings,
            key: 'qrencode-cmd',
            title: _('QR generator'),
            tooltip_text: _('This command must read text from standard input, and write an image to the standard output.')
        });
        this.add(this.#qrencode);

        this.#qrimage = new CmdSettingRow({
            settings: settings,
            key: 'qrimage-cmd',
            title: _('QR reader'),
            tooltip_text: _('This command must read an image from the standard input, and print the decoded URI to the standard output.')
        });
        this.add(this.#qrimage);

        this.#qrscan = new CmdSettingRow({
            settings: settings,
            key: 'qrscan-cmd',
            title: _('QR scanner'),
            tooltip_text: _('This command must capture an image from a camera, and print the decoded URI to the standard output.')
        });
        this.add(this.#qrscan);

        const cb_clear_delay = new SpinRow({
            title: _('Clipboard clear delay'),
            subtitle: _('Sensitive data is cleared from the clipboard after this many seconds.'),
            tooltip_text: _('When exporting sensitive data ("otpauth://" URIs) they will be cleared from the clipboard after this time has passed. Authentication codes are not cleared.'),
            adjustment: new Gtk.Adjustment({
                value: 30,
                lower: 1,
                upper: Number.MAX_SAFE_INTEGER,
                step_increment: 1,
                page_increment: 10,
            }),
            numeric: true,
            width_chars: 5
        });
        settings.bind('clipboard-clear-delay',
                      cb_clear_delay, 'value',
                      Gio.SettingsBindFlags.DEFAULT);

        this.add(cb_clear_delay);

    }


    destroy()
    {
        this.#qrencode?.destroy();
        this.#qrencode = null;

        this.#qrimage?.destroy();
        this.#qrimage = null;

        this.#qrscan?.destroy();
        this.#qrscan = null;
    }

};


class TOTPPreferencesPage extends Adw.PreferencesPage {

    static {
        GObject.registerClass(this);
    }


    #options_group;
    #provider;
    #resource;
    #secrets_group;
    #settings;


    constructor(path, application_id, settings)
    {
        super();

        /*
         * Note: icons need to be loaded from gresource, not from filesystem, in order
         * to be theme-recolored.
         */
        this.#resource = Gio.Resource.load(`${path}/icons.gresource`);
        Gio.resources_register(this.#resource);
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const res_path = '/com/github/dkosmari/totp/icons';
        if (!theme.get_resource_path().includes(res_path))
            theme.add_resource_path(res_path);

        this.#provider = new Gtk.CssProvider();
        this.#provider.load_from_path(`${path}/prefs.css`);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(),
                                                  this.#provider,
                                                  Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this.#settings = settings;

        this.#secrets_group = new SecretsGroup(application_id, this.#settings);
        this.add(this.#secrets_group);

        this.#options_group = new OptionsGroup(this.#settings);
        this.add(this.#options_group);
    }


    destroy()
    {
        this.#settings = null;

        if (this.#options_group) {
            this.remove(this.#options_group);
            this.#options_group?.destroy();
            this.#options_group = null;
        }

        if (this.#secrets_group) {
            this.remove(this.#secrets_group);
            this.#secrets_group?.destroy();
            this.#secrets_group = null;
        }

        if (this.#provider) {
            Gtk.StyleContext.remove_provider_for_display(Gdk.Display.get_default(),
                                                         this.#provider);
            this.#provider = null;
        }

        if (this.#resource) {
            Gio.resources_unregister(this.#resource);
            this.#resource = null;
        }
    }

};


export default
class TOTPPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window)
    {
        const app = window.get_application();
        const app_id = app?.application_id ?? 'org.gnome.Extensions';

        const page = new TOTPPreferencesPage(this.path,
                                           app_id,
                                           this.getSettings());

        window.add(page);
        window.connect('close-request',
                       () => {
                           window.remove(page);
                           page.destroy();
                           return false;
                       });
    }

};
