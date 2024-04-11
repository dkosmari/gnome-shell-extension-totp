/* prefs.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const {
    Adw,
    Gdk,
    GdkPixbuf,
    Gio,
    GLib,
    GObject,
    Gtk
} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const _ = ExtensionUtils.gettext;

const Base32        = Me.imports.base32;
const MyAlertDialog = Me.imports.myAlertDialog.AlertDialog;
const MyEntryRow    = Me.imports.myEntryRow.EntryRow;
const SecretUtils   = Me.imports.secretUtils;
const TOTP          = Me.imports.totp.TOTP;


Gio._promisify(Gio.Subprocess.prototype, 'communicate_async', 'communicate_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_texture_async', 'read_texture_finish');

const AlertDialog = Gtk.AlertDialog ?? MyAlertDialog;
Gio._promisify(AlertDialog.prototype, 'choose', 'choose_finish');

const EntryRow = Adw.EntryRow ?? MyEntryRow;


function activateCopyToClipboard(source, text, title)
{
    source.activate_action('copy-to-clipboard',
                           new GLib.Variant('(ss)',
                                            [text, title]));
}


function makeLabel({issuer, name})
{
    let safe_issuer = GLib.markup_escape_text(issuer, -1);
    let safe_name = GLib.markup_escape_text(name, -1);
    return `${safe_issuer}: ${safe_name}`;
}


function reportError(parent, e, where = null)
{
    if (where)
        logError(e, where);
    else
        logError(e);
    try {
        const dialog = new AlertDialog({
            modal: true,
            detail: _(e.message),
            message: where || _('Error')
        });
        dialog.show(parent);
    }
    catch (ee) {
        logError(ee, 'reportError()');
    }
}


function now()
{
    return new Date().getTime() / 1000;
}


function findListBox(start)
{
    // Note: use BFS
    let queue = [start];

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


class PasteQRButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #settings;


    constructor(settings)
    {
        super({
            icon_name: 'edit-paste-symbolic',
            tooltip_text: _('Paste QR code image.'),
            valign: Gtk.Align.CENTER
        });

        this.#settings = settings;
    }


    async on_clicked()
    {
        try {
            const clipboard = this.get_clipboard();
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
            const text = td.decode(stdout.get_data());

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
    #settings;
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

        this.#settings = settings;

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

        box.append(new PasteQRButton(settings));
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
        this.set_focus(this.#ui.issuer);
    }


    on_close_request()
    {
        this.#reject   = null;
        this.#resolve  = null;
        this.#settings = null;
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
            valign: Gtk.Align.CENTER
        });

        this.#totp = totp;

        let box = new Gtk.Box({
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
            width_chars: 9
        });
        box.append(this.#label);

        this.#level = new Gtk.LevelBar({
            inverted: true,
            max_value: this.#totp.period,
            min_value: 0.0,
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
                                                       this.destroy();
                                                       return GLib.SOURCE_REMOVE;
                                                   }
                                                   return GLib.SOURCE_CONTINUE;
                                               });

    }


    destroy()
    {
        if (this.#update_source) {
            GLib.Source.remove(this.#update_source);
            this.#update_source = 0;
        }
    }


    async updateCode()
    {
        try {
            if (this.expired()) {
                let item = await SecretUtils.getOTPItem(this.#totp);
                if (item.locked) {
                    this.#level.value = 0;
                    this.#label.label = _('Unlock');
                    this.#label.use_markup = false;
                    return;
                }

                this.#totp.secret = await SecretUtils.getSecret(this.#totp);

                let [code, expiry] = this.#totp.code_and_expiry();
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
            this.destroy();
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
            let code = this.#totp.code();
            activateCopyToClipboard(this,
                                    code,
                                    _('OTP code copied to clipboard.'));
        }
        catch (e) {
            reportError(this.root, e);
        }
    }

};


class EditSecretButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #group;
    #settings;
    #totp;


    constructor({totp, group, settings})
    {
        super({
            icon_name: 'document-edit-symbolic',
            tooltip_text: _('Edit this secret.'),
            valign: Gtk.Align.CENTER
        });

        this.#group    = group;
        this.#settings = settings;
        this.#totp     = totp;
    }


    destroy()
    {
        this.#group    = null;
        this.#settings = null;
        this.#totp     = null;
    }


    async on_clicked()
    {
        try {
            this.#totp.secret = await SecretUtils.getSecret(this.#totp);

            const dialog = new SecretDialog({
                title: _('Editing TOTP secret'),
                totp: this.#totp,
                settings: this.#settings
            });

            const new_totp = await dialog.choose(this.root);
            if (!new_totp)
                return;

            await SecretUtils.updateTOTPItem(this.#totp, new_totp);
            await this.#group.refreshSecrets();
        }
        catch (e) {
            reportError(this.root, e);
        }
    }

};


class ExportSecretButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #totp;


    constructor(totp)
    {
        super({
            icon_name: 'send-to-symbolic',
            tooltip_text: _('Export this secret to clipboard.'),
            valign: Gtk.Align.CENTER
        });

        this.#totp = totp;
    }


    async on_clicked()
    {
        try {
            this.#totp.secret = await SecretUtils.getSecret(this.#totp);
            let uri = this.#totp.uri();
            activateCopyToClipboard(this,
                                    uri,
                                    _('Copied secret URI to clipboard.'));
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

        let box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL
        });
        this.set_child(box);

        let pbuf = GdkPixbuf.Pixbuf.new_from_stream(img_stream, null);

        let img = new Gtk.Image({
            hexpand: true,
            vexpand: true,
            height_request: 400,
            width_request: 400,
        });
        img.set_from_pixbuf(pbuf);
        box.append(img);

        let button = new Gtk.Button({
            label: _('_Close'),
            use_underline: true
        });
        button.connect('clicked', () => this.close());
        box.append(button);
    }

};


class ExportQRButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #settings;
    #totp;


    constructor(totp, settings)
    {
        super({
            icon_name: 'qr-code-symbolic',
            tooltip_text: _('Export this secret as QR code.'),
            valign: Gtk.Align.CENTER
        });

        this.#settings = settings;
        this.#totp = totp;
    }


    destroy()
    {
        this.#settings = null;
    }


    async on_clicked()
    {
        try {
            this.#totp.secret = await SecretUtils.getSecret(this.#totp);
            const uri = this.#totp.uri();

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

            let img_stream = Gio.MemoryInputStream.new_from_bytes(stdout);
            let export_window = new ExportQRWindow(this.root, img_stream);
            export_window.show();
        }
        catch (e) {
            reportError(this.root, e);
        }

    }

};


class RemoveSecretButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #totp;
    #group;


    constructor(totp, group)
    {
        super({
            icon_name: 'edit-delete-symbolic',
            tooltip_text: _('Remove this secret.'),
            valign: Gtk.Align.CENTER
        });

        this.#totp = totp;
        this.#group = group;
    }


    async on_clicked()
    {
        try {
            const cancel_response = 0;
            const delete_response = 1;
            const buttons = [_('_Cancel'), _('_Delete')];
            const label = makeLabel(this.#totp);
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
                const success = await SecretUtils.removeTOTPItem(this.#totp);
                if (!success)
                    throw new Error(_('Failed to remove secret. Is it locked?'));
                this.root?.add_toast(
                    new Adw.Toast({ title: _('Deleted secret:') + ` "${label}"` })
                );
                await this.#group.refreshSecrets();
            }
        }
        catch (e) {
            reportError(this.root, e);
        }
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


    on_clicked()
    {
        let display = Gdk.Display.get_default();
        let seat = display.get_default_seat();
        let kb = seat.get_keyboard();
        let modifier = kb.modifier_state;
        let shift_pressed = !!(modifier & Gdk.ModifierType.SHIFT_MASK);
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


    #children = [];
    #down_button;
    #totp;
    #up_button;


    constructor(totp, group, settings)
    {
        super({
            title: totp.issuer,
            title_lines: 1,
            subtitle: totp.name,
            subtitle_lines: 1,
        });

        this.#totp = totp;

        let box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            homogeneous: true
        });
        this.#children.push(box);
        this.add_prefix(box);

        this.#up_button = new MoveButton(group, this, -1);
        this.#down_button = new MoveButton(group, this, +1);
        box.append(this.#up_button);
        box.append(this.#down_button);

        // helper function
        let add_suffix = w => {
            this.add_suffix(w);
            this.#children.push(w);
        };

        add_suffix(new CopyCodeButton(totp));
        add_suffix(new EditSecretButton({totp, group, settings}));
        add_suffix(new ExportSecretButton(totp));
        add_suffix(new ExportQRButton(totp, settings));
        add_suffix(new RemoveSecretButton(totp, group));
    }


    destroy()
    {
        this.#up_button = null;
        this.#down_button = null;

        this.#children.forEach(w => {
            this.remove(w);
            if (w.destroy)
                w.destroy();
        });
        this.#children = null;
    }


    updateButtons()
    {
        this.#up_button.sensitive = !!this.get_prev_sibling();
        this.#down_button.sensitive = !!this.get_next_sibling();
    }


    // this is used to sort the rows
    get totp()
    {
        return this.#totp;
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

        hbox.append(new PasteQRButton(settings));
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
            let success = this.#locked
                ? await SecretUtils.unlockOTPCollection()
                : await SecretUtils.lockOTPCollection();
            await this.updateState();
        }
        catch (e) {
            logError(e);
        }
    }

};


class SecretsGroup extends Adw.PreferencesGroup {

    static {
        GObject.registerClass(this);

        this.install_action('totp.create', null,
                            obj => obj.createSecret());

        this.install_action('totp.refresh', null,
                            obj => obj.refreshSecrets(true));

        this.install_action('totp.import', null,
                            obj => obj.importSecrets());

        this.install_action('totp.export_all', null,
                            obj => obj.exportAllSecrets());
    }


    #listbox;
    #lock_button;
    #rows = [];
    #settings;


    constructor(application_id, settings)
    {
        super({
            title: _('Secrets'),
            description: _('A list of all TOTP secrets from the keyring.')
        });

        this.#settings = settings;

        this.#listbox = findListBox(this);
        this.#listbox.set_sort_func(this.rowSortFunc.bind(this));

        // UI tweak: relax the clamp so the group can grow wider.
        this.connect('notify::parent',
                     () => this.get_ancestor(Adw.Clamp)?.set_maximum_size(1000));

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
                action_name: 'totp.export_all',
                tooltip_text: _('Export all secrets to the clipboard.'),
                valign: Gtk.Align.CENTER,
            })
        );

        this.refreshSecrets();
    }


    destroy()
    {
        this.clearSecrets();
        this.#lock_button = null;
        this.#listbox     = null;
        this.#settings    = null;
    }


    clearSecrets()
    {
        this.#rows.forEach(row => {
            this.remove(row);
            row.destroy();
        });
        this.#rows = [];
    }


    async refreshSecrets(unlock = false)
    {
        this.clearSecrets();
        try {
            let items = await SecretUtils.getOTPItems(unlock);
            this.#lock_button.updateState();
            items.forEach(item =>
                {
                    let totp = new TOTP(item.get_attributes());
                    let row = new SecretRow(totp, this, this.#settings);
                    this.#rows.push(row);
                    this.add(row);
                });
            this.#rows.forEach(r => r.updateButtons());
        }
        catch (e) {
            logError(e, 'refreshSecrets()');
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
            await this.storeSecretsOrder(); // ensure the orders are 0, ..., n-1
            await SecretUtils.createTOTPItem(totp, n);
            this.root?.add_toast(new Adw.Toast({ title: _('Created new secret.') }));
            await this.refreshSecrets();
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
            await this.storeSecretsOrder(); // ensure the orders are 0, ..., n-1
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

            await this.refreshSecrets();

        }
        catch (e) {
            reportError(this.root, e, 'importSecrets()');
        }
    }


    async exportAllSecrets()
    {
        try {
            let uris = [];
            const items = await SecretUtils.getOTPItems();
            for (let i = 0; i < items.length; ++i) {
                let attrs = items[i].get_attributes();
                attrs.secret = await SecretUtils.getSecret(attrs);
                let totp = new TOTP(attrs);
                uris.push(totp.uri());
            }
            activateCopyToClipboard(this,
                                    uris.join('\n'),
                                    _('Copied all OTP secrets to clipboard.'));
        }
        catch (e) {
            reportError(this.root, e, 'exportAllSecrets()');
        }
    }


    // Store the UI order in the keyring as their labels
    async storeSecretsOrder()
    {
        try {
            for (let i = 0; i < this.#rows.length; ++i) {
                const totp = this.#rows[i].totp;
                await SecretUtils.updateTOTPOrder(totp, i);
            }
        }
        catch (e) {
            logError(e, 'storeSecretsOrder()');
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
        } else {
            this.#rows.splice(i, 1);
            if (offset < 0) {
                // move all the way to the front
                this.#rows.unshift(row);
            } else {
                // move all the way to the back
                this.#rows.push(row);
            }
        }

        this.#listbox?.invalidate_sort();
        this.#rows.forEach(r => r.updateButtons());
        this.storeSecretsOrder();
    }


    rowSortFunc(rowI, rowJ)
    {
        const i = this.#rows.indexOf(rowI);
        const j = this.#rows.indexOf(rowJ);
        return i - j;
    }

};


class CmdSettingRow extends EntryRow {

    static {
        GObject.registerClass(this);

        this.install_action('reset-setting', null, obj => obj.resetSetting());
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


    resetSetting()
    {
        this.#settings.reset(this.#key);
    }

};


class OptionsGroup extends Adw.PreferencesGroup {

    static {
        GObject.registerClass(this);

        this.install_action('totp.reset-setting',
                            's',
                            (obj, name, arg) => obj.resetQREncodeCMD(arg.unpack()));
    }


    constructor(settings)
    {
        super({
            title: _('Options')
        });

        this.add(new CmdSettingRow({
            settings: settings,
            key: 'qrencode-cmd',
            title: _('QR generator'),
            tooltip_text: _('This command must read text from standard input, and write an image to the standard output.')
        }));

        this.add(new CmdSettingRow({
            settings: settings,
            key: 'qrimage-cmd',
            title: _('QR reader'),
            tooltip_text: _('This command must read an image from the standard input, and print the decoded URI to the standard output.')
        }));

        this.add(new CmdSettingRow({
            settings: settings,
            key: 'qrscan-cmd',
            title: _('QR scanner'),
            tooltip_text: _('This command must capture an image from a camera, and print the decoded URI to the standard output.')
        }));

    }

}


class TOTPPreferencesPage extends Adw.PreferencesPage {

    static {
        GObject.registerClass(this);

        this.install_action('copy-to-clipboard',
                            '(ss)',
                            (obj, name, args) =>
                                obj.copyToClipboard(...args.recursiveUnpack()));
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


    copyToClipboard(text, title)
    {
        // this runs outside gnome-shell, so we use GDK
        let display = Gdk.Display.get_default();
        let clipboard1 = display.get_primary_clipboard();
        let clipboard2 = display.get_clipboard();
        clipboard1.set(text);
        clipboard2.set(text);

        if (!title)
            return;

        this.root?.add_toast(new Adw.Toast({ title: title }));
    }

};


class ExtensionPreferences {

    get path()
    {
        return Me.path;
    }


    getSettings()
    {
        return ExtensionUtils.getSettings();
    }

};


class TOTPPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window)
    {
        let app = window.get_application();
        let app_id = app?.application_id ?? 'org.gnome.Extensions';

        let page = new TOTPPreferencesPage(this.path,
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


function fillPreferencesWindow(window)
{
    return new TOTPPreferences().fillPreferencesWindow(window);
}


function init(metadata)
{
    ExtensionUtils.initTranslations();
}
