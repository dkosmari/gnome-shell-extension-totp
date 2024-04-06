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
    Gtk,
    Notify
} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Base32        = Me.imports.base32;
const MyEntryRow    = Me.imports.myEntryRow.EntryRow;
const MyAlertDialog = Me.imports.myAlertDialog.AlertDialog;
const SecretUtils   = Me.imports.secretUtils;
const TOTP          = Me.imports.totp.TOTP;


const {
    gettext,
    pgettext
} = ExtensionUtils;
const _ = gettext;


const AlertDialog = Gtk.AlertDialog ?? MyAlertDialog;
Gio._promisify(AlertDialog.prototype, 'choose', 'choose_finish');

const EntryRow = Adw.EntryRow ?? MyEntryRow;


function copyToClipboard(text,
                         title = null,
                         show_text = false)
{
    // this runs outside gnome-shell, so we use GDK
    let display = Gdk.Display.get_default();
    let clipboard1 = display.get_primary_clipboard();
    let clipboard2 = display.get_clipboard();
    clipboard1.set(text);
    clipboard2.set(text);

    if (title) {
        try {
            if (Notify.is_initted()) {
                let note = new Notify.Notification({
                    summary: title,
                    body: show_text ? text : null,
                    icon_name: 'changes-prevent-symbolic'
                });
                note.show();
                GLib.timeout_add(GLib.PRIORITY_LOW,
                                 8000,
                                 () =>
                                 {
                                     note.close();
                                     return GLib.SOURCE_REMOVE;
                                 });
            }
        }
        catch (e) {
            logError(e, 'copyToClipboard()');
        }
    }
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


class SecretDialog extends Gtk.Dialog {

    static {
        GObject.registerClass(this);
    }


    #confirm_cb;
    #cancel_cb;
    #ui = {};


    constructor(parent,
                title,
                totp,
                confirm,
                cancel)
    {
        let fields = totp.fields_non_destructive();

        super({
            transient_for: parent,
            modal: true,
            title: title,
            default_width: 500,
            // WORKAROUND: need header bar, otherwise the dialog is not centered
            use_header_bar: true
        });

        this.#confirm_cb = confirm;
        this.#cancel_cb = cancel;

        let group = new Adw.PreferencesGroup({
            title: title,
            margin_bottom: 12,
            margin_top: 12,
            margin_start: 12,
            margin_end: 12
        });
        this.get_content_area().append(group);

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
            tooltip_text: _("The shared secret key.")
        });
        this.#ui.secret_type = new Gtk.DropDown({
            model: makeStringList('Base32', 'Base64'),
            selected: 0,
            tooltip_text: _('How the secret key is encoded.')
        });
        this.#ui.secret.add_suffix(this.#ui.secret_type);
        group.add(this.#ui.secret);

        // UI: digits
        const digits_list = ['5', '6', '7', '8'];
        this.#ui.digits = new Adw.ComboRow({
            title: _('Digits'),
            title_lines: 1,
            model: makeStringList(...digits_list),
            selected: digits_list.indexOf(fields.digits),
            tooltip_text: _('How many digits in the code.')
        });
        group.add(this.#ui.digits);

        // UI: period
        let period_list = ['15', '30', '60'];
        this.#ui.period = new Adw.ComboRow({
            title: _('Period'),
            title_lines: 1,
            subtitle: _('Time between code updates, in seconds.'),
            subtitle_lines: 1,
            model: makeStringList(...period_list),
            selected: period_list.indexOf(fields.period)
        });
        group.add(this.#ui.period);

        // UI: algorithm
        let algorithm_list = ['SHA-1', 'SHA-256', 'SHA-512'];
        this.#ui.algorithm = new Adw.ComboRow({
            title: _('Algorithm'),
            title_lines: 1,
            model: makeStringList(...algorithm_list),
            selected: algorithm_list.indexOf(fields.algorithm),
            tooltip_text: _('The hash algorithm used to generate codes.')
        });
        group.add(this.#ui.algorithm);


        // UI: confirm/cancel buttons
        this.add_button(_('_Cancel'), Gtk.ResponseType.CANCEL);

        let ok_button = this.add_button(_('_OK'), Gtk.ResponseType.OK);
        ok_button.add_css_class('suggested-action');
        this.set_default_widget(ok_button);
    }


    on_response(response_id)
    {
        if (response_id == Gtk.ResponseType.OK) {
            this.#confirm_cb(this.getTOTP());
        } else {
            if (this.#cancel_cb)
                this.#cancel_cb();
        }
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
        this.#level.add_offset_value("full", this.#totp.period);
        this.#level.add_offset_value("high", 10);
        this.#level.add_offset_value("low", 5);

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
            copyToClipboard(code,
                            _('OTP code copied to clipboard.'),
                            true);
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


    #totp;
    #group;


    constructor(totp, group)
    {
        super({
            icon_name: 'document-edit-symbolic',
            tooltip_text: _('Edit this secret.'),
            valign: Gtk.Align.CENTER
        });

        this.#totp = totp;
        this.#group = group;
    }


    async on_clicked()
    {
        try {
            this.#totp.secret = await SecretUtils.getSecret(this.#totp);

            let dialog = new SecretDialog(
                this.root,
                _('Editing TOTP secret'),
                this.#totp,
                async (new_totp) => {
                    try {
                        await SecretUtils.updateTOTPItem(this.#totp, new_totp);
                        dialog.destroy();
                        await this.#group.refreshSecrets();
                    }
                    catch (e) {
                        reportError(dialog, e);
                    }
                },
                () => dialog.destroy()
            );
            dialog.present();
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
            copyToClipboard(uri,
                            _('Copied secret URI to clipboard.'),
                            true);
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
            label: _("_Close"),
            use_underline: true
        });
        button.connect('clicked', () => this.destroy());
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

            let proc = Gio.Subprocess.new(args,
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

            let dialog = new AlertDialog({
                message: _('Deleting TOTP secret'),
                detail: pgettext('Deleting: "SECRET"', 'Deleting:')
                    + ` "${makeLabel(this.#totp)}"`,
                modal: true,
                default_button: delete_response,
                cancel_button: cancel_response,
                buttons: buttons
            });

            let response = await dialog.choose(this.root, null);
            if (response == delete_response) {
                let success = await SecretUtils.removeTOTPItem(this.#totp);
                if (!success)
                    throw new Error(_('Failed to remove secret. Is it locked?'));
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
            use_markup: true,
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
        add_suffix(new EditSecretButton(totp, group));
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


class ImportURIsWindow extends Gtk.Window {

    static {
        GObject.registerClass(this);

        this.install_action('import.cancel', null,
                            obj => obj.responseCancel());

        this.install_action('import.import', null,
                            obj => obj.responseImport());
    }


    #buffer;
    #response_handler;


    constructor(parent)
    {
        super({
            transient_for: parent,
            modal: true,
            title: _('Importing "otpauth://" URIs'),
            default_width: 600,
            default_height: 400,
            deletable: false,
            titlebar: new Gtk.HeaderBar()
        });
        this.add_css_class('import-uris');

        let vbox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6
        });
        this.set_child(vbox);

        let heading = new Gtk.Label({
            label: _('Paste all "otpauth://" URIs you want to import, one per line.')
        });
        vbox.append(heading);

        this.#buffer = new Gtk.TextBuffer();

        let scroll = new Gtk.ScrolledWindow({
            vexpand: true,
            hexpand: true,
            child: new Gtk.TextView({
                monospace: true,
                buffer: this.#buffer
            })
        });
        vbox.append(scroll);

        let cancel_button = new Gtk.Button({
            label: _('_Cancel'),
            use_underline: true,
            action_name: 'import.cancel'
        });
        this.titlebar.pack_start(cancel_button);

        let import_button = new Gtk.Button({
            label: _('_Import'),
            use_underline: true,
            action_name: 'import.import'
        });
        import_button.add_css_class('suggested-action');
        this.titlebar.pack_end(import_button);
    }


    choose(handler)
    {
        this.#response_handler = handler;
        this.present();
    }


    responseCancel()
    {
        if (this.#response_handler)
            this.#response_handler('cancel', null);
        this.close();
    }


    responseImport()
    {
        if (this.#response_handler)
            this.#response_handler('import', this.#buffer.text);
        this.close();
    }

};


class SecretsGroup extends Adw.PreferencesGroup {

    static {
        GObject.registerClass(this);

        this.install_action('totp.create', null,
                            obj => obj.createSecret());

        this.install_action('totp.refresh', null,
                            obj => obj.refreshSecrets());

        this.install_action('totp.import', null,
                            obj => obj.importSecrets());

        this.install_action('totp.export_all', null,
                            obj => obj.exportAllSecrets());
    }


    #initialized_notify = false;
    #listbox;
    #rows = [];
    #settings;
    #update_source = 0;


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
        this.connect('notify::parent', () => this.get_ancestor(Adw.Clamp)?.set_maximum_size(1000));

        // Stuffs that needs cleanup later
        try {
            if (!Notify.is_initted())
                this.#initialized_notify = Notify.init(application_id);
        }
        catch (e) {
            logError(e, 'constructor()');
        }


        let box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6
        });
        this.set_header_suffix(box);

        box.append(
            new Gtk.Button({
                icon_name: 'document-new-symbolic',
                tooltip_text: _("Add secret..."),
                action_name: 'totp.create'
            })
        );

        box.append(
            new Gtk.Button({
                icon_name: 'view-refresh-symbolic',
                tooltip_text: _('Refresh secrets.'),
                action_name: 'totp.refresh',
            })
        );

        box.append(
            new Gtk.Button({
                icon_name: 'document-import-symbolic',
                action_name: 'totp.import',
                tooltip_text: _("Import secrets...")
            })
        );

        box.append(
            new Gtk.Button({
                icon_name: 'document-export-symbolic',
                action_name: 'totp.export_all',
                tooltip_text: _("Export all secrets to the clipboard.")
            })
        );

        this.refreshSecrets();
    }


    destroy()
    {
        this.clearSecrets();

        if (this.#initialized_notify) {
            Notify.uninit();
            this.#initialized_notify = false;
        }

        this.#listbox = null;

        this.#settings = null;
    }


    clearSecrets()
    {
        this.#rows.forEach(row => {
            this.remove(row);
            row.destroy();
        });
        this.#rows = [];
    }


    async refreshSecrets()
    {
        this.clearSecrets();
        try {
            let items = await SecretUtils.getOTPItems();
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


    createSecret()
    {
        let dialog = new SecretDialog(
            this.root,
            _('Creating new TOTP secret'),
            new TOTP(),
            async (totp) => {
                try {
                    const n = this.#rows.length;
                    await this.storeSecretsOrder(); // ensure the orders are 0, ..., n-1
                    await SecretUtils.createTOTPItem(totp, n);
                    dialog.destroy();
                    await this.refreshSecrets();
                }
                catch (e) {
                    reportError(dialog, e, 'createSecret()');
                }
            },
            () => dialog.destroy()
        );
        dialog.present();
    }


    async importSecrets()
    {
        try {
            let import_window = new ImportURIsWindow(this.root);
            import_window.choose(async (response, text) => {
                if (response == 'import') {
                    const n = this.#rows.length;
                    await this.storeSecretsOrder(); // ensure the orders are 0, ..., n-1
                    let uris = GLib.Uri.list_extract_uris(text);
                    try {
                        for (let i = 0; i < uris.length; ++i) {
                            let totp = new TOTP({uri: uris[i]});
                            await SecretUtils.createTOTPItem(totp, n + i);
                        }
                    }
                    catch (e) {
                        reportError(this.root, e, 'importSecrets()');
                    }
                    await this.refreshSecrets();
                }
            });
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
            copyToClipboard(uris.join('\n'),
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


class OptionsGroup extends Adw.PreferencesGroup {

    static {
        GObject.registerClass(this);

        this.install_action('totp.reset-qrencode-cmd', null,
                            obj => obj.resetQREncodeCMD());
    }


    #settings;


    constructor(settings)
    {
        super({
            title: _('Options')
        });

        this.#settings = settings;

        const qrencode_cmd_row = new EntryRow({
            title: _('QR generator'),
            tooltip_text: _('This command must read text from standard input, and write an image to the standard output.')
        });
        qrencode_cmd_row.add_css_class('qr-command-row');

        this.#settings.bind('qrencode-cmd',
                            qrencode_cmd_row, 'text',
                            Gio.SettingsBindFlags.DEFAULT);

        qrencode_cmd_row.add_suffix(new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: _('Revert option back to the default value.'),
            action_name: 'totp.reset-qrencode-cmd',
            valign: Gtk.Align.CENTER,

        }));

        this.add(qrencode_cmd_row);

    }


    destroy()
    {
        this.#settings = null;
    }


    resetQREncodeCMD()
    {
        this.#settings.reset('qrencode-cmd');
    }

}


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


function fillPreferencesWindow(window)
{
    const app = window.get_application();
    const app_id = app?.application_id || 'org.gnome.Extensions';

    const page = new TOTPPreferencesPage(Me.path,
                                         app_id,
                                         ExtensionUtils.getSettings());

    window.add(page);
    window.connect('close-request',
                   () => {
                       window.remove(page);
                       page.destroy();
                       return false;
                   });
}


function init(metadata)
{
    ExtensionUtils.initTranslations();
}
