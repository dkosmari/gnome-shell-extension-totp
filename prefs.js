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

const Base32      = Me.imports.src.base32;
const SecretUtils = Me.imports.src.secretUtils;
const TOTP        = Me.imports.src.totp.TOTP;

const {
    gettext,
    pgettext
} = ExtensionUtils;
const _ = gettext;


Gio._promisify(Adw.MessageDialog.prototype, 'choose', 'choose_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_async');


function init(metadata)
{
    ExtensionUtils.initTranslations();
}


function makeVariant({issuer, name, secret, digits, period, algorithm})
{
    let Variant = GLib.Variant;
    return new Variant('a{sv}',
                       {
                           issuer: Variant.new_string(issuer),
                           name: Variant.new_string(name),
                           digits: Variant.new_double(digits),
                           period: Variant.new_double(period),
                           algorithm: Variant.new_string(algorithm)
                       });
}


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
    return `${issuer}: ${name}`;
}


function makeMarkupLabel({issuer, name})
{
    let safe_issuer = GLib.markup_escape_text(issuer, -1);
    let safe_name = GLib.markup_escape_text(name, -1);
    return `<b>${safe_issuer}:</b> ${safe_name}`;
}


async function reportError(parent, e, where = null)
{
    logError(e, where);
    try {
        let dialog = new Adw.MessageDialog({
            transient_for: parent,
            title: _('Error'),
            heading: where,
            body: _(e.message),
            modal: true,
        });
        dialog.add_response('close', _('_Close'));
        await dialog.choose(null);
        dialog.destroy();
    }
    catch (ee) {
        logError(ee, 'reportError()');
    }
}


function now()
{
    return new Date().getTime() / 1000;
}


class SecretDialog extends Gtk.Dialog {

    static {
        GObject.registerClass(this);
    }


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

        this._confirm_cb = confirm;
        this._cancel_cb = cancel;

        let group = new Adw.PreferencesGroup({
            title: title,
            margin_bottom: 12,
            margin_top: 12,
            margin_start: 12,
            margin_end: 12
        });
        this.get_content_area().append(group);

        this._ui = {};

        // UI: issuer
        this._ui.issuer = new Adw.EntryRow({
            title: _('Issuer'),
            text: fields.issuer,
            tooltip_text: _('The name of the organization (Google, Facebook, etc) that issued the OTP.')
        });
        group.add(this._ui.issuer);

        // UI: name
        this._ui.name = new Adw.EntryRow({
            title: _('Name'),
            text: fields.name
        });
        group.add(this._ui.name);

        // UI: secret
        this._ui.secret = new Adw.EntryRow({
            title: _('Secret'),
            text: fields.secret,
            tooltip_text: _("The shared secret key.")
        });
        this._ui.secret_type = new Gtk.DropDown({
            model: new Gtk.StringList({
                strings: ['Base32', 'Base64']
            }),
            selected: 0,
            tooltip_text: _('How the secret key is encoded.')
        });
        this._ui.secret.add_suffix(this._ui.secret_type);
        group.add(this._ui.secret);

        // UI: digits
        let digits_list = ['5', '6', '7', '8'];
        this._ui.digits = new Adw.ComboRow({
            title: _('Digits'),
            model: new Gtk.StringList({
                strings: digits_list
            }),
            selected: digits_list.indexOf(fields.digits),
            tooltip_text: _('How many digits in the code.')
        });
        group.add(this._ui.digits);

        // UI: period
        let period_list = ['15', '30', '60'];
        this._ui.period = new Adw.ComboRow({
            title: _('Period'),
            subtitle: _('Time between code updates, in seconds.'),
            model: new Gtk.StringList({
                strings: period_list
            }),
            selected: period_list.indexOf(fields.period)
        });
        group.add(this._ui.period);

        // UI: algorithm
        let algorithm_list = ['SHA-1', 'SHA-256', 'SHA-512'];
        this._ui.algorithm = new Adw.ComboRow({
            title: _('Algorithm'),
            model: new Gtk.StringList({
                strings: algorithm_list
            }),
            selected: algorithm_list.indexOf(fields.algorithm),
            tooltip_text: _('The hash algorithm used to generate codes.')
        });
        group.add(this._ui.algorithm);


        // UI: confirm/cancel buttons
        this.add_button(_('_Cancel'), Gtk.ResponseType.CANCEL);
        let ok_button = this.add_button(_('_OK'), Gtk.ResponseType.OK);
        this.set_default_widget(ok_button);
    }


    on_response(response_id)
    {
        if (response_id == Gtk.ResponseType.OK) {
            this._confirm_cb(this.getTOTP());
        } else {
            if (this._cancel_cb)
                this._cancel_cb();
        }
    }


    getTOTP()
    {
        let secret = this._ui.secret.text;
        if (this._ui.secret_type.selected == 1) // base64 -> base32
            secret = Base32.encode(GLib.base64_decode(secret));

        return new TOTP({
            issuer: this._ui.issuer.text,
            name: this._ui.name.text,
            secret: secret,
            digits: parseInt(this._ui.digits.selected_item.string),
            period: parseInt(this._ui.period.selected_item.string),
            algorithm: this._ui.algorithm.selected_item.string
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
            tooltip_text: _('Copy code to clipboard.')
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
            min_value: 0.0,
            max_value: this.#totp.period,
            inverted: true,
            mode: Gtk.LevelBarMode.CONTINUOUS,
            orientation: Gtk.Orientation.VERTICAL
        });
        box.append(this.#level);

        this.#update_source = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                                               1000,
                                               async () => {
                                                   try {
                                                       await this.updateCode();
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


    on_unmap()
    {
        this.destroy();
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
        if (!this.#expiry == 0 || !this._code)
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
            await reportError(this.root, e);
        }
    }

};


class EditSecretButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #totp;
    #secrets_group;


    constructor(totp, secrets_group)
    {
        super({
            icon_name: 'document-edit-symbolic',
            tooltip_text: _('Edit this secret.')
        });

        this.#totp = totp;
        this.#secrets_group = secrets_group;
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
                        await this.#secrets_group.refreshSecrets();
                    }
                    catch (e) {
                        await reportError(dialog, e);
                    }
                },
                () => dialog.destroy()
            );
            dialog.present();
        }
        catch (e) {
            await reportError(this.root, e);
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
            tooltip_text: _('Export secret to clipboard.')
        });

        this.#totp = totp;
    }


    async on_clicked()
    {
        try {
            this.#totp.secret = await SecretUtils.getSecret(this.#totp);
            let uri = this.#totp.uri();
            copyToClipboard(uri,
                            _('Copied secret URI to clipboard'),
                            true);
        }
        catch (e) {
            await reportError(this.root, e);
        }

    }

};


class ExportQRButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #totp;


    constructor(totp)
    {
        super({
            icon_name: 'qrscanner-symbolic',
            tooltip_text: _('Export QR code.')
        });

        this.#totp = totp;
    }


    async on_clicked()
    {
        try {
            this.#totp.secret = await SecretUtils.getSecret(this.#totp);
            const uri = this.#totp.uri();

            let te = new TextEncoder();
            const uri_data = te.encode(uri);

            let qrencode_proc = Gio.Subprocess.new(['qrencode', '-s', '10', '-o', '-'],
                                                   Gio.SubprocessFlags.STDIN_PIPE |
                                                   Gio.SubprocessFlags.STDOUT_PIPE);
            let [stdout, stderr] = await qrencode_proc.communicate_async(uri_data, null);

            let img_stream = Gio.MemoryInputStream.new_from_bytes(stdout);
            let pbuf = GdkPixbuf.Pixbuf.new_from_stream(img_stream, null);
            let img = Gtk.Image.new_from_pixbuf(pbuf);
            img.vexpand = true;
            img.hexpand = true;
            img.set_size_request(400, 400);

            let dialog = new Adw.MessageDialog({
                transient_for: this.root,
                title: _('QR code'),
                modal: true,
                resizable: true,
                extra_child: img
            });
            dialog.add_response('close', _('_Close'));
            await dialog.choose(null);
        }
        catch (e) {
            await reportError(this.root, e);
        }

    }

};


class RemoveSecretButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #totp;
    #secrets_group;


    constructor(totp, secrets_group)
    {
        super({
            icon_name: 'edit-delete-symbolic',
            tooltip_text: _('Remove this secret.')
        });

        this.#totp = totp;
        this.#secrets_group = secrets_group;
    }


    async on_clicked()
    {
        try {
            let dialog = new Adw.MessageDialog({
                transient_for: this.root,
                heading: _('Deleting TOTP secret'),
                body: pgettext('Deleting: "SECRET"', 'Deleting:')
                    + ` "${makeMarkupLabel(this.#totp)}"`,
                body_use_markup: true,
                default_response: 'delete',
                close_response: 'cancel'
            });
            dialog.add_response('cancel', _('_Cancel'));
            dialog.add_response('delete', _('_Delete'));
            dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);

            let response = await dialog.choose(null);

            if (response == 'delete') {
                this.#secrets_group.clearSecrets();
                let success = await SecretUtils.removeTOTPItem(this.#totp);
                if (!success)
                    throw new Error(_('Failed to remove secret. Is it locked?'));
                await this.#secrets_group.refreshSecrets();
            }
        }
        catch (e) {
            await reportError(this.root, e);
        }
    }

};



class SecretRow extends Adw.ActionRow {

    static {
        GObject.registerClass(this);
    }


    #copy_code_button;


    constructor(totp, secrets_group)
    {
        super({
            title: makeMarkupLabel(totp),
            use_markup: true
        });

        this.#copy_code_button = new CopyCodeButton(totp);
        this.add_suffix(this.#copy_code_button);
        this.add_suffix(new EditSecretButton(totp, secrets_group));
        this.add_suffix(new ExportSecretButton(totp));
        this.add_suffix(new ExportQRButton(totp));
        this.add_suffix(new RemoveSecretButton(totp, secrets_group));

    }


    destroy()
    {
        this.remove(this.#copy_code_button);
        this.#copy_code_button?.destroy();
        this.#copy_code_button = null;
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


    #update_source = 0;


    constructor(application_id)
    {
        super({
            title: _('Secrets'),
            description: _('A list of all TOTP secrets from the keyring.')
        });

        // Stuffs that needs cleanup later
        try {
            if (!Notify.is_initted())
                this._initialized_notify = Notify.init(application_id);
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
                icon_name: 'list-add-symbolic',
                tooltip_text: _("Add secret..."),
                action_name: 'totp.create'
            })
        );

        box.append(
            new Gtk.Button({
                icon_name: 'view-refresh-symbolic',
                tooltip_text: _('Refresh secrets'),
                action_name: 'totp.refresh',
            })
        );

        box.append(
            new Gtk.Button({
                icon_name: 'document-revert-symbolic',
                action_name: 'totp.import',
                tooltip_text: _("Import secrets...")
            })
        );

        box.append(
            new Gtk.Button({
                icon_name: 'send-to-symbolic',
                action_name: 'totp.export_all',
                tooltip_text: _("Export secrets")
            })
        );

        this._rows = [];
        this.refreshSecrets();
    }


    destroy()
    {
        // log('SecretsGroup::destroy()');

        this.clearSecrets();

        if (this._initialized_notify)
            Notify.uninit();
    }


    clearSecrets()
    {
        this._rows.forEach(row => {
            this.remove(row);
            row.destroy();
        });
        this._rows = [];
    }


    async refreshSecrets()
    {
        this.clearSecrets();
        try {
            let items = await SecretUtils.getOTPItems();
            items.forEach(item =>
                {
                    let totp = new TOTP(item.get_attributes());
                    let row = new SecretRow(totp, this);
                    this._rows.push(row);
                    this.add(row);
                });
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
                    await SecretUtils.createTOTPItem(totp);
                    dialog.destroy();
                    await this.refreshSecrets();
                }
                catch (e) {
                    await reportError(dialog, e, 'createSecret()');
                }
            },
            () => dialog.destroy()
        );
        dialog.present();
    }


    async importSecrets()
    {
        try {
            let dialog = new Adw.MessageDialog({
                transient_for: this.root,
                heading: _('Importing "otpauth://" URIs'),
                body: _('Paste all "otpauth://" URIs you want to import, one per line.'),
                default_width: 500,
                resizable: true,
                default_response: 'import',
                close_response: 'cancel',
                extra_child: new Gtk.ScrolledWindow({
                    vexpand: true,
                    hexpand: true,
                    child: new Gtk.TextView({
                        monospace: true
                    })
                })
            });
            dialog.add_response('cancel', _('_Cancel'));
            dialog.add_response('import', _('_Import'));
            dialog.set_response_appearance('import', Adw.ResponseAppearance.SUGGESTED);

            let response = await dialog.choose(null);
            if (response == 'import') {
                let text = dialog.extra_child.child.buffer.text;
                let uris = GLib.Uri.list_extract_uris(text);
                for (let i = 0; i < uris.length; ++i) {
                    try {
                        let totp = new TOTP({uri: uris[i]});
                        await SecretUtils.createTOTPItem(totp);
                    }
                    catch (e) {
                        await reportError(dialog, e, 'importSecrets()');
                    }
                }
                await this.refreshSecrets();
            }
        }
        catch (e) {
            await reportError(this.root, e, 'importSecrets()');
        }
    }


    async exportAllSecrets()
    {
        try {
            let uris = [];
            let items = await SecretUtils.getOTPItems();
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
            await reportError(this.root, e, 'exportAllSecrets()');
        }
    }

};


class TOTPPreferencesPage extends Adw.PreferencesPage {

    static {
        GObject.registerClass(this);
    }


    #secrets;


    constructor(ext, application_id)
    {
        super();

        const path = `${ext.path}/icons`;
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        if (!theme.get_search_path().includes(path))
            theme.add_search_path(path);

        this.#secrets = new SecretsGroup(application_id);
        this.add(this.#secrets);
    }


    destroy()
    {
        // log('TOTPPreferencesPage::destroy()');
        this.remove(this.#secrets);
        this.#secrets.destroy();
        this.#secrets = null;
    }

};


function fillPreferencesWindow(window)
{
    let app = window.get_application();
    let app_id = app?.application_id || 'org.gnome.Extensions';
    let page = new TOTPPreferencesPage(Me, app_id);
    window.add(page);
    window.connect('close-request',
                   () => {
                       // log('window got close-request signal');
                       window.remove(page);
                       page.destroy();
                       return false;
                   });
}
