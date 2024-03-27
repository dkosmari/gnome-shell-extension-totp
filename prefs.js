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
import Notify    from 'gi://Notify';

import {
    ExtensionPreferences,
    gettext as _,
    pgettext
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Base32 from './src/base32.js';
import * as SecretUtils from './src/secretUtils.js';
import TOTP from './src/totp.js';


Gio._promisify(Adw.MessageDialog.prototype, 'choose', 'choose_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_async');


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
        this.#ui.issuer = new Adw.EntryRow({
            title: _('Issuer'),
            text: fields.issuer,
            tooltip_text: _('The name of the organization (Google, Facebook, etc) that issued the OTP.')
        });
        group.add(this.#ui.issuer);

        // UI: name
        this.#ui.name = new Adw.EntryRow({
            title: _('Name'),
            text: fields.name
        });
        group.add(this.#ui.name);

        // UI: secret
        this.#ui.secret = new Adw.EntryRow({
            title: _('Secret'),
            text: fields.secret,
            tooltip_text: _("The shared secret key.")
        });
        this.#ui.secret_type = new Gtk.DropDown({
            model: new Gtk.StringList({
                strings: ['Base32', 'Base64']
            }),
            selected: 0,
            tooltip_text: _('How the secret key is encoded.')
        });
        this.#ui.secret.add_suffix(this.#ui.secret_type);
        group.add(this.#ui.secret);

        // UI: digits
        let digits_list = ['5', '6', '7', '8'];
        this.#ui.digits = new Adw.ComboRow({
            title: _('Digits'),
            model: new Gtk.StringList({
                strings: digits_list
            }),
            selected: digits_list.indexOf(fields.digits),
            tooltip_text: _('How many digits in the code.')
        });
        group.add(this.#ui.digits);

        // UI: period
        let period_list = ['15', '30', '60'];
        this.#ui.period = new Adw.ComboRow({
            title: _('Period'),
            subtitle: _('Time between code updates, in seconds.'),
            model: new Gtk.StringList({
                strings: period_list
            }),
            selected: period_list.indexOf(fields.period)
        });
        group.add(this.#ui.period);

        // UI: algorithm
        let algorithm_list = ['SHA-1', 'SHA-256', 'SHA-512'];
        this.#ui.algorithm = new Adw.ComboRow({
            title: _('Algorithm'),
            model: new Gtk.StringList({
                strings: algorithm_list
            }),
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
            min_value: 0.0,
            max_value: this.#totp.period,
            inverted: true,
            mode: Gtk.LevelBarMode.CONTINUOUS,
            orientation: Gtk.Orientation.VERTICAL
        });
        this.#level.add_css_class('totp-code-level');
        this.#level.add_offset_value("full", this.#totp.period);
        this.#level.add_offset_value("high", this.#totp.period - 5);
        this.#level.add_offset_value("low", 5);

        box.append(this.#level);

        this.#update_source = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                                               500,
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
            await reportError(this.root, e);
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
            tooltip_text: _('Export secret to clipboard.'),
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
            icon_name: 'qr-code-symbolic',
            tooltip_text: _('Export QR code.'),
            valign: Gtk.Align.CENTER
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
                this.#group.clearSecrets();
                let success = await SecretUtils.removeTOTPItem(this.#totp);
                if (!success)
                    throw new Error(_('Failed to remove secret. Is it locked?'));
                await this.#group.refreshSecrets();
            }
        }
        catch (e) {
            await reportError(this.root, e);
        }
    }

};


class UpButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #row;
    #group;


    constructor(group, row, enabled)
    {
        super({
            icon_name: "go-up-symbolic",
            sensitive: enabled
        });
        this.add_css_class('flat');
        this.add_css_class('totp-sort-button');
        this.#group = group;
        this.#row = row;
    }


    async on_clicked()
    {
        try {
            await this.#group.moveBy(this.#row, -1);
        }
        catch (e) {
            logError(e);
        }
    }

};


class DownButton extends Gtk.Button {

    static {
        GObject.registerClass(this);
    }


    #row;
    #group;


    constructor(group, row, enabled)
    {
        super({
            icon_name: "go-down-symbolic",
            sensitive: enabled
        });
        this.add_css_class('flat');
        this.add_css_class('totp-sort-button');
        this.#group = group;
        this.#row = row;
    }


    async on_clicked()
    {
        try {
            await this.#group.moveBy(this.#row, +1);
        }
        catch (e) {
            logError(e);
        }
    }

};


class SecretRow extends Adw.ActionRow {

    static {
        GObject.registerClass(this);
    }


    #children = [];
    #totp;


    constructor(totp, group, is_first, is_last)
    {
        super({
            title: totp.issuer,
            subtitle: totp.name,
            use_markup: true,
            title_lines: 1,
            subtitle_lines: 1
        });

        this.#totp = totp;

        let box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            homogeneous: true
        });
        this.#children.push(box);
        this.add_prefix(box);

        box.append(new UpButton(group, this, !is_first));
        box.append(new DownButton(group, this, !is_last));

        // helper function
        let add_suffix = w => {
            this.add_suffix(w);
            this.#children.push(w);
        };

        add_suffix(new CopyCodeButton(totp));
        add_suffix(new EditSecretButton(totp, group));
        add_suffix(new ExportSecretButton(totp));
        add_suffix(new ExportQRButton(totp));
        add_suffix(new RemoveSecretButton(totp, group));
    }


    destroy()
    {
        this.#children.forEach(w => {
            this.remove(w);
            if (w.destroy)
                w.destroy();
        });
        this.#children = null;
    }


    // this is used to sort the rows
    get totp()
    {
        return this.#totp;
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
    #rows = [];
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
                tooltip_text: _('Refresh secrets'),
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
                tooltip_text: _("Export secrets")
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
            items.forEach((item, idx) =>
                {
                    let totp = new TOTP(item.get_attributes());
                    let row = new SecretRow(totp,
                                            this,
                                            idx == 0,
                                            idx == items.length - 1);
                    this.#rows.push(row);
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
                    const n = this.#rows.length;
                    await this.sortSecrets(); // ensure the orders are 0, ..., n-1
                    await SecretUtils.createTOTPItem(totp, n);
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
                const n = this.#rows.length;
                await this.sortSecrets(); // ensure the orders are 0, ..., n-1
                let text = dialog.extra_child.child.buffer.text;
                let uris = GLib.Uri.list_extract_uris(text);
                for (let i = 0; i < uris.length; ++i) {
                    try {
                        let totp = new TOTP({uri: uris[i]});
                        await SecretUtils.createTOTPItem(totp, n + i);
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


    // Store the UI order in the keyring as their labels
    async sortSecrets()
    {
        try {
            for (let i = 0; i < this.#rows.length; ++i) {
                const totp = this.#rows[i].totp;
                await SecretUtils.updateTOTPOrder(totp, i);
            }
        }
        catch (e) {
            logError(e, 'sortSecrets()');
        }
    }


    async moveBy(row, offset)
    {
        const i = this.#rows.indexOf(row);
        if (i == -1)
            throw Error(`Trying to move a row that was not found: ${row}`);
        const j = i + offset;
        if (j < 0 || j >= this.#rows.length)
            return;
        // swap them
        [this.#rows[i], this.#rows[j]] = [this.#rows[j], this.#rows[i]];
        await this.sortSecrets();
        await this.refreshSecrets();
    }

};


class TOTPPreferencesPage extends Adw.PreferencesPage {

    static {
        GObject.registerClass(this);
    }


    #group;
    #resource;


    constructor(ext, application_id)
    {
        super();

        /*
         * Note: icons need to be loaded from gresource, not from filesystem, in order
         * to be theme-recolored.
         */
        this.#resource = Gio.Resource.load(`${ext.path}/icons.gresource`);
        Gio.resources_register(this.#resource);
        let theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const res_path = '/com/github/dkosmari/totp/icons';
        if (!theme.get_resource_path().includes(res_path))
            theme.add_resource_path(res_path);

        let provider = new Gtk.CssProvider();
        provider.load_from_path(`${ext.path}/prefs.css`);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(),
                                                  provider,
                                                  Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this.#group = new SecretsGroup(application_id);
        this.add(this.#group);
    }


    destroy()
    {
        Gio.resources_unregister(this.#resource);
        this.#resource = null;

        this.remove(this.#group);
        this.#group.destroy();
        this.#group = null;
    }

};


export default
class TOTPPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window)
    {
        let app = window.get_application();
        let app_id = app?.application_id || 'org.gnome.Extensions';
        let page = new TOTPPreferencesPage(this, app_id);
        window.add(page);
        window.connect('close-request',
                       () => {
                           window.remove(page);
                           page.destroy();
                           return false;
                       });
    }

};
